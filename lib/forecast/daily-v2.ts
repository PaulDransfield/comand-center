// lib/forecast/daily-v2.ts
//
// Daily revenue forecaster — v1.6.0 SKELETON (subset-substitution architecture).
//
// STATUS: shell only, not wired anywhere. Designed alongside the existing
// v1.5.0 (lib/forecast/daily.ts) so we can backtest both side-by-side
// without disturbing the working code.
//
// ────────────────────────────────────────────────────────────────────────
// WHY THIS REWRITE
// ────────────────────────────────────────────────────────────────────────
// Phase 0 measurement (2026-05-19) showed v1.5.0 at 64.6 % MAPE / +13.9 %
// bias across 116 Vero days, while the simpler legacy `scheduling_ai_revenue`
// hits 15.2-28.8 % MAPE at horizon=7 on Rosali/Vero. The legacy uses three
// signals (weekday baseline + weather bucket substitution + this-week
// scaler); v1.5.0 chains ~9 multiplicative factors. Each factor adds
// directional bias that compounds — 4 % skew per factor × 8 factors ≈ +37 %
// bias, almost exactly Vero's observed +31.6 % on low-confidence days.
//
// The architectural fix: SUBSET SUBSTITUTION instead of LIFT MULTIPLICATION.
// When we have ≥3 historical days that match the forecast date on the
// signal axes we care about, use that subset's mean DIRECTLY. Don't compute
// a generic baseline and then multiply it by separately-estimated lift
// factors — that compounds variance from independent estimates.
//
// ────────────────────────────────────────────────────────────────────────
// ARCHITECTURE
// ────────────────────────────────────────────────────────────────────────
//
//   PRECONDITIONS  →  SUBSET CHAIN  →  THIS-WEEK SCALER  →  CAPTURE
//
// 1. PRECONDITIONS (deterministic short-circuits, before any math)
//    a. Business not found            → throw
//    b. Closed weekday (opening_days) → return predicted=0, confidence=high
//    c. No positive-revenue history   → return predicted=0, confidence=low
//
// 2. SUBSET CHAIN (find the most specific subset with ≥MIN_SUBSET_SIZE
//    samples). Try in priority order, fall through on insufficient data.
//
//    Tier 1 (most specific):  weekday × weather_bucket × salary_phase × holiday_class
//    Tier 2:                  weekday × weather_bucket × salary_phase
//    Tier 3:                  weekday × weather_bucket
//    Tier 4:                  weekday × salary_phase
//    Tier 5:                  weekday                              ← legacy floor
//    Tier 6 (fallback):       all positive-revenue days            ← cold-start
//
//    Each tier is a recency-weighted mean of its subset.
//    `holiday_class` ∈ {'none', 'high_impact', 'low_impact', 'klamdag'}.
//    `salary_phase` ∈ {'around_payday', 'mid_month', 'end_month'}.
//    `weather_bucket` ∈ {'clear','mild','cold_dry','wet','snow','freezing','hot','thunder'}.
//
//    KEY INVARIANT: we NEVER multiply lift factors. Each tier is a
//    self-contained estimate from its own subset. We choose ONE tier per
//    forecast and use its mean directly.
//
//    Cold-start sub-rule: in short-history-mode (<180 days), apply the
//    Dec 20-Jan 6 holiday-period filter to ALL tiers (preserves v1.3's
//    Christmas-peak exclusion when forecasting January).
//
// 3. THIS-WEEK SCALER (post-subset)
//    Same logic as v1.5. For future dates (no actual yet), compute the
//    median (actual/predicted) ratio across completed days of the current
//    week, clamped [0.75, 1.25], multiply the subset mean by it.
//
// 4. CAPTURE
//    Write to daily_forecast_outcomes with surface='consolidated_daily_v2'
//    (NEW surface, intentionally distinct from v1.5's 'consolidated_daily'
//    so the audit ledger grades them side-by-side without conflicts).
//
// ────────────────────────────────────────────────────────────────────────
// WHAT WE'RE KEEPING FROM v1.5
// ────────────────────────────────────────────────────────────────────────
//
//   ✓ Closed-day short-circuit (opening_days)
//   ✓ Zero-baseline fallback (Tier 6 in the new chain)
//   ✓ Cold-start holiday-period filter (Dec 20 - Jan 6)
//   ✓ Anomaly-contamination exclusion from baseline
//   ✓ Recency-weighted means (RECENCY.RECENCY_MULTIPLIER on recent samples)
//   ✓ Short-history-mode detection (≥180 days for mature mode)
//   ✓ This-week scaler
//   ✓ Confidence labels (HISTORY_DAYS_FOR_HIGH/MED thresholds)
//   ✓ inputs_snapshot for the LLM auditor
//
// WHAT WE'RE DROPPING FROM v1.5
//
//   ✗ Multiplicative chain (yoy × weather_lift × weather_change ×
//     holiday_lift × klamdag × school_holiday × salary_cycle × scaler)
//   ✗ yoy_same_month trailing-growth multiplier
//   ✗ yoy_same_weekday 30/70 blend
//   ✗ weather_change_vs_seasonal Piece-3 factor
//   ✗ Holiday lift as a separate multiplier (now folded into Tier 1
//     subset matching via holiday_class)
//
// ────────────────────────────────────────────────────────────────────────
// TODO BEFORE WIRING
// ────────────────────────────────────────────────────────────────────────
//
//   [ ] Fill in fetchSamples() — the parallel DB load for daily_metrics +
//       weather_daily + anomaly_alerts (mirrors v1.5)
//   [ ] Implement classifyHoliday() / classifySalaryPhase() — already exist
//       in v1.5 in different form, port them out as pure helpers in
//       lib/forecast/classifiers.ts so both versions can share
//   [ ] Implement findSubset() — picks the highest tier with ≥MIN_SAMPLES
//   [ ] Implement the snapshot builder — track which tier won, sample count,
//       what subsets were considered but rejected
//   [ ] Confidence label: keep the same signalsAvailable-based logic but
//       weight tier-tier-1/2 matches higher than tier-5/6 fallbacks
//   [ ] Capture under NEW surface 'consolidated_daily_v2' (add to M059's
//       CHECK constraint and to lib/forecast/audit.ts's ForecastSurface
//       enum)
//
// ────────────────────────────────────────────────────────────────────────

