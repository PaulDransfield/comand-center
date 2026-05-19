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

/**
 * Cluster the business's revenue into contiguous "meal periods" based on
 * historical hour-of-day density. Returns a list of clusters in
 * chronological order.
 *
 * Method:
 *   1. Compute per-hour revenue share (sum across all dates, normalize)
 *   2. Walk hours 0-23 (then wrap 0-3 for late-night businesses)
 *   3. Contiguous active hours (share >= MEAL_PERIOD_MIN_HOUR_SHARE) form
 *      a cluster; a gap of 1+ inactive hours ends the cluster
 *   4. Label each cluster by where its peak hour falls
 *   5. Special "late" handling: a cluster ending at 22-23 with a hot 23-00
 *      bridge or independent post-midnight activity gets merged
 *
 * Vero: returns [{lunch:[11-15]}, {dinner:[17-22], late includes [23,0,1]}]
 * Rosali: returns [{lunch:[12-15]}, {dinner:[18-21]}]
 *
 * Empty rows → no clusters. Caller falls back to a wide default if needed.
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

  // Walk 0-23 looking for contiguous runs of active hours. If the run
  // wraps past midnight (active at 23 AND active at 0/1/2), merge them.
  const clusters: MealPeriodCluster[] = []
  let current: number[] = []

  function flush() {
    if (current.length === 0) return
    const hours = [...current]
    const peakHour = hours.reduce((best, h) => hourShare[h] > hourShare[best] ? h : best, hours[0])
    clusters.push({
      label:       labelMealPeriod(peakHour),
      hours,
      peak_hour:   peakHour,
      peak_share:  Math.round(hourShare[peakHour] * 1000) / 1000,
      total_share: Math.round(hours.reduce((s, h) => s + hourShare[h], 0) * 1000) / 1000,
    })
    current = []
  }

  for (let h = 0; h < 24; h++) {
    if (isActive[h]) current.push(h)
    else flush()
  }
  flush()

  // Late-night wrap: if last cluster ends at 23 and first cluster starts
  // at 0, merge them under a 'late' label.
  if (clusters.length >= 2) {
    const last  = clusters[clusters.length - 1]
    const first = clusters[0]
    if (last.hours[last.hours.length - 1] === 23 && first.hours[0] === 0) {
      const mergedHours = [...last.hours, ...first.hours]
      const mergedPeak  = mergedHours.reduce((best, h) => hourShare[h] > hourShare[best] ? h : best, mergedHours[0])
      const merged: MealPeriodCluster = {
        label:       'late',
        hours:       mergedHours,
        peak_hour:   mergedPeak,
        peak_share:  Math.round(hourShare[mergedPeak] * 1000) / 1000,
        total_share: Math.round(mergedHours.reduce((s, h) => s + hourShare[h], 0) * 1000) / 1000,
      }
      return [merged, ...clusters.slice(1, -1)]
    }
  }
  return clusters
}

function labelMealPeriod(peakHour: number): MealPeriodLabel {
  if (peakHour >= 5  && peakHour <= 8)  return 'breakfast'
  if (peakHour >= 9  && peakHour <= 11) return 'brunch'
  if (peakHour >= 12 && peakHour <= 15) return 'lunch'
  if (peakHour === 16)                  return 'afternoon'
  if (peakHour >= 17 && peakHour <= 21) return 'dinner'
  if (peakHour >= 22 || peakHour <= 2)  return 'late'
  return 'overnight'
}

// ── Main entry: single-hour forecast ─────────────────────────────────

export async function hourlyForecast(
  businessId: string,
  date:       Date,
  hour:       number,
  options:    { db?: any } = {},
): Promise<HourlyForecast> {
  const db = options.db ?? createAdminClient()
  const forecastDate = ymd(date)
  const targetWeekday = date.getUTCDay()

  // Cold-start check: count distinct dates with positive hourly data.
  // Below 180 days → short-history mode (tighter window, no recency multiplier).
  const probe = await db
    .from('hourly_metrics')
    .select('business_date', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .gt('revenue', 0)
  const totalDays = Number(probe.count ?? 0)
  const adaptive  = adaptiveRecencyParams(totalDays)

  const rows = await loadHourlyHistory(db, businessId, date, adaptive.baselineWindowWeeks)

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
    ? await computeMealPeriodScaler(db, businessId, date, mealForThisHour, rows)
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
): Promise<{ scaler: number; samples: number; raw: number }> {
  // This-week-so-far: pull all hourly rows since Monday of this week.
  const weekStart = mondayOf(forecastDate)
  const weekStartIso = ymd(weekStart)
  const forecastIso  = ymd(forecastDate)
  const { data: thisWeek } = await db
    .from('hourly_metrics')
    .select('business_date, hour, revenue')
    .eq('business_id', businessId)
    .gte('business_date', weekStartIso)
    .lt('business_date', forecastIso)
    .in('hour', cluster.hours)
  const completed = (thisWeek ?? []) as HourlyRow[]

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
