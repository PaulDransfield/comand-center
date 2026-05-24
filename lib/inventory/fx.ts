// lib/inventory/fx.ts
//
// SEK conversion for cost calc. Looks up the daily fx_rate at-or-before
// a given date. Falls back to the most recent available rate when no
// row exists for the requested date (weekends, holidays, before our
// backfill window).
//
// Build an FxIndex once per request, then ask `toSek(amount, currency,
// date, index)` cheaply per line.

export interface FxRateRow {
  rate_date:   string   // YYYY-MM-DD
  currency:    string
  rate_to_sek: number
}

export type FxIndex = Map<string, FxRateRow[]>  // currency → sorted rows DESC

// One-shot fetch of all rates for the currencies a business might use.
// Returns a Map<currency, FxRateRow[]> sorted by rate_date DESC so
// lookups can do a quick scan for the first row <= target date.
export async function loadFxIndex(
  db: any,
  currencies: string[],
): Promise<FxIndex> {
  const idx: FxIndex = new Map()
  const wanted = Array.from(new Set([...currencies, 'SEK'])).filter(Boolean)
  if (wanted.length === 0) return idx
  const { data } = await db
    .from('fx_rates')
    .select('rate_date, currency, rate_to_sek')
    .in('currency', wanted)
    .order('rate_date', { ascending: false })
    .limit(5000)    // up to ~3 years of daily rates for 6 currencies
  for (const r of (data ?? []) as FxRateRow[]) {
    const arr = idx.get(r.currency) ?? []
    arr.push(r)
    idx.set(r.currency, arr)
  }
  // SEK always 1.0 — guarantee the entry even if the system row hasn't seeded yet.
  if (!idx.has('SEK')) idx.set('SEK', [{ rate_date: '1970-01-01', currency: 'SEK', rate_to_sek: 1 }])
  return idx
}

// Get the SEK rate for a currency at or before targetDate.
// Returns null when we have no data at all for that currency
// (caller should leave price unchanged + flag for review).
export function getFxRate(
  currency: string | null | undefined,
  targetDate: string | null | undefined,
  index: FxIndex,
): number | null {
  if (!currency) return 1
  const c = currency.toUpperCase()
  if (c === 'SEK') return 1
  const rows = index.get(c)
  if (!rows || rows.length === 0) return null
  if (!targetDate) return rows[0].rate_to_sek   // newest as best-effort
  // rows are sorted DESC; first one whose rate_date <= target wins
  for (const r of rows) {
    if (r.rate_date <= targetDate) return r.rate_to_sek
  }
  // targetDate is older than every row we have — fall back to oldest available
  return rows[rows.length - 1].rate_to_sek
}

// Convert an amount in <currency> at <date> to SEK.
// Returns null when there's no FX rate at all (caller treats as
// "leave amount unchanged + warn").
export function toSek(
  amount: number,
  currency: string | null | undefined,
  date: string | null | undefined,
  index: FxIndex,
): number | null {
  const rate = getFxRate(currency, date, index)
  if (rate == null) return null
  return amount * rate
}
