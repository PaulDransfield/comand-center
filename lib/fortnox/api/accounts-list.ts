// lib/fortnox/api/accounts-list.ts
//
// List ALL accounts in a Fortnox fiscal year, with opening + current
// balances baked into each row. Replaces the previous per-account
// /3/accounts/{number} round-trip pattern for the balance-sheet flow:
//
//   Before:  N round-trips (~6 s for 30 accounts, parallel-5)
//            AND we only fetched accounts referenced in vouchers, so
//            a fixed-asset like 1220 with carry-over IB but no movement
//            in the period was silently dropped — its contra (1229
//            accumulated depreciation) appeared alone with a huge
//            negative balance, dragging the asset section negative.
//
//   After:   1 paginated list call (~500 ms typical) returns every
//            account the customer has, with BalanceBroughtForward AND
//            BalanceCarriedForward. Filter to 1xxx-2xxx for the balance
//            sheet. Cached 24 h.
//
// Endpoint: GET /3/accounts?financialyear={fyId}&limit=500&page=N
// Pagination shape:
//   { Accounts: [ ... ], MetaInformation: { '@TotalResources': N,
//     '@TotalPages': K, '@CurrentPage': i } }
//
// The list response includes balance fields for active accounts in the
// queried FY. Inactive (Active=false) accounts are excluded by Fortnox
// when ?showinactive isn't set — that's the default behaviour we want.

import { fetchFinancialYears, type FortnoxFinancialYear } from './financial-years'

const FORTNOX_API = 'https://api.fortnox.se/3'
const PAGE_SIZE   = 500
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export interface AccountListEntry {
  number:           number
  description:      string
  opening_balance:  number     // Ingående balans, BalanceBroughtForward
  current_balance:  number     // Utgående balans, BalanceCarriedForward
  active:           boolean
  cost_centre?:     string | null
  project?:         string | null
  vat_code?:        string | null
}

export interface AccountListResult {
  /** Keyed by account number — same shape as fetchBankAccountBalances
   *  for drop-in compatibility. */
  accounts:          Record<number, AccountListEntry>
  fiscal_year_id:    number
  fiscal_year_from:  string
  fiscal_year_to:    string
  fortnox_calls:     number    // pages fetched (0 if served from cache)
  total_accounts:    number
  duration_ms:       number
  from_cache:        boolean
}

/**
 * Fetch the FULL accounts list for the customer's current fiscal year
 * (or the fiscal year containing the optional `anchorDate`). Caches the
 * result per-business per-FY for 24 h in overhead_drilldown_cache.
 *
 * Soft-fails to an empty list if the token / Fortnox call fails — caller
 * can fall back to the voucher-derived approach.
 */
export async function fetchAccountsList(
  db:         any,
  orgId:      string,
  businessId: string,
  accessToken: string,
  opts?: { anchorDate?: string },
): Promise<AccountListResult> {
  const started = Date.now()
  const empty: AccountListResult = {
    accounts:         {},
    fiscal_year_id:   0,
    fiscal_year_from: '',
    fiscal_year_to:   '',
    fortnox_calls:    0,
    total_accounts:   0,
    duration_ms:      0,
    from_cache:       false,
  }

  // 1. Resolve target fiscal year.
  let years: FortnoxFinancialYear[]
  try {
    ({ years } = await fetchFinancialYears(accessToken))
  } catch {
    return { ...empty, duration_ms: Date.now() - started }
  }
  if (!years || years.length === 0) return { ...empty, duration_ms: Date.now() - started }

  const anchorIso = opts?.anchorDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.anchorDate)
    ? opts.anchorDate
    : new Date().toISOString().slice(0, 10)
  const targetYear = years.find(y => y.FromDate <= anchorIso && y.ToDate >= anchorIso) ?? years[0]
  const fyId = targetYear.Id

  // 2. Cache lookup.
  const cacheCategory = `__accounts_list_fy${fyId}__`
  const cacheKey = {
    business_id:  businessId,
    period_year:  fyId,
    period_month: 0,
    category:     cacheCategory,
  }
  try {
    const { data: cached } = await db
      .from('overhead_drilldown_cache')
      .select('payload, fetched_at')
      .eq('business_id',  cacheKey.business_id)
      .eq('period_year',  cacheKey.period_year)
      .eq('period_month', cacheKey.period_month)
      .eq('category',     cacheKey.category)
      .maybeSingle()
    if (cached?.fetched_at && (Date.now() - new Date(cached.fetched_at).getTime()) < CACHE_TTL_MS) {
      const p = cached.payload as AccountListResult
      if (p?.accounts) {
        return { ...p, from_cache: true, duration_ms: Date.now() - started }
      }
    }
  } catch { /* fall through to fresh fetch */ }

  // 3. Paginate /3/accounts?financialyear=fyId
  const accounts: Record<number, AccountListEntry> = {}
  let page = 1
  let calls = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let res
    try {
      res = await fetch(
        `${FORTNOX_API}/accounts?financialyear=${fyId}&limit=${PAGE_SIZE}&page=${page}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept':        'application/json',
          },
        },
      )
    } catch {
      // Network — bail with partial.
      break
    }
    calls++
    if (!res.ok) break
    const body: any = await res.json()
    const list = Array.isArray(body?.Accounts) ? body.Accounts : []
    for (const a of list) {
      const num = Number(a?.Number)
      if (!Number.isFinite(num)) continue
      const opening = Number(a?.BalanceBroughtForward ?? 0)
      const current = Number(a?.BalanceCarriedForward ?? 0)
      if (!Number.isFinite(opening) || !Number.isFinite(current)) continue
      accounts[num] = {
        number:          num,
        description:     String(a?.Description ?? ''),
        opening_balance: Math.round(opening),
        current_balance: Math.round(current),
        active:          a?.Active !== false,
        cost_centre:     a?.CostCenter ?? null,
        project:         a?.Project ?? null,
        vat_code:        a?.VATCode ?? null,
      }
    }
    const totalPages = Number(body?.MetaInformation?.['@TotalPages'] ?? 1)
    if (page >= totalPages || list.length < PAGE_SIZE) break
    page++
    if (page > 20) break  // safety: 10,000 accounts is absurd
  }

  const result: AccountListResult = {
    accounts,
    fiscal_year_id:   fyId,
    fiscal_year_from: targetYear.FromDate,
    fiscal_year_to:   targetYear.ToDate,
    fortnox_calls:    calls,
    total_accounts:   Object.keys(accounts).length,
    duration_ms:      Date.now() - started,
    from_cache:       false,
  }

  // 4. Persist to cache (best-effort).
  if (result.total_accounts > 0) {
    try {
      await db.from('overhead_drilldown_cache').upsert({
        business_id:  cacheKey.business_id,
        period_year:  cacheKey.period_year,
        period_month: cacheKey.period_month,
        category:     cacheKey.category,
        payload:      result,
        fetched_at:   new Date().toISOString(),
      }, { onConflict: 'business_id,period_year,period_month,category' })
    } catch { /* cache write best-effort */ }
  }

  return result
}
