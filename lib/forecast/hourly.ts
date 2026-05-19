// lib/forecast/hourly.ts
//
// Per-hour revenue forecaster — Nordic Plan Phase A week 2.
//
// Architecture: subset substitution, no lift chain (lesson from the v1.5
// → legacy comparison). Each (weekday × hour) cell is its own
// recency-weighted average from history. Closed hours short-circuit to
// 0. Meal periods are auto-detected per-business from revenue density
// — Vero's lunch is 11-15 with peak at 14; Rosali's is 12-15 with peak
// at 14; a brunch-only café would cluster 09-13. No hardcoded boundaries.
//
// What's NOT here (and why):
//   - Weather lift per hour — the legacy daily forecaster does this via
//     subset substitution (weekday × bucket). At hourly grain that's a
//     5-dimensional cell (weekday × hour × bucket × …) with cold-start
//     sample counts too thin to be useful. Defer to v1.1.
//   - Holiday lift — same reason. Holidays already shift weekday
//     baselines via the daily-aggregate path; not adding another
//     multiplier on top of (weekday, hour) means.
//   - This-week scaler — applied per meal period, not per hour. Single
//     noisy hour shouldn't drag the rest of the day's predictions.
//
// Output is captured under surface='consolidated_hourly' in
// daily_forecast_outcomes (still using the existing audit ledger; the
// forecast_date column carries the (business_date, hour) via the
// generated columns. If we need true hour-level grading later we'll add
// hourly_forecast_outcomes in M072.)

import { createAdminClient } from '@/lib/supabase/server'
import { weightedAvg, thisWeekScaler, RECENCY, adaptiveRecencyParams } from '@/lib/forecast/recency'

// ── Public types ─────────────────────────────────────────────────────

export interface HourlyForecast {
  business_id:       string
  business_date:     string   // YYYY-MM-DD Stockholm-local
  hour:              number   // 0-23 Stockholm-local
  predicted_revenue: number
  predicted_covers:  number
  baseline_revenue:  number
  components: {
    weekday_hour_baseline: number
    this_week_scaler:      number
  }
  confidence: 'high' | 'medium' | 'low'
  is_closed_hour:    boolean
  data_quality_flags: string[]
  model_version:     string
  /** Sample count behind the (weekday, hour) baseline used for this
   *  prediction. Below MIN_BASELINE_SAMPLES the prediction falls back
   *  to the cross-weekday hour average. */
  baseline_samples:  number
  baseline_tier:     'weekday_hour' | 'any_weekday_hour' | 'closed' | 'no_history'
}

export type MealPeriodLabel = 'breakfast' | 'brunch' | 'lunch' | 'afternoon' | 'dinner' | 'late' | 'overnight'

export interface MealPeriodCluster {
  label:      MealPeriodLabel
  hours:      number[]    // Stockholm-local hours, sorted ascending (late period may include 22, 23, 0, 1)
  peak_hour:  number
  peak_share: number      // 0-1, peak hour's share of total daily revenue
  total_share: number     // 0-1, cluster's combined share of total daily revenue
}

export interface MealPeriodForecast {
  business_id:       string
  business_date:     string
  label:             MealPeriodLabel
  hours:             number[]
  predicted_revenue: number
  predicted_covers:  number
  hourly_breakdown:  HourlyForecast[]
  confidence:        'high' | 'medium' | 'low'
}

// ── Constants ────────────────────────────────────────────────────────

export const MODEL_VERSION_HOURLY  = 'consolidated_hourly_v1.0.0'

/** Below this, the (weekday × hour) baseline is unreliable; fall back to
 *  the cross-weekday hour average (Tier 2). */
const MIN_BASELINE_SAMPLES = 3

/** Fraction of historical (weekday, hour) samples that must be zero for
 *  the hour to be classified as structurally closed. Vero's 02:00-10:00
 *  hits this at 100 %; Rosali's at 100 % for 22:00-09:00. */
const CLOSED_HOUR_ZERO_THRESHOLD = 0.95

/** Minimum share of total daily revenue an hour must contribute to be
 *  considered "active" (i.e. part of a meal-period cluster). 1% is
 *  conservative — Rosali's 10:00 (0.16% share) correctly falls below;
 *  her 12:00 (2.3%) correctly stays above. */
const MEAL_PERIOD_MIN_HOUR_SHARE = 0.01

// ── History loader ───────────────────────────────────────────────────

interface HourlyRow {
  business_date: string
  hour:          number
  revenue:       number
  covers:        number
}

