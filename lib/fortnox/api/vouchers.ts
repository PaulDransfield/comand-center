// lib/fortnox/api/vouchers.ts
//
// Phase 1 minimal voucher fetcher. Used by scripts/verification-runner.ts to
// pull a date range of full vouchers (with rows) from a customer's Fortnox
// account so we can compare API-derived metrics against PDF-derived metrics
// without touching production data.
//
// This is throwaway harness code — production-quality fetcher with state
// tracking, resume, retry, and incremental cursoring is a Phase 2 problem.
// Keep this minimal. Don't reach for clever abstractions.
//
// Two API calls per voucher series-and-number:
//   1. GET /3/vouchers?fromdate=...&todate=...  → list with summary rows
//   2. GET /3/vouchers/{series}/{number}        → full voucher with VoucherRows
//
// The list endpoint returns paginated summary records; the per-voucher GET
// is the only way to retrieve the line-level data (account, debit, credit,
// transaction info) that a P&L computation needs. The existing inline code
// in `lib/sync/engine.ts:571` only calls (1) and stores `TransactionInformation`
// (a free-text field) as if it were a numeric amount — see the audit doc.
//
// Rate limiting: Fortnox's documented limit is 25 requests per 5 seconds per
// access token. We use a sliding-window throttle that waits if a 26th request
// would land inside the same 5-second window. No retry on 429 — the throttle
// should make 429s unreachable; if they occur we fail loudly.

import { decrypt } from '@/lib/integrations/encryption'
import { fetchFinancialYears, clampRangeToFiscalYears } from './financial-years'

// ── Types ────────────────────────────────────────────────────────────────────

export interface FortnoxVoucherSummary {
  Url:                     string
  VoucherSeries:           string
  VoucherNumber:           number
  Year:                    number
  TransactionDate:         string   // YYYY-MM-DD
  Description?:            string
  ReferenceNumber?:        string
  ReferenceType?:          string
  ApprovalState?:          number
}

export interface FortnoxVoucherRow {
  Account:                 number
  AccountDescription?:     string
  Credit:                  number
  Debit:                   number
  CostCenter?:             string
  Description?:            string
  Project?:                string
  Quantity?:               number
  Removed?:                boolean
  TransactionInformation?: string
}

export interface FortnoxVoucher {
  Url:                     string
  Comments?:               string
  CostCenter?:             string
  Description?:            string
  Project?:                string
  ReferenceNumber?:        string
  ReferenceType?:          string
  TransactionDate:         string
  VoucherRows:             FortnoxVoucherRow[]
  VoucherNumber:           number
  VoucherSeries:           string
  Year:                    number
}

export interface VoucherFetchOptions {
  /** Supabase client with service-role key. Pass in from caller —
   *  this module is environment-agnostic so it can run from API routes
   *  AND from tsx scripts. */
  db: any
  /** CommandCenter org id whose Fortnox token will be used. */
  orgId:       string
  /** Optional: scope to a specific business if org has multiple Fortnox connections. */
  businessId?: string
  /** YYYY-MM-DD. Inclusive. */
  fromDate:    string
  /** YYYY-MM-DD. Inclusive. */
  toDate:      string
  /** Optional: log progress to stdout each N requests. Default 25. */
  progressEvery?: number
}

export interface VoucherFetchResult {
  vouchers:        FortnoxVoucher[]
  /** How many list-page requests were issued. */
  listRequests:    number
  /** How many per-voucher detail GETs were issued. */
  detailRequests:  number
  /** Total wall-clock duration of the fetch in milliseconds. */
  durationMs:      number
  /** True if the access token was refreshed mid-fetch. */
  tokenRefreshed:  boolean
}

// ── Constants ────────────────────────────────────────────────────────────────

const FORTNOX_API   = 'https://api.fortnox.se/3'
const FORTNOX_TOKEN = 'https://apps.fortnox.se/oauth-v1/token'
const PAGE_SIZE     = 500       // Fortnox max
const RATE_WINDOW_MS = 5_000
const RATE_MAX      = 25        // 25 req per 5 sec
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000  // refresh if <5min to expiry

