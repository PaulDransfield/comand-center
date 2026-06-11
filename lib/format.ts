// lib/format.ts
//
// Single shared formatter for currency and percentages across the app.
// Every page used to declare its own inline `fmtKr` and `fmtPct`, which led
// to two families of bugs:
//   - Double "kr kr" suffixes, where one layer called fmtKr and another
//     appended " kr" manually in the template.
//   - Inconsistent thousands separators — some pages used US commas
//     (12,225), others used plain digits, instead of the Swedish space
//     style that DESIGN.md § Cross-cutting behaviour rules prescribes
//     (12 225 kr with a space before the unit).
//
// Always import from here. Never re-declare inline. If you need a different
// format (e.g. accounting parens for negatives) add a variant *here* rather
// than forking the helper in a page.

/**
 * Format a number as Swedish-style kroner:  "12 225 kr"  (space grouping).
 *
 * `currency` defaults to SEK ("kr"). Pass another ISO code for businesses
 * outside Sweden (NOK / DKK render as "kr" too; EUR renders as "€";
 * GBP "£"; USD "$"). Kept here so callers don't reintroduce inline
 * fmtKr variants that re-create the `kr kr` bug class.
 */
export function fmtKr(
  n: number | null | undefined,
  currency: string = 'SEK',
): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const abs = Math.abs(Math.round(n))
  const grouped = abs.toLocaleString('en-GB').replace(/,/g, ' ')
  const sign = n < 0 ? '−' : ''
  const cc = (currency || 'SEK').toUpperCase()
  switch (cc) {
    case 'EUR': return sign + '€' + grouped
    case 'USD': return sign + '$' + grouped
    case 'GBP': return sign + '£' + grouped
    case 'SEK':
    case 'NOK':
    case 'DKK':
    default:    return sign + grouped + ' kr'
  }
}

/**
 * Recipe-line cost formatter. Per-ingredient costs are routinely sub-1-kr
 * (10 g of beetroot at 0.055 kr/g = 0.055 kr) — rounding to integer kr
 * gives a misleading "0 kr" everywhere. This formatter keeps 2 decimals
 * for |n| < 10, integers above. NEVER use this on dashboard / P&L /
 * any aggregate surface — it implies precision the upstream rollups
 * don't carry.
 */
export function fmtKrCost(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const sign = n < 0 ? '−' : ''
  if (abs >= 10) {
    return sign + Math.round(abs).toLocaleString('en-GB').replace(/,/g, ' ') + ' kr'
  }
  // 2 decimals for the small-cost band, trim trailing zero (so "0.40 kr" -> "0.40 kr"
  // but "5.00 kr" -> "5 kr"). Keeps the chef's eye on the precision when it matters.
  const rounded = Math.round(abs * 100) / 100
  const txt = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)
  return sign + txt + ' kr'
}

/**
 * Same as `fmtKr` but prefixes `+` for non-negative values. Used on
 * cash-flow surfaces where direction (in/out) is the headline.
 */
export function fmtKrSigned(
  n: number | null | undefined,
  currency: string = 'SEK',
): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n >= 0) return '+' + fmtKr(n, currency)
  return fmtKr(n, currency)
}

/** Bare number with Swedish space grouping (no unit). Useful inside bars/tooltips. */
export function fmtNum(n: number | null | undefined, decimals = 0): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const v = decimals > 0 ? Math.round(n * 10 ** decimals) / 10 ** decimals : Math.round(n)
  return v.toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .replace(/,/g, ' ')
}

/** Percentage with one decimal:  "12.5%". */
export function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return (Math.round(n * 10) / 10).toFixed(1) + '%'
}

/** Hours with one decimal:  "12.5h". */
export function fmtHrs(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return (Math.round(n * 10) / 10) + 'h'
}

/**
 * Human elapsed time from a number of seconds: "45s", "12m", "1h 23m",
 * "2h". Used for stock-count duration (how long a count took to walk).
 * Drops the seconds part once we're past a minute — owners care about
 * "how much of someone's shift went into this", not stopwatch precision.
 */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const mins = Math.round(s / 60)
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}