import type { DailyForecast, DailyForecastOptions } from './daily'

// ── Constants ────────────────────────────────────────────────────────

export const MODEL_VERSION_V2  = 'consolidated_v2.0.0_subset_substitution'

/** Minimum samples to use a subset tier. Below this, fall through. The
 *  legacy uses 3; we match that as the floor. */
const MIN_SUBSET_SAMPLES = 3

/** Subset tier identifier — used in inputs_snapshot.tier_chosen so we
 *  can see in the audit ledger which tier produced each prediction. */
export type SubsetTier =
  | 'weekday_bucket_phase_holiday'  // Tier 1
  | 'weekday_bucket_phase'          // Tier 2
  | 'weekday_bucket'                // Tier 3
  | 'weekday_phase'                 // Tier 4
  | 'weekday'                       // Tier 5
  | 'all_weekdays'                  // Tier 6 — cold-start fallback
  | 'none'                          // no history → predicted=0

// ── Public types ─────────────────────────────────────────────────────

export interface SubsetSnapshot {
  tier_chosen:                SubsetTier
  tier_chosen_samples:         number
  tier_chain_attempted: Array<{
    tier:    SubsetTier
    samples: number
    reason_skipped: string | null   // null when chosen
  }>
  base_prediction_pre_scaler: number
  weather_bucket:              string | null
  salary_phase:                'around_payday' | 'mid_month' | 'end_month'
  holiday_class:               'none' | 'high_impact' | 'low_impact' | 'klamdag'
  short_history_mode:          boolean
  total_days_of_history:       number
  data_quality_flags:          string[]
}

export interface ConsolidatedV2Snapshot {
  snapshot_version: 'consolidated_v2'
  model_version:    string

  subset:            SubsetSnapshot
  this_week_scaler:  {
    raw:            number
    applied:        number
    clamped_at_max: boolean
    clamped_at_min: boolean
    samples:        number
  }
  business_closed_for_weekday: boolean
  cold_start_zero_history:     boolean
}

// ── Main entry (skeleton — throws until filled in) ───────────────────

/**
 * v1.6.0 forecaster. Returns the same DailyForecast shape as v1.5 so
 * callers don't need to change. Capture uses surface='consolidated_daily_v2'
 * so the audit ledger keeps both versions separate.
 *
 * NOT YET WIRED. To enable: implement the TODOs above, then add a
 * feature flag (e.g. PREDICTION_V2_SUBSET_SUBSTITUTION) and route from
 * the same caller sites that currently use dailyForecast().
 */
export async function dailyForecastV2(
  _businessId: string,
  _date:       Date,
  _options:    DailyForecastOptions = {},
): Promise<DailyForecast> {
  throw new Error('dailyForecastV2 not yet implemented — skeleton only')
}

// ── Helper signatures (to fill in) ───────────────────────────────────

/**
 * Find the highest-tier subset that has ≥MIN_SUBSET_SAMPLES historical
 * matches. Returns the tier name, the matching sample mean, and the list
 * of tiers that were considered and rejected (for the audit ledger).
 *
 * Subsets are evaluated against the forecast date's:
 *   - weekday
 *   - weather bucket (from forecast)
 *   - salary phase (from day-of-month)
 *   - holiday class (from country holiday module)
 *
 * Falls through tiers in priority order. Tier 6 (all weekdays) is the
 * cold-start safety net — only fires when even tier 5 has <3 samples.
 *
 * TODO: implement.
 */
export function findSubset(_args: unknown): {
  tier:           SubsetTier
  prediction:     number
  samples:        number
  chain_attempted: SubsetSnapshot['tier_chain_attempted']
} {
  throw new Error('findSubset not yet implemented')
}

/**
 * Classify a date's holiday context. Returns one of:
 *   'high_impact'  — observed holiday with restaurant lift (e.g. Valborg)
 *   'low_impact'   — observed holiday with restaurant dampening (e.g. Christmas Day, most close)
 *   'klamdag'      — bridge day adjacent to a holiday
 *   'none'         — regular trading day
 *
 * TODO: port from v1.5's holiday detection + computeKlamdag.
 */
export function classifyHoliday(_date: Date, _country: string): 'none' | 'high_impact' | 'low_impact' | 'klamdag' {
  throw new Error('classifyHoliday not yet implemented')
}

/**
 * Swedish salary-cycle phase. Same as v1.5's salaryPhase() — port it
 * out to a shared classifier file so both versions share the logic.
 *
 * TODO: extract.
 */
export function classifySalaryPhase(_dayOfMonth: number): 'around_payday' | 'mid_month' | 'end_month' {
  throw new Error('classifySalaryPhase not yet implemented')
}
