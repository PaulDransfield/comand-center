// lib/fortnox/api/fetch.ts
//
// Shared Fortnox HTTP helper with 429 retry-with-backoff. Use this for
// every call to api.fortnox.se/3/* so a transient rate-limit blip doesn't
// surface as a hard error to the caller.
//
// Behaviour:
//   - Sends the customer's bearer token as Authorization header
//   - Optionally pins fiscal-year context via header pair (used by /vouchers)
//   - On HTTP 429, sleeps per Retry-After (or escalating defaults), retries
//     up to MAX_RETRIES total before giving up
//   - All other status codes (incl. 4xx auth errors) returned to caller
//
// Why this is a separate module from vouchers.ts: /supplierinvoices,
// /vouchers, /financialyears, /supplierinvoices/{N}, and any future
// endpoint all need the same retry behaviour. Centralising it means a
// single 429 fix doesn't have to be reimplemented per endpoint.

const MAX_RETRIES         = 4
const BACKOFF_DEFAULTS_MS = [2000, 4000, 8000, 16000]   // total ~30s worst case

// Per-token concurrency cap. Fortnox documents a 4 req/sec limit per access
// token; with 2 concurrent in-flight + retry-with-backoff we comfortably
// stay under the ceiling even when callers fan out via Promise.all.
//
// Scaling rationale: 20 customers × 5 parallel fan-out call sites was
// projecting ~100 simultaneous Fortnox requests at 06:00 master-sync,
// which would trip 429-cascade on every customer. With the cap each
// customer's calls queue locally; the helper still retries gracefully on
// any residual 429.
//
// Keyed on the first 16 chars of the token (sufficient to distinguish
// customers; never persisted, never logged). Module-level Map persists
// across calls within a single Vercel function instance.
const PER_TOKEN_CONCURRENCY = 2
const tokenInflight  = new Map<string, number>()
const tokenWaitQueue = new Map<string, Array<() => void>>()

async function acquireSlot(tokenKey: string): Promise<void> {
  const current = tokenInflight.get(tokenKey) ?? 0
  if (current < PER_TOKEN_CONCURRENCY) {
    tokenInflight.set(tokenKey, current + 1)
    return
  }
  await new Promise<void>(resolve => {
    const q = tokenWaitQueue.get(tokenKey) ?? []
    q.push(resolve)
    tokenWaitQueue.set(tokenKey, q)
  })
  tokenInflight.set(tokenKey, (tokenInflight.get(tokenKey) ?? 0) + 1)
}

function releaseSlot(tokenKey: string): void {
  const current = tokenInflight.get(tokenKey) ?? 1
  tokenInflight.set(tokenKey, Math.max(0, current - 1))
  const q = tokenWaitQueue.get(tokenKey)
  if (q && q.length > 0) {
    const next = q.shift()!
    if (q.length === 0) tokenWaitQueue.delete(tokenKey)
    next()
  }
}

export interface FortnoxFetchOpts {
  /** Pin to a specific fiscal-year via the Fortnox-Financial-Year header. */
  financialYearId?:   number
  /** Pin to a fiscal-year via any in-year date — Fortnox-Financial-Year-Date. */
  financialYearDate?: string
  /** Override the default Accept header (rare). */
  accept?:            string
}

/**
 * Fetch from api.fortnox.se with the customer's bearer token, retrying
 * automatically on HTTP 429 (rate limit). Returns the final Response —
 * caller is responsible for checking !ok and surfacing other errors.
 */
export async function fortnoxFetch(
  url: string,
  accessToken: string,
  opts: FortnoxFetchOpts = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
    'Accept':        opts.accept ?? 'application/json',
  }
  if (opts.financialYearId)   headers['Fortnox-Financial-Year']      = String(opts.financialYearId)
  if (opts.financialYearDate) headers['Fortnox-Financial-Year-Date'] = opts.financialYearDate

  // Per-token serialization — caps simultaneous in-flight requests per
  // customer to PER_TOKEN_CONCURRENCY. Acquire before fetch, release in
  // finally so a thrown error never leaves the slot held.
  const tokenKey = accessToken.slice(0, 16)
  await acquireSlot(tokenKey)
  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch(url, { headers })
      if (res.status !== 429) return res
      if (attempt === MAX_RETRIES) return res

      // Honor Retry-After (seconds or HTTP-date), else escalate via defaults
      const retryAfterRaw = res.headers.get('Retry-After')
      let waitMs = BACKOFF_DEFAULTS_MS[attempt]
      if (retryAfterRaw) {
        const asSeconds = Number(retryAfterRaw)
        if (Number.isFinite(asSeconds)) {
          waitMs = Math.max(waitMs, asSeconds * 1000)
        } else {
          const asDate = Date.parse(retryAfterRaw)
          if (Number.isFinite(asDate)) {
            waitMs = Math.max(waitMs, asDate - Date.now())
          }
        }
      }
      await sleep(waitMs)
    }
    // Defensive — loop returns or gives up before falling through.
    throw new Error('fortnoxFetch: retry loop exhausted unexpectedly')
  } finally {
    releaseSlot(tokenKey)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
