// lib/forecast/intervals.ts
//
// A2.7 — confidence intervals for forecasted values.
//
// Strategy: derive intervals from the model's HISTORICAL ERROR (MAPE
// from daily_forecast_outcomes / ai_forecast_outcomes). The interval
// is the empirical band the model actually misses by, not a Gaussian
// SD around the mean. This is honest:
//   - If the model is consistently 12% off, owners should plan for
//     ±12% bands. That's what they'll actually see.
//   - We don't invent statistical assumptions that the underlying data
//     wouldn't support (e.g. that errors are normally distributed).
//
// API:
//   computeInterval(point, mape_pct, opts?) → Interval | null
//
// Honest-incomplete: returns null when mape_pct is missing, NaN, or
// negative — caller must handle the "no interval available yet" case
// rather than fall back to a fake ±0 band.

export interface Interval {
  /** Lower bound (predicted * (1 - mape/100)), clamped to 0. */
  low:             number
  /** Original point forecast. */
  point:           number
  /** Upper bound (predicted * (1 + mape/100)). */
  high:            number
  /** Half-width as % (the "±N%" number shown next to the value). */
  half_width_pct:  number
  /** Source label for tooltip: "based on last 6 months MAPE". */
  basis_label:     string
}

export function computeInterval(
  point:    number,
  mape_pct: number | null | undefined,
  opts?: {
    /** Optional label override; default "based on historical accuracy". */
    basis_label?: string
    /** Multiplier on MAPE for the band (default 1.0). 1.5 gives a wider
     *  band that catches ~75% of historical errors instead of 50%; useful
     *  for risk-aversive planning. */
    multiplier?:  number
    /** Floor on half-width pct so a 0% MAPE doesn't produce zero-width
     *  bands (which would mislead owners about the model being perfect).
     *  Default 0 — caller decides. */
    floor_pct?:   number
  },
): Interval | null {
  if (!Number.isFinite(point))    return null
  if (mape_pct == null)           return null
  const mape = Number(mape_pct)
  if (!Number.isFinite(mape) || mape < 0) return null

  const mult        = Number.isFinite(opts?.multiplier) ? Math.max(0.5, Math.min(3, Number(opts!.multiplier))) : 1
  const floor       = Number.isFinite(opts?.floor_pct) ? Math.max(0, Number(opts!.floor_pct))                  : 0
  const halfWidth   = Math.max(floor, mape * mult)
  const lowRaw      = point * (1 - halfWidth / 100)
  const highRaw     = point * (1 + halfWidth / 100)

  return {
    low:            Math.max(0, Math.round(lowRaw)),
    point:          Math.round(point),
    high:           Math.round(highRaw),
    half_width_pct: Math.round(halfWidth * 10) / 10,
    basis_label:    opts?.basis_label ?? 'based on historical accuracy',
  }
}

/**
 * Format an interval as the dense "47k ±12%" string used on cards.
 * Use formatIntervalLong() when you have the room for the explicit range.
 */
export function formatIntervalShort(iv: Interval | null, fmtNumber: (n: number) => string): string {
  if (!iv) return '—'
  return `${fmtNumber(iv.point)} ±${iv.half_width_pct.toFixed(0)}%`
}

/**
 * Format an interval as the explicit range "41–53k SEK" used on tooltips.
 */
export function formatIntervalLong(iv: Interval | null, fmtNumber: (n: number) => string): string {
  if (!iv) return '—'
  return `${fmtNumber(iv.low)} – ${fmtNumber(iv.high)}`
}
