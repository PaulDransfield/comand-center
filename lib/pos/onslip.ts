// lib/pos/onslip.ts
//
// Onslip 360 POS adapter.
//
// Onslip markets itself as "first Swedish POS with an open API". Auth is Hawk
// (RFC-ish HMAC request signing — same family as OAuth 1.0 but stateless, and
// the secret never crosses the wire, not even encrypted).
//
//   Base URL (prod):    https://api.onslip360.com/v1/
//   Base URL (sandbox): https://test.onslip360.com/v1/
//   Realm prefix:       ~{realm} in path, e.g. ~example.com/orders/
//   Key identifier:     {user}+{token}@{realm}
//   Key:                Base64-encoded raw key from Onslip backoffice
//   Algorithm:          SHA-256 (fixed)
//   Pagination:         ?o=offset&c=count&s=sortField
//
// Credentials shape stored in integrations.credentials_enc (JSON):
//   { key_id: "user+token@realm", key: "base64...", realm: "example.com", env: "prod" | "sandbox" }

import { createHash, createHmac, randomBytes } from 'crypto'

// ── Types ────────────────────────────────────────────────────────────────────
export interface OnslipCreds {
  key_id: string
  key:    string
  realm:  string
  env?:   'prod' | 'sandbox'
}

export interface OnslipOrder {
  id:          number
  created:     string            // ISO timestamp
  total:       number            // SEK including VAT
  total_net?:  number            // ex-moms
  status:      string
  location?:   string
  payments?:   Array<{ type: string; amount: number }>
  [k: string]: any
}

// ── Hawk authentication ──────────────────────────────────────────────────────
// Hawk MAC over the normalized request. We never transmit the key itself.
// Reference: https://github.com/mozilla/hawk + Onslip "Authentication & Authorization" docs.

function hawkNormalise(opts: {
  ts:     number
  nonce:  string
  method: string
  uri:    string         // path + query only (e.g. "/v1/~realm/orders/?o=0&c=100")
  host:   string
  port:   number
  hash?:  string         // payload hash, optional (none for GET/DELETE)
  ext?:   string
}): string {
  return [
    'hawk.1.header',
    String(opts.ts),
    opts.nonce,
    opts.method.toUpperCase(),
    opts.uri,
    opts.host.toLowerCase(),
    String(opts.port),
    opts.hash ?? '',
    opts.ext  ?? '',
    '',                   // trailing newline per Hawk spec
  ].join('\n')
}

function hawkPayloadHash(contentType: string, payload: Buffer | string): string {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const ct   = (contentType.split(';')[0] || '').toLowerCase().trim()
  const base = `hawk.1.payload\n${ct}\n${body.toString('utf8')}\n`
  return createHash('sha256').update(base).digest('base64')
}

export function hawkHeader(
  method:  string,
  fullUrl: string,
  keyId:   string,
  key:     string,
  payload?: { contentType: string; body: Buffer | string },
): string {
  const u = new URL(fullUrl)
  const port = u.port ? parseInt(u.port) : (u.protocol === 'https:' ? 443 : 80)
  const ts    = Math.floor(Date.now() / 1000)
  const nonce = randomBytes(6).toString('base64').replace(/[+/=]/g, '').slice(0, 8)
  const hash  = payload ? hawkPayloadHash(payload.contentType, payload.body) : undefined

  const normalised = hawkNormalise({
    ts, nonce, method,
    uri:  u.pathname + u.search,
    host: u.hostname,
    port,
    hash,
  })

  // Hawk uses the base64-decoded key as HMAC material. Onslip docs say the
  // backoffice hands us a Base64-encoded key — feed the raw decoded bytes.
  const keyBuf = Buffer.from(key, 'base64')
  const mac    = createHmac('sha256', keyBuf).update(normalised).digest('base64')

  // Assemble header. Quoted values per RFC 7235 / Hawk spec.
  const parts = [
    `id="${keyId}"`,
    `ts="${ts}"`,
    `nonce="${nonce}"`,
    hash ? `hash="${hash}"` : null,
    `mac="${mac}"`,
  ].filter(Boolean)

  return `Hawk ${parts.join(', ')}`
}

// ── Request wrapper ──────────────────────────────────────────────────────────
function baseUrl(env: 'prod' | 'sandbox' = 'prod'): string {
  return env === 'sandbox'
    ? 'https://test.onslip360.com/v1'
    : 'https://api.onslip360.com/v1'
}

