// lib/forecast/recency.ts
//
// Shared recency-weighted statistics for revenue forecasting. Used by both
// `/api/scheduling/ai-suggestion` (chart's AI forecast line) and
// `/api/weather/demand-forecast` (DemandOutlook day cards).
//
// Pre-2026-05-08 both forecasters used flat 12-week rolling averages,
// which lagged 2-4 weeks behind any sustained trend (e.g. post-holiday
// dip, school break, sustained weather change). This module fixes that
// without breaking the deterministic-math discipline:
//
//   - Recency weighting:        last 4 weeks count 2× weeks 5-12.
//   - This-week pull-forward:   if completed days in the current week
//                               run materially above/below their model
//                               prediction, scale remaining-day forecasts
//                               by the same ratio (clamped 0.75-1.25).
//
// Both knobs are derivable from existing daily_metrics — no new schema,
// no LLM calls. The math is intentionally simple so it's debuggable from
// the database alone.
//
// Memory: feedback_forecast_recency_weighting.md.

/**
 * Recency-weighted average of `values`, where `dates` are the same length
 * and provide each value's calendar date. Values whose date falls within
 * `recentWindowDays` of `referenceDate` get `recencyMultiplier`× weight.
 *
 * Defaults: last 28 days × 2.0; older entries × 1.0.
 *
 * Returns 0 when there are no values (caller decides how to handle).
 */
export function weightedAvg(
  values:             number[],
  dates:              string[],
  referenceDate:      Date,
  opts: { recentWindowDays?: number; recencyMultiplier?: number } = {},
): number {
  if (values.length === 0) return 0
  if (values.length !== dates.length) {
    throw new Error('weightedAvg: values.length !== dates.length')
  }
  const windowDays  = opts.recentWindowDays  ?? 28
  const recentMul   = opts.recencyMultiplier ?? 2.0
  const refMs       = referenceDate.getTime()
  const cutoffMs    = refMs - windowDays * 86_400_000

  let sumWeighted = 0
  let sumWeights  = 0
  for (let i = 0; i < values.length; i++) {
    const dMs    = new Date(dates[i] + 'T12:00:00Z').getTime()
    const weight = dMs >= cutoffMs ? recentMul : 1
    sumWeighted += values[i] * weight
    sumWeights  += weight
  }
  return sumWeights > 0 ? sumWeighted / sumWeights : 0
}

/**
 * Compute a "this week is running ±X% above/below model" scaler from
 * the completed days of the current week. Returns 1.0 when there's
 * insufficient signal (< 2 days have both actual and predicted with
 * positive revenue).
 *
 * The scaler is clamped to [0.75, 1.25] — wider than a single noisy day
 * but tight enough that one weird day can't double the rest of the
 * week's forecast. Apply by multiplying remaining-day predictions.
 */
export function thisWeekScaler(
  pairs: Array<{ actual: number; predicted: number }>,
): { scaler: number; samples: number; raw: number } {
  const valid = pairs.filter(p =>
    Number.isFinite(p.actual) && Number.isFinite(p.predicted) &&
    p.actual > 0 && p.predicted > 0,
  )
  if (valid.length < 2) return { scaler: 1, samples: valid.length, raw: 1 }

  // Median of per-day ratios — robust against one outlier (e.g. a
  // holiday or burst-promotion day in the middle of the week).
  const ratios = valid.map(p => p.actual / p.predicted).sort((a, b) => a - b)
  const mid    = ratios.length % 2 === 1
    ? ratios[Math.floor(ratios.length / 2)]
    : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2

  const clamped = Math.max(0.75, Math.min(1.25, mid))
  return { scaler: clamped, samples: valid.length, raw: mid }
}

/**
 * Hard constants the two forecasters share. Tweaking these moves the
 * model's response curve — keep them centralised so a single edit
 * applies everywhere.
 */
export const RECENCY = {
  /** Days back from the reference date that count as "recent". */
  RECENT_WINDOW_DAYS:  28,
  /** Multiplier applied to recent values before averaging. */
  RECENCY_MULTIPLIER:  2.0,
  /** Min sample count for the scaler to apply. */
  SCALER_MIN_SAMPLES:  2,
  /** Min and max scaler values — prevents one weird day blowing up the rest of the week. */
  SCALER_FLOOR:        0.75,
  SCALER_CEIL:         1.25,
} as const