async function loadHourlyHistory(
  db: any,
  businessId: string,
  asOfDate: Date,
  baselineWeeks: number,
): Promise<HourlyRow[]> {
  const from = new Date(asOfDate)
  from.setUTCDate(from.getUTCDate() - baselineWeeks * 7)
  const fromIso = ymd(from)
  const toIso   = ymd(asOfDate)

  const { data, error } = await db
    .from('hourly_metrics')
    .select('business_date, hour, revenue, covers')
    .eq('business_id', businessId)
    .gte('business_date', fromIso)
    .lte('business_date', toIso)
    .order('business_date', { ascending: true })

  if (error) throw new Error(`hourly_metrics load failed: ${error.message}`)
  return (data ?? []) as HourlyRow[]
}

// ── Closed-hour detection ────────────────────────────────────────────

/**
 * For each (weekday, hour) cell, returns true when ≥95 % of historical
 * samples have zero revenue. Operates on the same history window the
 * forecaster uses for baselines.
 *
 * Method: walk every distinct date in the data; for each weekday count
 * how many of its dates had zero revenue at this hour vs total. Hours
 * with no samples at all are treated as closed (we have no evidence
 * they're open).
 */
export function detectClosedHours(rows: HourlyRow[]): Set<string> {
  // distinct-dates per weekday → so a weekday with 4 dates and 0
  // observations at hour=03 means 4 implicit zeros (the row simply
  // wasn't written because there was no revenue).
  const datesByWeekday: Record<number, Set<string>> = {}
  for (let d = 0; d < 7; d++) datesByWeekday[d] = new Set()
  for (const r of rows) {
    const wd = weekdayOf(r.business_date)
    datesByWeekday[wd].add(r.business_date)
  }

  // Non-zero observations per (weekday, hour)
  const nonZeroSamples: Record<string, number> = {}
  for (const r of rows) {
    if (r.revenue <= 0) continue
    const wd = weekdayOf(r.business_date)
    const k  = `${wd}|${r.hour}`
    nonZeroSamples[k] = (nonZeroSamples[k] ?? 0) + 1
  }

  const closed = new Set<string>()
  for (let wd = 0; wd < 7; wd++) {
    const totalDates = datesByWeekday[wd].size
    if (totalDates === 0) continue
    for (let h = 0; h < 24; h++) {
      const k = `${wd}|${h}`
      const nz = nonZeroSamples[k] ?? 0
      // Closed iff non-zero share is below 1 − threshold (i.e. 5 % when
      // threshold is 0.95). If totalDates is small (cold-start), even
      // 1 sample of revenue keeps the hour "open" — we'd rather predict
      // a small number than zero on a previously-traded hour.
      const nonZeroShare = nz / totalDates
      if (nonZeroShare < (1 - CLOSED_HOUR_ZERO_THRESHOLD)) {
        closed.add(k)
      }
    }
  }
  return closed
}

// ── Meal-period auto-detection ───────────────────────────────────────

/** Universal Swedish meal-period definitions (label → hours).
 *
 *  Detected meal periods for a business are: this universal map, intersected
 *  with the hours where the business actually trades (revenue share ≥ 1 %
 *  of daily total). A continuous-trade restaurant like Vero hits lunch +
 *  tea + dinner + late; a deli like Rosali hits lunch + (small) dinner;
 *  a brunch café would hit breakfast + brunch.
 *
 *  Why hardcoded boundaries rather than auto-clustering:
 *    - Vero trades CONTINUOUSLY from 12:00 to 00:00. There's no zero-
 *      revenue gap between lunch and dinner. A cluster-by-gap algorithm
 *      collapses everything into one giant "evening" cluster, defeating
 *      the per-meal-period staffing recommendation the whole feature
 *      exists for.
 *    - Local-minima detection at "between-service trough" (hour 16 for
 *      Vero) is fragile — the trough is shallow on the lunch side
 *      (15 → 16 dropped only 10 %) but deep on the dinner side (16 → 17
 *      rose 51 %). Threshold-tuning here is a calibration rabbit hole.
 *    - Swedish service conventions are stable and well-known. Owners
 *      think in these terms. Auto-detecting away from them produces
 *      labels that confuse customers ("why is my 11am cluster called
 *      'brunch'?") for no accuracy gain.
 *
 *  When we hit a non-Swedish business OR a customer with materially
 *  different hours, we'll add per-business overrides (e.g. a column on
 *  `businesses` that stores their actual meal-period boundaries). For
 *  now, hardcoded + per-business active-hour intersection covers Vero
 *  and Rosali correctly.
 */