async function onslipFetch(creds: OnslipCreds, method: string, path: string, body?: any): Promise<any> {
  const env  = creds.env ?? 'prod'
  const url  = `${baseUrl(env)}/~${creds.realm}${path.startsWith('/') ? path : '/' + path}`

  const headers: Record<string, string> = {
    'Accept': 'application/json',
  }
  let payloadArg: { contentType: string; body: Buffer | string } | undefined
  let fetchBody: any

  if (body != null && method !== 'GET' && method !== 'DELETE') {
    const json = JSON.stringify(body)
    headers['Content-Type'] = 'application/json'
    payloadArg = { contentType: 'application/json', body: json }
    fetchBody  = json
  }

  headers['Authorization'] = hawkHeader(method, url, creds.key_id, creds.key, payloadArg)

  const res = await fetch(url, { method, headers, body: fetchBody })
  const text = await res.text()

  if (!res.ok) {
    throw new Error(`Onslip API ${res.status}: ${text.slice(0, 200)}`)
  }

  try { return text ? JSON.parse(text) : null } catch { return text }
}

// ── Public helpers ───────────────────────────────────────────────────────────

/**
 * Test an API key by hitting a low-cost endpoint. Returns { ok, users_count }
 * so the test-connection admin surface can show something meaningful.
 */
export async function testOnslipConnection(creds: OnslipCreds): Promise<{
  ok:           true
  users_count:  number
  realm:        string
  env:          string
}> {
  // /users is small and requires only read access. Throws if auth fails.
  const users = await onslipFetch(creds, 'GET', '/users/?c=1')
  return {
    ok:          true,
    users_count: Array.isArray(users) ? users.length : 0,
    realm:       creds.realm,
    env:         creds.env ?? 'prod',
  }
}

/**
 * Paginate through /orders between two ISO dates. Onslip exposes `created` on
 * orders; we filter client-side because the query syntax for field filters
 * isn't documented publicly — we rely on date-range server filters where
 * available and fall back to client filtering otherwise.
 */
export async function getOnslipOrders(
  creds:    OnslipCreds,
  fromDate: string,            // YYYY-MM-DD
  toDate:   string,            // YYYY-MM-DD
  pageSize: number = 500,
): Promise<OnslipOrder[]> {
  const all: OnslipOrder[] = []
  let offset = 0

  // Onslip accepts simple `since` / `until` query params on several endpoints;
  // field names vary by resource. We pass both optimistically and filter
  // client-side as a safety net.
  while (true) {
    const params = new URLSearchParams({
      o: String(offset),
      c: String(pageSize),
      s: 'created',
      since: fromDate + 'T00:00:00Z',
      until: toDate   + 'T23:59:59Z',
    })
    const page = await onslipFetch(creds, 'GET', `/orders/?${params}`)
    if (!Array.isArray(page) || page.length === 0) break

    // Client-side filter (defence in depth — in case server ignores since/until)
    for (const o of page) {
      const d = (o.created || '').slice(0, 10)
      if (d >= fromDate && d <= toDate) all.push(o)
    }

    if (page.length < pageSize) break
    offset += page.length

    // Hard safety cap — if server never paginates, stop at 50k rows.
    if (all.length >= 50_000) break
  }

  return all
}

/**
 * Aggregate orders into per-day revenue and cover counts. Matches the
 * revenue_logs shape we use for other POS providers.
 */
export function aggregateOnslipOrdersByDay(orders: OnslipOrder[]): Array<{
  date:     string
  revenue:  number           // gross SEK (including VAT — consistent with Inzii/PK treatment)
  covers:   number           // order count, proxy for guest count
  payments: Record<string, number>  // { card: 123, cash: 45, swish: 67, ... }
}> {
  const byDay = new Map<string, { revenue: number; covers: number; payments: Record<string, number> }>()

  for (const o of orders) {
    // Skip cancelled / voided orders; Onslip uses status codes — "complete" is success.
    if (o.status && !['complete', 'completed', 'paid'].includes(String(o.status).toLowerCase())) continue

    const date = (o.created || '').slice(0, 10)
    if (!date) continue

    const total = parseFloat(String(o.total ?? 0)) || 0
    if (total <= 0) continue

    const bucket = byDay.get(date) ?? { revenue: 0, covers: 0, payments: {} }
    bucket.revenue += total
    bucket.covers  += 1

    for (const p of o.payments ?? []) {
      const key = String(p.type ?? 'unknown').toLowerCase()
      bucket.payments[key] = (bucket.payments[key] ?? 0) + (parseFloat(String(p.amount ?? 0)) || 0)
    }
    byDay.set(date, bucket)
  }

  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }))
}

/**
 * End-to-end sync helper used by the sync engine. Returns the aggregated rows
 * ready for upsert into `revenue_logs` (provider='onslip').
 */
export async function syncOnslip(
  creds:    OnslipCreds,
  fromDate: string,
  toDate:   string,
): Promise<Array<{ revenue_date: string; revenue: number; covers: number; payments: any; provider: 'onslip' }>> {
  const orders = await getOnslipOrders(creds, fromDate, toDate)
  const daily  = aggregateOnslipOrdersByDay(orders)
  return daily.map(d => ({
    revenue_date: d.date,
    revenue:      d.revenue,
    covers:       d.covers,
    payments:     d.payments,
    provider:     'onslip' as const,
  }))
}
