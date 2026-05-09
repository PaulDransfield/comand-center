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
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
