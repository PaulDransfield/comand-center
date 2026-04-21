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

/** Format a number as Swedish-style kroner:  "12 225 kr"  (space grouping). */
export function fmtKr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const abs = Math.abs(Math.round(n))
  const grouped = abs.toLocaleString('en-GB').replace(/,/g, ' ')
  return (n < 0 ? '−' : '') + grouped + ' kr'
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
