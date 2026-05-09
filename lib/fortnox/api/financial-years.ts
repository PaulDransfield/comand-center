// lib/fortnox/api/financial-years.ts
//
// Fetch the customer's Fortnox fiscal years (räkenskapsår). Required by
// the voucher fetcher because Fortnox's /vouchers endpoint refuses any
// date range that crosses a fiscal-year boundary — it returns:
//
//   HTTP 400 / code 2002363
//   "Fråndatumet ligger utanför aktuellt räkenskapsår"
//   ("from-date is outside the current fiscal year")
//
// Standard response shape:
//   {
//     "FinancialYears": [
//       { "Id": 7, "FromDate": "2026-01-01", "ToDate": "2026-12-31",
//         "AccountChartType": "BAS 2024" },
//       { "Id": 6, "FromDate": "2025-01-01", "ToDate": "2025-12-31", ... }
//     ]
//   }
//
// Most Swedish restaurants run a calendar fiscal year, but some (especially
// post-acquisition) carry a broken-year. Don't assume — always enumerate.

const FORTNOX_API = 'https://api.fortnox.se/3'

export interface FortnoxFinancialYear {
  /** Numeric fiscal-year id assigned by Fortnox. Used by some endpoints
   *  via `Fortnox-Financial-Year` header; we prefer the date-based header
   *  because it's more legible in logs. */
  Id:                 number
  /** YYYY-MM-DD inclusive — first day of the fiscal year. */
  FromDate:           string
  /** YYYY-MM-DD inclusive — last day of the fiscal year. */
  ToDate:             string
  AccountChartType?:  string
}

export interface FetchFinancialYearsResult {
  years: FortnoxFinancialYear[]
}

/**
 * Fetch all fiscal years on the customer's Fortnox account. No pagination —
 * a customer typically has 1-10 years on file.
 */
export async function fetchFinancialYears(accessToken: string): Promise<FetchFinancialYearsResult> {
  const res = await fetch(`${FORTNOX_API}/financialyears`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept':        'application/json',
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Fortnox /financialyears failed: HTTP ${res.status} — ${text.slice(0, 200)}`)
  }
  const body: any = await res.json()
  const list: FortnoxFinancialYear[] = Array.isArray(body?.FinancialYears) ? body.FinancialYears : []
  // Sort newest first so callers can take the most-recent N if they want.
  list.sort((a, b) => (b.FromDate ?? '').localeCompare(a.FromDate ?? ''))
  return { years: list }
}

/**
 * Given a requested [fromDate, toDate] range, return the subset of fiscal
 * years that intersect with it, with each year clamped to the requested
 * range. The caller iterates this list and issues one /vouchers call per
 * entry.
 */
export function clampRangeToFiscalYears(
  fromDate: string,
  toDate: string,
  years: FortnoxFinancialYear[],
): Array<{ year: FortnoxFinancialYear; fromDate: string; toDate: string }> {
  const out: Array<{ year: FortnoxFinancialYear; fromDate: string; toDate: string }> = []
  for (const y of years) {
    // Skip years that don't overlap the requested range at all.
    if (y.ToDate < fromDate) continue
    if (y.FromDate > toDate) continue
    const clampedFrom = y.FromDate > fromDate ? y.FromDate : fromDate
    const clampedTo   = y.ToDate   < toDate   ? y.ToDate   : toDate
    out.push({ year: y, fromDate: clampedFrom, toDate: clampedTo })
  }
  // Chronological order so progress feedback flows oldest→newest.
  out.sort((a, b) => a.fromDate.localeCompare(b.fromDate))
  return out
}