// ── Public entry point ───────────────────────────────────────────────────────

export async function fetchVouchersForRange(opts: VoucherFetchOptions): Promise<VoucherFetchResult> {
  const startedAt = Date.now()
  const db        = opts.db

  const integ = await loadIntegration(db, opts.orgId, opts.businessId)
  let creds   = await ensureFreshToken(db, integ)

  const throttle = new SlidingWindowThrottle(RATE_MAX, RATE_WINDOW_MS)
  let listRequests   = 0
  let detailRequests = 0
  let tokenRefreshed = false

  // ── Phase 0: enumerate fiscal years and clamp the requested range ─────────
  // Fortnox's /vouchers endpoint refuses any date range that crosses a
  // räkenskapsår boundary (HTTP 400, code 2002363). The fix is to do one
  // /vouchers call per fiscal year that overlaps the requested range, with
  // the Fortnox-Financial-Year-Date header pinning each call's context.
  await throttle.acquire()
  const { years: allYears } = await fetchFinancialYears(creds.access_token)
  if (allYears.length === 0) {
    throw new Error('Fortnox /financialyears returned no years — customer has no fiscal year configured')
  }
  const yearSlices = clampRangeToFiscalYears(opts.fromDate, opts.toDate, allYears)
  if (yearSlices.length === 0) {
    throw new Error(
      `Fortnox: requested range ${opts.fromDate}..${opts.toDate} does not overlap any fiscal year on file ` +
      `(years: ${allYears.map(y => `${y.FromDate}..${y.ToDate}`).join(', ')})`,
    )
  }

  // ── Phase 1: list vouchers per fiscal year, paginating each year ──────────
  // Pin the fiscal-year context per call. Fortnox accepts the year ID via
  // EITHER the `Fortnox-Financial-Year` header OR the `?financialyear=<id>`
  // query param — we send both as belt-and-braces because different
  // documented examples differ on which one is authoritative for /vouchers.
  // The previous attempt used `Fortnox-Financial-Year-Date` which the
  // /vouchers list endpoint ignores → it falls back to the *current* year
  // and rejects any from-date outside it (error code 2002363).
  // Track the source fiscal-year context for each summary so the detail
  // GET in Phase 2 can reuse the same year.
  const summaries: Array<FortnoxVoucherSummary & { __fyId: number; __fyDate: string }> = []
  for (const slice of yearSlices) {
    const fyId   = slice.year.Id
    const fyDate = slice.year.FromDate
    let page = 1
    while (true) {
      await throttle.acquire()
      const url =
        `${FORTNOX_API}/vouchers?fromdate=${slice.fromDate}&todate=${slice.toDate}` +
        `&financialyear=${fyId}&limit=${PAGE_SIZE}&page=${page}`
      const res = await authedFetch(url, creds.access_token, fyId, fyDate)
      listRequests++

      if (res.status === 401) {
        // Token expired mid-fetch. Refresh and retry once.
        creds = await ensureFreshToken(db, integ, /*force*/ true)
        tokenRefreshed = true
        const retry = await authedFetch(url, creds.access_token, fyId, fyDate)
        if (!retry.ok) throw new Error(`Fortnox /vouchers list failed after refresh: HTTP ${retry.status}`)
        const body = await retry.json()
        collectListPage(body, summaries, fyId, fyDate)
        if (isLastPage(body, page)) break
      } else if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Fortnox /vouchers list failed (year ${slice.year.FromDate}..${slice.year.ToDate}, id=${fyId}): HTTP ${res.status} — ${text.slice(0, 200)}`)
      } else {
        const body = await res.json()
        collectListPage(body, summaries, fyId, fyDate)
        if (isLastPage(body, page)) break
      }
      page++
      if (page > 1000) throw new Error('Fortnox /vouchers list pagination exceeded 1000 pages — aborting (likely runaway)')
    }
  }

  const progressEvery = opts.progressEvery ?? 25

  // ── Phase 2: fetch full voucher (with rows) for every summary ─────────────
  const vouchers: FortnoxVoucher[] = []
  for (const sum of summaries) {
    await throttle.acquire()
    // Refresh token if approaching expiry between detail calls.
    if (creds.expires_at - Date.now() < REFRESH_THRESHOLD_MS) {
      creds = await ensureFreshToken(db, integ, /*force*/ true)
      tokenRefreshed = true
    }
    // Detail GET also requires the fiscal-year context — vouchers are
    // scoped to a year, and asking for {series}/{number} without it
    // looks up in the *active* year and 404s for older entries.
    // Same belt-and-braces: query param + headers.
    const url =
      `${FORTNOX_API}/vouchers/${encodeURIComponent(sum.VoucherSeries)}/${sum.VoucherNumber}` +
      `?financialyear=${sum.__fyId}`
    const res = await authedFetch(url, creds.access_token, sum.__fyId, sum.__fyDate)
    detailRequests++
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Fortnox /vouchers/${sum.VoucherSeries}/${sum.VoucherNumber} failed: HTTP ${res.status} — ${text.slice(0, 200)}`)
    }
    const body = await res.json()
    const v = body?.Voucher as FortnoxVoucher
    if (!v) throw new Error(`Fortnox /vouchers/${sum.VoucherSeries}/${sum.VoucherNumber} returned no Voucher payload`)
    vouchers.push(v)

    if (detailRequests % progressEvery === 0) {
      process.stdout.write(`[fortnox-fetch] detail ${detailRequests}/${summaries.length} (${vouchers.length} captured)\n`)
    }
  }

  return {
    vouchers,
    listRequests,
    detailRequests,
    durationMs: Date.now() - startedAt,
    tokenRefreshed,
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

interface IntegrationRow {
  id:               string
  org_id:           string
  business_id:      string | null
  credentials_enc:  string
}

interface DecryptedCreds {
  access_token:  string
  refresh_token: string
  expires_at:    number   // ms epoch
  token_type?:   string
  scope?:        string
}

async function loadIntegration(db: any, orgId: string, businessId?: string): Promise<IntegrationRow> {
  let q = db
    .from('integrations')
    .select('id, org_id, business_id, credentials_enc')
    .eq('org_id', orgId)
    .eq('provider', 'fortnox')
    .eq('status', 'connected')

  if (businessId) q = q.eq('business_id', businessId)

  const { data, error } = await q.limit(1).maybeSingle()
  if (error) throw new Error(`Failed to load Fortnox integration: ${error.message}`)
  if (!data) throw new Error(`No connected Fortnox integration for org ${orgId}${businessId ? ` business ${businessId}` : ''}`)
  if (!data.credentials_enc) throw new Error('Fortnox integration row has no credentials')
  return data as IntegrationRow
}

async function ensureFreshToken(db: any, integ: IntegrationRow, force = false): Promise<DecryptedCreds> {
  const decrypted = decrypt(integ.credentials_enc) ?? '{}'
  const creds: DecryptedCreds = normaliseCreds(JSON.parse(decrypted))

  const stillValid = creds.expires_at - Date.now() > REFRESH_THRESHOLD_MS
  if (stillValid && !force) return creds

  if (!creds.refresh_token) {
    throw new Error('Fortnox token expired and no refresh_token available — customer must reconnect')
  }

  const clientId     = process.env.FORTNOX_CLIENT_ID
  const clientSecret = process.env.FORTNOX_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('FORTNOX_CLIENT_ID / FORTNOX_CLIENT_SECRET not set in env')
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const res = await fetch(FORTNOX_TOKEN, {
    method:  'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: creds.refresh_token }).toString(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Fortnox token refresh failed: HTTP ${res.status} — ${text.slice(0, 200)}`)
  }

  const tok: any = await res.json()
  const refreshed: DecryptedCreds = {
    access_token:  tok.access_token  ?? creds.access_token,
    refresh_token: tok.refresh_token ?? creds.refresh_token,
    expires_at:    Date.now() + (Number(tok.expires_in ?? 3600) * 1000),
    token_type:    tok.token_type    ?? creds.token_type,
    scope:         tok.scope         ?? creds.scope,
  }

  // Persist the refreshed token so the production paths (lib/sync/engine.ts,
  // app/api/integrations/fortnox/route.ts) see the same fresh token. Don't
  // strand the customer with the old one.
  const { encrypt } = await import('@/lib/integrations/encryption')
  await db.from('integrations')
    .update({
      credentials_enc:  encrypt(JSON.stringify(refreshed)),
      token_expires_at: new Date(refreshed.expires_at).toISOString(),
      status:           'connected',
      last_error:       null,
    })
    .eq('id', integ.id)

  return refreshed
}

/** Normalise both legacy and current credential shapes into a single struct. */
function normaliseCreds(raw: any): DecryptedCreds {
  // The two sync paths persist `expires_at` differently: lib/sync/engine.ts
  // stores it as a numeric ms-epoch; app/api/integrations/fortnox stores it
  // as an ISO string. Accept either.
  let expiresAt: number = 0
  if (typeof raw?.expires_at === 'number') expiresAt = raw.expires_at
  else if (typeof raw?.expires_at === 'string') expiresAt = Date.parse(raw.expires_at) || 0
  return {
    access_token:  String(raw?.access_token ?? ''),
    refresh_token: String(raw?.refresh_token ?? ''),
    expires_at:    expiresAt,
    token_type:    raw?.token_type,
    scope:         raw?.scope,
  }
}

/**
 * Fetch with the customer's bearer token. When `financialYearId` is set,
 * we send both `Fortnox-Financial-Year` (integer id) and
 * `Fortnox-Financial-Year-Date` (any date inside that year) headers —
 * Fortnox documentation differs across endpoints on which one wins for
 * /vouchers, so we send both. The query parameter `?financialyear=<id>`
 * is added at the call site as a third belt-and-braces layer.
 */
async function authedFetch(
  url: string,
  accessToken: string,
  financialYearId?: number,
  financialYearDate?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
    'Accept':        'application/json',
  }
  if (financialYearId)   headers['Fortnox-Financial-Year']      = String(financialYearId)
  if (financialYearDate) headers['Fortnox-Financial-Year-Date'] = financialYearDate
  return fetch(url, { headers })
}

/**
 * Append voucher summaries from a list-page body to the running array,
 * tagging each summary with the fiscal-year context that was used so the
 * later detail GET can reuse the same year.
 */
function collectListPage(
  body: any,
  into: Array<FortnoxVoucherSummary & { __fyId: number; __fyDate: string }>,
  fyId: number,
  fyDate: string,
): void {
  const list: FortnoxVoucherSummary[] = body?.Vouchers ?? []
  for (const v of list) into.push({ ...v, __fyId: fyId, __fyDate: fyDate })
}

/** Detect last page via Fortnox's `MetaInformation` envelope. */
function isLastPage(body: any, currentPage: number): boolean {
  const meta = body?.MetaInformation ?? {}
  const totalPages = Number(meta['@TotalPages'] ?? meta.TotalPages ?? 0)
  if (totalPages > 0) return currentPage >= totalPages
  // Defensive fallback: empty page = end.
  return !Array.isArray(body?.Vouchers) || body.Vouchers.length === 0
}

// ── Sliding-window throttle ──────────────────────────────────────────────────
// Tracks the timestamps of the last `max` requests. acquire() blocks until
// the oldest tracked timestamp is >windowMs in the past, guaranteeing we
// never issue more than `max` requests in any rolling `windowMs` window.

class SlidingWindowThrottle {
  private timestamps: number[] = []

  constructor(private max: number, private windowMs: number) {}

  async acquire(): Promise<void> {
    const now = Date.now()
    while (this.timestamps.length >= this.max) {
      const oldest = this.timestamps[0]
      const wait   = oldest + this.windowMs - now
      if (wait <= 0) {
        this.timestamps.shift()
      } else {
        await sleep(wait + 5)
        // Recompute now after sleep, then loop to drain expired entries.
        const t = Date.now()
        while (this.timestamps.length && this.timestamps[0] + this.windowMs <= t) {
          this.timestamps.shift()
        }
      }
    }
    this.timestamps.push(Date.now())
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
