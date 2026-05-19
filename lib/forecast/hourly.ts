// lib/forecast/hourly.ts
//
// Per-hour revenue forecaster — Phase A week 1 of the Nordic Plan.
//
// STATUS: skeleton. Schema and ingestion are live (M071 + lib/sync/engine.ts);
// implementation lands next once we have ≥30 days of hourly_metrics data
// to validate against.
//
// Why per-hour, not per-day:
//   - Operators schedule per shift (lunch vs dinner), not per day. Daily
//     accuracy doesn't translate to shift-level cost decisions.
//   - Lunch and dinner have different volatility profiles: lunch is more
//     weather-sensitive (terrace traffic, walk-ins); dinner is more
//     event-sensitive (concerts, conferences, holidays).
//   - 15-20 % MAPE on daily revenue translates to 25-30 % on lunch-only,
//     because lunch is ~30 % of daily volume and absorbs more noise.
//     Predicting lunch-and-dinner separately reduces that.
//
// Architecture:
//   - Same signal stack as lib/forecast/daily.ts (v1.5) but conditioned on
//     hour-of-day in addition to weekday.
//   - Each hour learns its own weekday baseline (e.g. Friday 19:00 averages
//     X kr across the last 4-12 weeks of Fridays).
//   - Closed-day short-circuit inherits from opening_days — closed days
//     have no hours of trading.
//   - Closed-hour short-circuit (NEW): even on open days, restaurants are
//     closed before/after service hours. Default heuristic: predict 0 when
//     historical revenue in that (weekday, hour) cell is consistently 0.
//   - Meal-period rollups happen DOWNSTREAM (see meal_period helper) —
//     this function returns one hour at a time.
//
// ────────────────────────────────────────────────────────────────────────
// MEAL PERIODS (Stockholm conventions, override per-business later)
// ────────────────────────────────────────────────────────────────────────
//
//   lunch    11:00 - 14:59  (3 hours)
//   tea      15:00 - 16:59  (2 hours)  ← afternoon, low volume
//   dinner   17:00 - 21:59  (5 hours)
//   late     22:00 - 25:59  (4 hours)  ← bar trade; uses business_date logic
//
// Late-night hours (00:00-03:59) belong to the PREVIOUS business_date in
// the hourly_metrics table (Stockholm-local + restaurant business-day
// convention). The 'late' rollup spans 22-25 conceptually but reads from
// hours 22, 23, 0, 1 of the same business_date.
//
// ────────────────────────────────────────────────────────────────────────
// IMPLEMENTATION CHECKLIST (when ready to wire)
// ────────────────────────────────────────────────────────────────────────
//
//   [ ] Load hourly_metrics for the baseline window (12w mature / 4w cold-start)
//   [ ] Per (weekday, hour) recency-weighted average baseline
//   [ ] Zero-history short-circuit per cell (matches daily v1.4 fallback)
//   [ ] Weather lift per hour — lunch is more weather-sensitive than dinner
//   [ ] Holiday / klamdag / school-holiday lift per hour
//   [ ] This-week scaler per meal period (not per hour — too noisy)
//   [ ] Capture under new surface 'consolidated_hourly' (M072 to add to
//       the ForecastSurface enum + audit ledger CHECK constraint)
//   [ ] Meal-period rollup helper that sums hours and computes confidence
//
// ────────────────────────────────────────────────────────────────────────

// ── Public types ─────────────────────────────────────────────────────

export interface HourlyForecast {
  business_id:       string
  business_date:     string   // YYYY-MM-DD Stockholm-local
  hour:              number   // 0-23 Stockholm-local
  predicted_revenue: number
  baseline_revenue:  number
  components: {
    weekday_hour_baseline: number
    weather_lift_pct:      number
    holiday_lift_pct:      number
    klamdag_pct:           number
    salary_cycle_pct:      number
    this_week_scaler:      number
  }
  confidence: 'high' | 'medium' | 'low'
  is_closed_hour:    boolean   // true when historical revenue at this (weekday, hour) is consistently 0
  model_version:     string
}

export type MealPeriod = 'lunch' | 'tea' | 'dinner' | 'late'

export interface MealPeriodForecast {
  business_id:       string
  business_date:     string
  meal_period:       MealPeriod
  predicted_revenue: number
  predicted_covers:  number
  hours_included:    number[]
  confidence:        'high' | 'medium' | 'low'
  hourly_breakdown:  HourlyForecast[]
}

// ── Constants ────────────────────────────────────────────────────────

export const MODEL_VERSION_HOURLY = 'consolidated_hourly_v1.0.0'

/** Stockholm meal-period definitions. Per-business overrides come later. */
export const MEAL_PERIOD_HOURS: Record<MealPeriod, number[]> = {
  lunch:  [11, 12, 13, 14],
  tea:    [15, 16],
  dinner: [17, 18, 19, 20, 21],
  // Late spans midnight conceptually — by the time it's stored, hours 22/23
  // are on business_date N, while hours 0/1 are on business_date N+1.
  // Resolve at query time by reading both ranges per the operator's "Friday
  // night" mental model.
  late:   [22, 23, 0, 1],
}

/** Minimum samples per (weekday, hour) cell to use the baseline directly.
 *  Below this, fall through to the closed-hour check or zero fallback. */
export const MIN_HOURLY_BASELINE_SAMPLES = 3

// ── Entry points (skeleton — throw until wired) ──────────────────────

/**
 * Predict revenue for one (business × business_date × hour) cell.
 * Same shape as DailyForecast — drop-in for any caller that wants a
 * single-hour prediction.
 *
 * TODO: implement.
 */
export async function hourlyForecast(
  _businessId: string,
  _date:       Date,
  _hour:       number,
  _options:    { db?: any; skipLogging?: boolean } = {},
): Promise<HourlyForecast> {
  throw new Error('hourlyForecast not yet implemented — skeleton only (Phase A week 1)')
}

/**
 * Predict a meal period (lunch / tea / dinner / late) for a given
 * business_date. Internally calls hourlyForecast for each constituent
 * hour and sums revenue + covers. Confidence is the worst of the
 * constituent hours.
 *
 * TODO: implement.
 */
export async function mealPeriodForecast(
  _businessId:  string,
  _date:        Date,
  _mealPeriod:  MealPeriod,
  _options:     { db?: any; skipLogging?: boolean } = {},
): Promise<MealPeriodForecast> {
  throw new Error('mealPeriodForecast not yet implemented — skeleton only (Phase A week 1)')
}

// ── Helpers (to implement) ───────────────────────────────────────────

/**
 * Build a per-(weekday, hour) baseline map from hourly_metrics rows.
 * Returns a Record keyed by `${weekday}|${hour}` → { mean, samples, stddev }.
 *
 * TODO: implement.
 */
export function buildWeekdayHourBaselines(_rows: unknown): unknown {
  throw new Error('buildWeekdayHourBaselines not yet implemented')
}

/**
 * Detect closed hours per business. An hour is "closed" if historical
 * revenue at that (weekday, hour) cell is 0 across all available samples
 * (mature mode) or all but 0-1 outlier samples (short-history mode).
 *
 * Returns a Set<`${weekday}|${hour}`> of closed cells.
 *
 * TODO: implement.
 */
export function detectClosedHours(_rows: unknown): Set<string> {
  throw new Error('detectClosedHours not yet implemented')
}