const UNIVERSAL_MEAL_PERIODS: Array<{ label: MealPeriodLabel; hours: number[] }> = [
  { label: 'breakfast', hours: [6, 7, 8, 9] },
  { label: 'brunch',    hours: [10] },
  { label: 'lunch',     hours: [11, 12, 13, 14, 15] },
  { label: 'afternoon', hours: [16] },
  { label: 'dinner',    hours: [17, 18, 19, 20, 21] },
  { label: 'late',      hours: [22, 23] },
  // Hours 0-1 belong to the PREVIOUS business_date's "late" tail in
  // operator mental model (Saturday night extends into Sunday 01:00).
  // Storing them on the post-midnight business_date is right for
  // hourly_metrics but they're not part of THIS business_date's late
  // period from a staffing-prediction perspective. We skip them in v1.
]

/**
 * Detect this business's active meal periods by intersecting the universal
 * meal-period map with hours that have revenue share >= MEAL_PERIOD_MIN_HOUR_SHARE.
 *
 * Returns clusters in chronological order with the original labels. Empty
 * meal periods (zero matching active hours) are omitted entirely — Rosali
 * has no breakfast/brunch/afternoon clusters because her early morning
 * and mid-afternoon shares are too thin.
 */
export function detectMealPeriods(rows: HourlyRow[]): MealPeriodCluster[] {
  if (rows.length === 0) return []

  // Per-hour total revenue across all samples
  const hourTotal: number[] = new Array(24).fill(0)
  let dailyTotal = 0
  for (const r of rows) {
    hourTotal[r.hour] += r.revenue
    dailyTotal       += r.revenue
  }
  if (dailyTotal <= 0) return []

  const hourShare = hourTotal.map(v => v / dailyTotal)
  const isActive  = hourShare.map(s => s >= MEAL_PERIOD_MIN_HOUR_SHARE)

  const clusters: MealPeriodCluster[] = []
  for (const { label, hours } of UNIVERSAL_MEAL_PERIODS) {
    const activeHours = hours.filter(h => isActive[h])
    if (activeHours.length === 0) continue
    const peakHour = activeHours.reduce(
      (best, h) => hourShare[h] > hourShare[best] ? h : best,
      activeHours[0],
    )
    clusters.push({
      label,
      hours:       activeHours,
      peak_hour:   peakHour,
      peak_share:  Math.round(hourShare[peakHour] * 1000) / 1000,
      total_share: Math.round(activeHours.reduce((s, h) => s + hourShare[h], 0) * 1000) / 1000,
    })
  }
  return clusters
}

// ── Main entry: single-hour forecast ─────────────────────────────────

