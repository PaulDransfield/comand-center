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
 * The scaler is clamped to a per-mode range:
 *   - Mature history (default):   [0.75, 1.25]
 *   - Short-history mode:         [0.50, 1.50]
 *
 * Floor exists so one weird day in a mature baseline can't double the
 * rest of the week's forecast. In short-history mode the baseline ITSELF
 * is suspect (4-week unweighted average can be anchored on a single
 * seasonal peak), so trusting observed-this-week data more heavily is
 * the right call. Backtest 2026-05-10 showed January cold-start
 * predictions running 30-50% of actuals (raw scaler 0.29-0.52) but
 * the 0.75 floor forbid the deterministic forecaster from correcting
 * to the observed regime. Relaxing to 0.50 in short-history mode lets
 * the deterministic system self-correct off real data the moment it
 * arrives.
 */
export function thisWeekScaler(
  pairs: Array<{ actual: number; predicted: number }>,
  opts: { shortHistoryMode?: boolean } = {},
): { scaler: number; samples: number; raw: number; floor: number; ceil: number } {
  const valid = pairs.filter(p =>
    Number.isFinite(p.actual) && Number.isFinite(p.predicted) &&
    p.actual > 0 && p.predicted > 0,
  )
  const floor = opts.shortHistoryMode ? RECENCY.SCALER_FLOOR_SHORT : RECENCY.SCALER_FLOOR
  const ceil  = opts.shortHistoryMode ? RECENCY.SCALER_CEIL_SHORT  : RECENCY.SCALER_CEIL
  if (valid.length < 2) return { scaler: 1, samples: valid.length, raw: 1, floor, ceil }

  // Median of per-day ratios — robust against one outlier (e.g. a
  // holiday or burst-promotion day in the middle of the week).
  const ratios = valid.map(p => p.actual / p.predicted).sort((a, b) => a - b)
  const mid    = ratios.length % 2 === 1
    ? ratios[Math.floor(ratios.length / 2)]
    : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2

  const clamped = Math.max(floor, Math.min(ceil, mid))
  return { scaler: clamped, samples: valid.length, raw: mid, floor, ceil }
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
  /** Wider clamp used in short-history mode. The 4-week unweighted baseline
   *  can be anchored on a single seasonal peak (e.g. Vero's January 2026
   *  baseline is anchored on December Christmas weeks), so the deterministic
   *  forecaster needs more headroom to self-correct from observed-this-week
   *  data once it arrives. */
  SCALER_FLOOR_SHORT:  0.50,
  SCALER_CEIL_SHORT:   1.50,
  /** History threshold below which short-history mode kicks in.
   *  Below this, the recency multiplier amplifies seasonal peaks instead
   *  of capturing trend (Vero diagnostic 2026-05-10 showed +88% bias on
   *  Jan-Mar 2026 because December's Christmas weeks dominated the
   *  recency window). Use 4-week unweighted baseline instead. */
  SHORT_HISTORY_THRESHOLD_DAYS: 180,
} as const

/**
 * Adaptive recency parameters based on history maturity.
 *
 * Mature businesses (≥180 days of positive revenue):
 *   - 28-day recency window, 2.0× multiplier
 *   - The full 12-week baseline gets used; recent 4 weeks weighted 2×
 *
 * Short-history businesses (<180 days):
 *   - 28-day recency window, 1.0× multiplier (flat mean)
 *   - Caller should ALSO reduce the baseline data fetch window from
 *     12 weeks to 4 weeks; weighting is moot when data is thin.
 *
 * Why: with limited data and an active seasonal trend, "weight recent 2×"
 * just amplifies whatever direction the most recent month went (post-
 * Christmas dip → over-prediction; rapid growth → under-prediction).
 * Flat-mean over a tighter window is less confidently wrong.
 *
 * @param historyDays Count of distinct days with positive revenue
 */
export function adaptiveRecencyParams(historyDays: number): {
  recentWindowDays:  number
  recencyMultiplier: number
  baselineWindowWeeks: number
  shortHistoryMode:  boolean
} {
  const shortHistoryMode = historyDays < RECENCY.SHORT_HISTORY_THRESHOLD_DAYS
  return {
    recentWindowDays:    RECENCY.RECENT_WINDOW_DAYS,
    recencyMultiplier:   shortHistoryMode ? 1.0 : RECENCY.RECENCY_MULTIPLIER,
    baselineWindowWeeks: shortHistoryMode ? 4   : 12,
    shortHistoryMode,
  }
}