export async function hourlyForecast(
  businessId: string,
  date:       Date,
  hour:       number,
  options:    {
    db?: any
    /** Preloaded hourly_metrics rows covering at least 12 weeks back from
     *  `date`. When provided, skip the DB load + cold-start probe. Used by
     *  the scheduling AI route to avoid N×400 query amplification on
     *  per-meal-period predictions. */
    preloadedHistory?: HourlyRow[]
    /** Preloaded this-week-so-far hourly_metrics rows (for the this-week
     *  scaler). When provided, skip that query too. */
    preloadedThisWeek?: HourlyRow[]
  } = {},
): Promise<HourlyForecast> {
  const db = options.db ?? createAdminClient()
  const forecastDate = ymd(date)
  const targetWeekday = date.getUTCDay()

  // Cold-start check: count distinct dates with positive hourly data.
  // Below 180 days → short-history mode (tighter window, no recency multiplier).
  let totalDays: number
  let rows: HourlyRow[]
  if (options.preloadedHistory) {
    rows = options.preloadedHistory.filter(r => r.business_date <= forecastDate)
    totalDays = new Set(rows.filter(r => r.revenue > 0).map(r => r.business_date)).size
  } else {
    const probe = await db
      .from('hourly_metrics')
      .select('business_date', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .gt('revenue', 0)
    totalDays = Number(probe.count ?? 0)
    const adaptiveTmp = adaptiveRecencyParams(totalDays)
    rows = await loadHourlyHistory(db, businessId, date, adaptiveTmp.baselineWindowWeeks)
  }
  const adaptive  = adaptiveRecencyParams(totalDays)

  // ── Closed-hour short-circuit ────────────────────────────────────
  const closedKeys = detectClosedHours(rows)
  if (closedKeys.has(`${targetWeekday}|${hour}`)) {
    return makeForecast({
      businessId, forecastDate, hour,
      predicted: 0, predictedCovers: 0, baseline: 0,
      scaler: 1, confidence: 'high',
      isClosed: true, baselineSamples: 0, baselineTier: 'closed',
      flags: ['closed_hour_detected'],
    })
  }

  if (rows.length === 0) {
    return makeForecast({
      businessId, forecastDate, hour,
      predicted: 0, predictedCovers: 0, baseline: 0,
      scaler: 1, confidence: 'low',
      isClosed: false, baselineSamples: 0, baselineTier: 'no_history',
      flags: ['no_hourly_history'],
    })
  }

  // ── Tier 1: (weekday × hour) recency-weighted baseline ───────────
  const tier1Rows = rows.filter(r => r.hour === hour && weekdayOf(r.business_date) === targetWeekday)
  let baselineSamples = tier1Rows.length
  let baselineTier: HourlyForecast['baseline_tier'] = 'weekday_hour'
  let baselineRev = 0
  let baselineCovers = 0
  const flags: string[] = []

  if (tier1Rows.length >= MIN_BASELINE_SAMPLES) {
    const vals  = tier1Rows.map(r => r.revenue)
    const dates = tier1Rows.map(r => r.business_date)
    baselineRev    = weightedAvg(vals, dates, date, {
      recentWindowDays:  adaptive.recentWindowDays,
      recencyMultiplier: adaptive.recencyMultiplier,
    })
    baselineCovers = weightedAvg(
      tier1Rows.map(r => r.covers), dates, date,
      { recentWindowDays: adaptive.recentWindowDays, recencyMultiplier: adaptive.recencyMultiplier },
    )
  } else {
    // ── Tier 2: any-weekday × hour fallback ────────────────────────
    const tier2Rows = rows.filter(r => r.hour === hour)
    if (tier2Rows.length >= MIN_BASELINE_SAMPLES) {
      const vals  = tier2Rows.map(r => r.revenue)
      const dates = tier2Rows.map(r => r.business_date)
      baselineRev    = weightedAvg(vals, dates, date, {
        recentWindowDays:  adaptive.recentWindowDays,
        recencyMultiplier: adaptive.recencyMultiplier,
      })
      baselineCovers = weightedAvg(
        tier2Rows.map(r => r.covers), dates, date,
        { recentWindowDays: adaptive.recentWindowDays, recencyMultiplier: adaptive.recencyMultiplier },
      )
      baselineSamples = tier2Rows.length
      baselineTier    = 'any_weekday_hour'
      flags.push('weekday_hour_baseline_thin_fellback_cross_weekday')
    } else {
      // No usable baseline — predict 0 with low confidence.
      return makeForecast({
        businessId, forecastDate, hour,
        predicted: 0, predictedCovers: 0, baseline: 0,
        scaler: 1, confidence: 'low',
        isClosed: false, baselineSamples: tier1Rows.length, baselineTier: 'no_history',
        flags: ['insufficient_samples_all_tiers'],
      })
    }
  }

  // ── This-week scaler (per meal period — auto-detect) ─────────────
  // For each completed day of the current week, compare actual to a
  // crude same-hour-of-same-weekday prediction; median ratio is the
  // scaler. Same logic as v1.5 but applied at the meal-period level
  // so it's smoother across hours.
  const mealPeriods = detectMealPeriods(rows)
  const mealForThisHour = mealPeriods.find(mp => mp.hours.includes(hour))
  const scalerResult = mealForThisHour
    ? await computeMealPeriodScaler(db, businessId, date, mealForThisHour, rows, options.preloadedThisWeek)
    : { scaler: 1, samples: 0, raw: 1 }

  const predicted = baselineRev * scalerResult.scaler
  const predictedCovers = baselineCovers * scalerResult.scaler

  if (adaptive.shortHistoryMode) flags.push('short_history_mode')

  // ── Confidence ────────────────────────────────────────────────────
  let confidence: 'high' | 'medium' | 'low' = 'medium'
  if (baselineTier === 'weekday_hour' && baselineSamples >= 8 && !adaptive.shortHistoryMode) confidence = 'high'
  else if (baselineTier === 'any_weekday_hour' || baselineSamples < 4)                       confidence = 'low'

  return makeForecast({
    businessId, forecastDate, hour,
    predicted, predictedCovers, baseline: baselineRev,
    scaler: scalerResult.scaler, confidence,
    isClosed: false, baselineSamples, baselineTier,
    flags,
  })
}

// ── Meal-period rollup ───────────────────────────────────────────────

export async function mealPeriodForecast(
  businessId: string,
  date:       Date,
  cluster:    MealPeriodCluster,
  options:    { db?: any } = {},
): Promise<MealPeriodForecast> {
  const db = options.db ?? createAdminClient()
  const hourly = await Promise.all(
    cluster.hours.map(h => hourlyForecast(businessId, date, h, { db })),
  )
  const predicted = hourly.reduce((s, r) => s + r.predicted_revenue, 0)
  const covers    = hourly.reduce((s, r) => s + r.predicted_covers, 0)
  // Confidence = worst constituent
  const confidence: 'high' | 'medium' | 'low' =
    hourly.some(h => h.confidence === 'low')    ? 'low'
    : hourly.some(h => h.confidence === 'medium') ? 'medium'
    : 'high'
  return {
    business_id:       businessId,
    business_date:     ymd(date),
    label:             cluster.label,
    hours:             cluster.hours,
    predicted_revenue: Math.round(predicted),
    predicted_covers:  Math.round(covers),
    hourly_breakdown:  hourly,
    confidence,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

async function computeMealPeriodScaler(
  db: any,
  businessId: string,
  forecastDate: Date,
  cluster: MealPeriodCluster,
  history: HourlyRow[],
  preloadedThisWeek?: HourlyRow[],
): Promise<{ scaler: number; samples: number; raw: number }> {
  // This-week-so-far: pull all hourly rows since Monday of this week.
  const weekStart = mondayOf(forecastDate)
  const weekStartIso = ymd(weekStart)
  const forecastIso  = ymd(forecastDate)
  let completed: HourlyRow[]
  if (preloadedThisWeek) {
    completed = preloadedThisWeek.filter(r =>
      r.business_date >= weekStartIso &&
      r.business_date <  forecastIso &&
      cluster.hours.includes(r.hour),
    )
  } else {
    const { data: thisWeek } = await db
      .from('hourly_metrics')
      .select('business_date, hour, revenue')
      .eq('business_id', businessId)
      .gte('business_date', weekStartIso)
      .lt('business_date', forecastIso)
      .in('hour', cluster.hours)
    completed = (thisWeek ?? []) as HourlyRow[]
  }

  const pairs: Array<{ actual: number; predicted: number }> = []
  for (const a of completed) {
    if (a.revenue <= 0) continue
    // Crude predicted: cross-weekday average of same hour from `history`.
    const sameHour = history.filter(h => h.hour === a.hour && h.business_date !== a.business_date && h.revenue > 0)
    if (sameHour.length === 0) continue
    const mean = sameHour.reduce((s, h) => s + h.revenue, 0) / sameHour.length
    if (mean > 0) pairs.push({ actual: a.revenue, predicted: mean })
  }
  return thisWeekScaler(pairs)
}

function makeForecast(args: {
  businessId: string; forecastDate: string; hour: number
  predicted: number; predictedCovers: number; baseline: number
  scaler: number; confidence: 'high' | 'medium' | 'low'
  isClosed: boolean; baselineSamples: number
  baselineTier: HourlyForecast['baseline_tier']
  flags: string[]
}): HourlyForecast {
  return {
    business_id:       args.businessId,
    business_date:     args.forecastDate,
    hour:              args.hour,
    predicted_revenue: Math.max(0, Math.round(args.predicted)),
    predicted_covers:  Math.max(0, Math.round(args.predictedCovers)),
    baseline_revenue:  Math.max(0, Math.round(args.baseline)),
    components: {
      weekday_hour_baseline: Math.round(args.baseline),
      this_week_scaler:      Math.round(args.scaler * 100) / 100,
    },
    confidence:        args.confidence,
    is_closed_hour:    args.isClosed,
    data_quality_flags: args.flags,
    model_version:     MODEL_VERSION_HOURLY,
    baseline_samples:  args.baselineSamples,
    baseline_tier:     args.baselineTier,
  }
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}
function pad2(n: number): string { return String(n).padStart(2, '0') }
function weekdayOf(dateIso: string): number {
  // YYYY-MM-DD → 0=Sun..6=Sat in Stockholm time (we stored business_date
  // as Stockholm-local, so a UTC-12:00 parse is sufficient — no DST drift
  // at noon Stockholm time across the year).
  return new Date(dateIso + 'T12:00:00Z').getUTCDay()
}
function mondayOf(d: Date): Date {
  const out = new Date(d)
  const day = out.getUTCDay() || 7
  out.setUTCDate(out.getUTCDate() - (day - 1))
  out.setUTCHours(0, 0, 0, 0)
  return out
}
