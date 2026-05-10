// lib/forecast/daily.ts
//
// THE consolidated daily revenue forecaster — Piece 2 of the prediction
// system rebuild. Replaces the per-surface ad-hoc math in
// /api/scheduling/ai-suggestion (revenue side) and lib/weather/demand.ts
// with one canonical function that produces:
//   - predicted_revenue (integer)
//   - 9 component breakdowns (weekday baseline, YoY anchor, weather lift,
//     weather change, holiday, klämdag, school holiday, salary cycle,
//     this-week scaler)
//   - inputs_snapshot in the consolidated_v1 shape (architecture §2)
//   - confidence label
//
// Phase A: builds alongside; both legacy forecasters keep running unchanged.
// Capture writes to daily_forecast_outcomes with surface='consolidated_daily'
// so the daily reconciler grades all three surfaces side-by-side. After
// 1-2 weeks of MAPE comparison, a per-business flag flip cuts each consumer
// over to dailyForecast() one at a time.
//
// See PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md Section 3 for the
// full computation logic and inputs_snapshot spec.

import { createAdminClient } from '@/lib/supabase/server'
import { weightedAvg, thisWeekScaler, RECENCY } from '@/lib/forecast/recency'
import { captureForecastOutcome } from '@/lib/forecast/audit'
import { getHolidaysForCountry, getUpcomingHolidays, type Holiday } from '@/lib/holidays'

// ── Public types ────────────────────────────────────────────────────────────

export interface DailyForecast {
  predicted_revenue: number
  baseline_revenue:  number
  components: {
    weekday_baseline:      number
    yoy_same_month_anchor: number | null
    weather_lift_pct:      number          // multiplicative factor as % delta (e.g. 1.08 → +8%)
    weather_change_pct:    number
    holiday_lift_pct:      number
    klamdag_pct:           number
    school_holiday_pct:    number
    salary_cycle_pct:      number
    this_week_scaler:      number
  }
  confidence:        'high' | 'medium' | 'low'
  inputs_snapshot:   ConsolidatedV1Snapshot
  model_version:     string
  snapshot_version:  'consolidated_v1'
}

export interface DailyForecastOptions {
  /** Skip the daily_forecast_outcomes capture write. Used by the
   *  one-time backfill script which writes resolved rows directly. */
  skipLogging?:         boolean
  /** Override model_version string. Used by experiments to compare
   *  variants without polluting the production model_version. */
  overrideModelVersion?: string
  /** "Rewind" date — every input source is filtered to data ≤ asOfDate.
   *  Lets the backfill script produce honest retrospective forecasts. */
  asOfDate?:            Date
  /** Bypass the audit helper's backtest write guard. ONLY set true from
   *  the backfill script; user-facing callers should leave this false
   *  so dashboard back-test reads don't pollute MAPE-by-horizon. */
  backfillMode?:        boolean
  /** Pre-built admin client. Saves a connection per call when the caller
   *  already has one (e.g. inside a cron loop). */
  db?:                  any
}

export interface ConsolidatedV1Snapshot {
  snapshot_version: 'consolidated_v1'
  model_version:    string

  weekday_baseline: {
    weekday:                       number   // 0-6 (Sun=0 per Date.getUTCDay)
    recency_weighted_avg:          number
    recent_28d_samples:            number
    older_samples:                 number
    recency_multiplier_applied:    number
    stddev:                        number
    anomaly_days_excluded:         number
  }

  yoy_same_weekday: {
    available: boolean
    reason?:   string
  } | {
    available: true
    weekday:   number
    revenue:   number
    samples:   number
  }

  yoy_same_month: {
    available: boolean
    reason?:   string
  } | {
    available:                    true
    lookup_month:                 string   // 'YYYY-MM'
    monthly_revenue:              number
    trailing_12m_growth_multiplier: number
    applied_as_baseline_anchor:   boolean
  }

  weather_forecast: {
    temp_max_c:  number | null
    temp_min_c:  number | null
    precip_mm:   number | null
    condition:   string | null
    bucket:      string | null
    source:      'open_meteo' | 'cached_history' | 'unavailable'
    fetched_at:  string | null
  }

  weather_lift: {
    factor:           number
    samples_used:     number
    min_samples_met:  boolean
    available:        boolean
    reason?:          string
  }

  weather_change_vs_seasonal: {
    available:       boolean
    reason?:         string
    applied_factor:  number
  }

  holiday: {
    is_holiday:    boolean
    name:          string | null
    kind:          string | null
    impact:        string | null
    lift_factor:   number
  }

  klamdag: {
    is_klamdag:               boolean
    adjacent_holiday_date:    string | null
    adjacent_holiday_name:    string | null
    samples_used:             number
    applied_factor:           number
    fallback_used?:           string
  }

  school_holiday: {
    active:          boolean
    name:            string | null
    kommun:          string | null
    lan:             string | null
    applied_factor:  number
  }

  salary_cycle: {
    day_of_month:    number
    days_since_25th: number
    days_until_25th: number
    phase:           'around_payday' | 'mid_month' | 'end_month'
    samples_used:    number
    applied_factor:  number
  }

  this_week_scaler: {
    raw:              number
    applied:          number
    clamped_at_max:   boolean
    clamped_at_min:   boolean
    scaler_floor:     number
    scaler_ceil:      number
  }

  anomaly_contamination: {
    checked:                                boolean
    contaminated_dates_in_baseline_window:  string[]
    owner_confirmed_count:                  number
    filter_predicate:                       string
  }

  data_quality_flags: string[]
}

// ── Constants ────────────────────────────────────────────────────────────────

const MODEL_VERSION_DEFAULT  = 'consolidated_v1.0.1'   // bumped for short-history mode (2026-05-10)
const SNAPSHOT_VERSION       = 'consolidated_v1' as const
const BASELINE_WINDOW_WEEKS  = 12   // mature businesses (≥180 days history)
const SHORT_HISTORY_WEEKS    = 4    // Vero-style cold-start adjustment
const SHORT_HISTORY_THRESHOLD_DAYS = 180
const HISTORY_DAYS_FOR_HIGH  = 180
const HISTORY_DAYS_FOR_MED   = 60

// Sample-size guardrails from architecture §3
const MIN_SAMPLES = {
  weekday_baseline:  4,
  weather_lift:      10,
  weather_change:    1,    // need ≥1 prior year same-week observation
  holiday:           1,
  klamdag:           2,
  school_holiday:    1,
  salary_cycle:      30,
} as const

const KLAMDAG_NATIONAL_DEFAULT = 0.90  // architecture §3 fallback

// Salary-cycle phase windows (Swedish convention: salary on the 25th)
function salaryPhase(dayOfMonth: number): 'around_payday' | 'end_month' | 'mid_month' {
  if (dayOfMonth >= 23 && dayOfMonth <= 27) return 'around_payday'
  if (dayOfMonth >= 28 || dayOfMonth <= 5)  return 'end_month'
  return 'mid_month'
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function dailyForecast(
  businessId: string,
  date:       Date,
  options:    DailyForecastOptions = {},
): Promise<DailyForecast> {
  const db        = options.db ?? createAdminClient()
  const asOfDate  = options.asOfDate ?? new Date()
  const forecastIso = ymd(date)
  const weekday   = date.getUTCDay()

  // ── Load business + history range ──────────────────────────────────
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id, name, country, kommun')
    .eq('id', businessId)
    .maybeSingle()
  if (!biz) throw new Error(`Business ${businessId} not found`)

  // Window for weekday baseline + this-week scaler
  const baselineFromDate = subtractDays(date, BASELINE_WINDOW_WEEKS * 7)
  const baselineFromIso  = ymd(baselineFromDate)
  // Cap reads at asOfDate so backfill is honest
  const asOfIso = ymd(asOfDate)

  // ── Parallel input loads ───────────────────────────────────────────
  const [
    dailyMetricsRes,
    monthlyMetricsRes,
    weatherDailyRes,
    confirmedAnomaliesRes,
  ] = await Promise.all([
    db.from('daily_metrics')
      .select('date, revenue, hours_worked, labour_pct')
      .eq('business_id', businessId)
      .gte('date', baselineFromIso)
      .lte('date', asOfIso)
      .order('date', { ascending: true }),

    // Last 14 months of monthly_metrics — covers same-month-last-year +
    // trailing 12-month growth multiplier.
    db.from('monthly_metrics')
      .select('year, month, revenue')
      .eq('business_id', businessId)
      .or(`year.lt.${date.getUTCFullYear()},and(year.eq.${date.getUTCFullYear()},month.lte.${date.getUTCMonth() + 1})`)
      .order('year', { ascending: false })
      .order('month', { ascending: false })
      .limit(14),

    db.from('weather_daily')
      .select('date, temp_max, temp_min, temp_avg, precip_mm, weather_code, summary, is_forecast')
      .eq('business_id', businessId)
      .gte('date', baselineFromIso),

    // Anomaly contamination check — confirmed revenue anomalies in the
    // baseline window get excluded from the weekday baseline.
    db.from('anomaly_alerts')
      .select('period_date')
      .eq('business_id', businessId)
      .in('alert_type', ['revenue_drop', 'revenue_spike'])
      .eq('confirmation_status', 'confirmed')
      .gte('period_date', baselineFromIso)
      .lte('period_date', asOfIso),
  ])

  const dailyMetrics    = dailyMetricsRes.data ?? []
  const monthlyMetrics  = monthlyMetricsRes.data ?? []
  const weatherDaily    = weatherDailyRes.data ?? []
  const contaminatedSet = new Set((confirmedAnomaliesRes.data ?? []).map((a: any) => a.period_date as string))

  // ── Detect short-history mode (cold-start protection) ──────────────
  // Vero (2026-05-10 diagnostic) showed +88% bias on Jan-Mar 2026 because
  // December's holiday peak got 2× weight in the recency window and
  // dominated the post-holiday months. For businesses with <180 days of
  // positive-revenue history we DON'T have enough data for the recency
  // weighting to be informative — it just amplifies whatever the most
  // recent month's pattern happened to be. Use a tighter unweighted
  // window in that case (last 28 days, multiplier=1.0).
  const totalHistoryDays = dailyMetrics.filter((r: any) => Number(r.revenue ?? 0) > 0).length
  const shortHistoryMode = totalHistoryDays < SHORT_HISTORY_THRESHOLD_DAYS

  // Effective baseline window + recency settings (per maturity)
  const effectiveBaselineWeeks = shortHistoryMode ? SHORT_HISTORY_WEEKS : BASELINE_WINDOW_WEEKS
  const effectiveRecencyMul    = shortHistoryMode ? 1.0 : RECENCY.RECENCY_MULTIPLIER
  const effectiveRecentWindow  = shortHistoryMode ? (SHORT_HISTORY_WEEKS * 7) : RECENCY.RECENT_WINDOW_DAYS
  const baselineCutoffMs       = asOfDate.getTime() - (effectiveBaselineWeeks * 7 * 86_400_000)

  // ── 1. Weekday baseline (recency-weighted, anomaly-filtered) ────────
  const weekdayMatches = dailyMetrics
    .filter((r: any) => Number(r.revenue ?? 0) > 0)
    .filter((r: any) => new Date(r.date + 'T12:00:00Z').getUTCDay() === weekday)
    .filter((r: any) => !contaminatedSet.has(r.date))
    // Short-history mode: tighter window (4 weeks instead of 12) so we
    // don't anchor on stale months that no longer represent the customer.
    .filter((r: any) => new Date(r.date + 'T12:00:00Z').getTime() >= baselineCutoffMs)

  const weekdayValues = weekdayMatches.map((r: any) => Number(r.revenue))
  const weekdayDates  = weekdayMatches.map((r: any) => r.date as string)
  const weekdayBaseline = weightedAvg(weekdayValues, weekdayDates, asOfDate, {
    recentWindowDays:  effectiveRecentWindow,
    recencyMultiplier: effectiveRecencyMul,
  })

  const recent28Cutoff = asOfDate.getTime() - RECENCY.RECENT_WINDOW_DAYS * 86_400_000
  const recent28Count  = weekdayDates.filter((d: string) => new Date(d + 'T12:00:00Z').getTime() >= recent28Cutoff).length
  const olderCount     = weekdayDates.length - recent28Count
  const stddev         = computeStddev(weekdayValues)

  // ── 2. YoY same-month anchor (architecture §3 step 4) ──────────────
  const yoySameMonthLookup = `${date.getUTCFullYear() - 1}-${pad2(date.getUTCMonth() + 1)}`
  const yoySameMonthRow = monthlyMetrics.find((m: any) =>
    m.year === date.getUTCFullYear() - 1 && m.month === date.getUTCMonth() + 1,
  )
  const yoyAvailable = !!yoySameMonthRow && Number(yoySameMonthRow?.revenue ?? 0) > 0
  let yoyAnchorMultiplier = 1.0
  let trailing12mGrowth = 1.0
  if (yoyAvailable) {
    // Trailing-12m growth: compare last 12 months sum vs prior 12 months sum
    const last12Sum  = sumLastN(monthlyMetrics, 12)
    const prior12Sum = sumLastN(monthlyMetrics, 12, 12)
    trailing12mGrowth = prior12Sum > 0 ? Math.max(0.5, Math.min(1.5, last12Sum / prior12Sum)) : 1.0
    // YoY anchor itself isn't applied as a multiplicative factor here —
    // it's reported in the snapshot for transparency. Future: weighted
    // blend with weekday baseline. For Piece 2 we keep weekday baseline
    // as the primary anchor and surface yoy as informational signal.
  }

  // ── 3. Weather + bucket lift ────────────────────────────────────────
  const weatherForecastRow = weatherDaily.find((w: any) => w.date === forecastIso)
  const weatherBucket = weatherForecastRow ? bucketFromWeather(weatherForecastRow) : null

  // Bucket lift: avg revenue in this bucket vs overall avg, from history
  const histWeather = new Map<string, any>()
  for (const w of weatherDaily) {
    if (w.is_forecast === false) histWeather.set(w.date, w)
  }
  const bucketRevPairs: Array<{ revenue: number; bucket: string; date: string }> = []
  for (const r of dailyMetrics) {
    if (Number(r.revenue ?? 0) <= 0) continue
    const w = histWeather.get(r.date)
    if (!w) continue
    bucketRevPairs.push({ revenue: Number(r.revenue), bucket: bucketFromWeather(w), date: r.date as string })
  }
  const overallAvgRev = bucketRevPairs.length > 0
    ? weightedAvg(
        bucketRevPairs.map(p => p.revenue),
        bucketRevPairs.map(p => p.date),
        asOfDate,
        { recentWindowDays: RECENCY.RECENT_WINDOW_DAYS, recencyMultiplier: RECENCY.RECENCY_MULTIPLIER },
      )
    : 0
  const bucketSubset = weatherBucket ? bucketRevPairs.filter(p => p.bucket === weatherBucket) : []
  const bucketAvgRev = bucketSubset.length > 0
    ? weightedAvg(
        bucketSubset.map(p => p.revenue),
        bucketSubset.map(p => p.date),
        asOfDate,
        { recentWindowDays: RECENCY.RECENT_WINDOW_DAYS, recencyMultiplier: RECENCY.RECENCY_MULTIPLIER },
      )
    : 0
  const weatherLiftAvailable = bucketSubset.length >= MIN_SAMPLES.weather_lift && overallAvgRev > 0
  const weatherLiftFactor = weatherLiftAvailable ? bucketAvgRev / overallAvgRev : 1.0

  // ── 4. Holiday detection ───────────────────────────────────────────
  const country = (biz.country ?? 'SE') as string
  const yearHolidays  = getHolidaysForCountry(country, date.getUTCFullYear())
  const holidayMatch  = yearHolidays.find(h => h.date === forecastIso) ?? null
  const holidayLiftFactor = holidayMatch?.impact === 'high' ? 1.15
                          : holidayMatch?.impact === 'low'  ? 0.40
                          : 1.0

  // ── 5. Klämdag (bridge day adjacent to holiday) ────────────────────
  // Look for a holiday within ±1 day of the forecast date that we're NOT
  // ON. If today is Mon and Tue is a holiday, we're a klämdag if Mon
  // is itself a workday (Mon-Fri).
  const klamdagInfo = computeKlamdag(date, yearHolidays)

  // ── 6. School holiday (deferred to Piece 3) ─────────────────────────
  // school_holidays table exists (M056 DDL) but isn't populated yet.
  // For Piece 2: always 1.0, mark as deferred.
  const schoolHolidayInfo = {
    active:         false as boolean,
    name:           null as string | null,
    applied_factor: 1.0,
  }

  // ── 7. Salary cycle ────────────────────────────────────────────────
  const dayOfMonth = date.getUTCDate()
  const phase      = salaryPhase(dayOfMonth)
  // Compute multiplier from history: avg revenue for this phase / overall avg
  let salaryCycleFactor = 1.0
  let salaryCycleSamples = 0
  if (dailyMetrics.length >= MIN_SAMPLES.salary_cycle) {
    const phaseValues: number[] = []
    const phaseDates:  string[] = []
    const allValues:   number[] = []
    const allDates:    string[] = []
    for (const r of dailyMetrics) {
      if (Number(r.revenue ?? 0) <= 0) continue
      const dom = new Date(r.date + 'T12:00:00Z').getUTCDate()
      const p   = salaryPhase(dom)
      allValues.push(Number(r.revenue))
      allDates.push(r.date as string)
      if (p === phase) {
        phaseValues.push(Number(r.revenue))
        phaseDates.push(r.date as string)
      }
    }
    salaryCycleSamples = phaseValues.length
    if (phaseValues.length >= 5 && allValues.length > 0) {
      const phaseAvg = weightedAvg(phaseValues, phaseDates, asOfDate, { recentWindowDays: RECENCY.RECENT_WINDOW_DAYS, recencyMultiplier: RECENCY.RECENCY_MULTIPLIER })
      const overall  = weightedAvg(allValues, allDates, asOfDate, { recentWindowDays: RECENCY.RECENT_WINDOW_DAYS, recencyMultiplier: RECENCY.RECENCY_MULTIPLIER })
      if (overall > 0) {
        salaryCycleFactor = Math.max(0.7, Math.min(1.3, phaseAvg / overall))
      }
    }
  }

  // ── 8. This-week scaler ────────────────────────────────────────────
  const weekStartIso = ymd(mondayOf(date))
  const weekEndIso   = ymd(sundayOf(date))
  const thisWeekActuals = dailyMetrics.filter((r: any) =>
    r.date >= weekStartIso && r.date <= weekEndIso && Number(r.revenue ?? 0) > 0,
  )
  // For each completed day, compute what we WOULD have predicted (weekday baseline only — no scaler recursion)
  const scalerPairs: Array<{ actual: number; predicted: number }> = []
  for (const a of thisWeekActuals) {
    if (a.date >= forecastIso) continue   // don't include the forecast day itself
    const adow = new Date(a.date + 'T12:00:00Z').getUTCDay()
    const dowMatches = dailyMetrics.filter((r: any) =>
      Number(r.revenue ?? 0) > 0 &&
      new Date(r.date + 'T12:00:00Z').getUTCDay() === adow &&
      r.date < a.date &&
      !contaminatedSet.has(r.date),
    )
    if (dowMatches.length === 0) continue
    const pred = weightedAvg(
      dowMatches.map((r: any) => Number(r.revenue)),
      dowMatches.map((r: any) => r.date as string),
      asOfDate,
      { recentWindowDays: RECENCY.RECENT_WINDOW_DAYS, recencyMultiplier: RECENCY.RECENCY_MULTIPLIER },
    )
    scalerPairs.push({ actual: Number(a.revenue), predicted: pred })
  }
  const scalerResult = thisWeekScaler(scalerPairs)

  // ── 9. Compose ─────────────────────────────────────────────────────
  let predicted = weekdayBaseline
  // Apply yoy-blended trend factor if available (architecture §3 step 4 —
  // current implementation: use trailing_12m_growth on the weekday baseline)
  if (yoyAvailable) {
    yoyAnchorMultiplier = trailing12mGrowth
    predicted *= yoyAnchorMultiplier
  }
  predicted *= weatherLiftFactor
  predicted *= 1.0   // weather_change_vs_seasonal — placeholder until Piece 3 ships seasonal norms
  predicted *= holidayLiftFactor
  predicted *= klamdagInfo.factor
  predicted *= schoolHolidayInfo.applied_factor
  predicted *= salaryCycleFactor
  predicted *= scalerResult.scaler

  const predictedInt = Math.max(0, Math.round(predicted))
  const baselineInt  = Math.max(0, Math.round(weekdayBaseline))

  // ── Confidence ─────────────────────────────────────────────────────
  const totalDaysOfHistory = dailyMetrics.filter((r: any) => Number(r.revenue ?? 0) > 0).length
  const signalsAvailable = [
    weekdayValues.length >= MIN_SAMPLES.weekday_baseline,
    yoyAvailable,
    weatherLiftAvailable,
    klamdagInfo.samples_used >= MIN_SAMPLES.klamdag || klamdagInfo.is_klamdag === false,
    salaryCycleSamples >= MIN_SAMPLES.salary_cycle / 5,  // partial credit
    holidayMatch !== null || true,  // holiday signal is binary; "no holiday" is itself a signal
  ].filter(Boolean).length

  let confidence: 'high' | 'medium' | 'low'
  if (signalsAvailable >= 5 && totalDaysOfHistory >= HISTORY_DAYS_FOR_HIGH) confidence = 'high'
  else if (signalsAvailable >= 3 && totalDaysOfHistory >= HISTORY_DAYS_FOR_MED) confidence = 'medium'
  else confidence = 'low'

  // ── Build inputs_snapshot ──────────────────────────────────────────
  const dataQualityFlags: string[] = []
  if (totalDaysOfHistory < 60)  dataQualityFlags.push('low_history')
  if (contaminatedSet.size > 0) dataQualityFlags.push('anomaly_window_uncertain')
  if (shortHistoryMode)         dataQualityFlags.push('short_history_mode_4w_unweighted')

  const snapshot: ConsolidatedV1Snapshot = {
    snapshot_version: SNAPSHOT_VERSION,
    model_version:    options.overrideModelVersion ?? MODEL_VERSION_DEFAULT,

    weekday_baseline: {
      weekday,
      recency_weighted_avg:       Math.round(weekdayBaseline),
      recent_28d_samples:         recent28Count,
      older_samples:              olderCount,
      recency_multiplier_applied: effectiveRecencyMul,
      stddev:                     Math.round(stddev),
      anomaly_days_excluded:      [...contaminatedSet].filter(d =>
        new Date(d + 'T12:00:00Z').getUTCDay() === weekday,
      ).length,
    },

    yoy_same_weekday: {
      available: false,
      reason:    'piece_2_uses_yoy_same_month_only — yoy_same_weekday lands in Piece 3 once Vero passes 2026-11-24',
    },

    yoy_same_month: yoyAvailable
      ? {
          available:                       true,
          lookup_month:                    yoySameMonthLookup,
          monthly_revenue:                 Number(yoySameMonthRow?.revenue ?? 0),
          trailing_12m_growth_multiplier:  Math.round(trailing12mGrowth * 1000) / 1000,
          applied_as_baseline_anchor:      true,
        }
      : {
          available: false,
          reason:    'no_revenue_in_same_month_last_year',
        },

    weather_forecast: weatherForecastRow
      ? {
          temp_max_c:  Number(weatherForecastRow.temp_max ?? 0) || null,
          temp_min_c:  Number(weatherForecastRow.temp_min ?? 0) || null,
          precip_mm:   Number(weatherForecastRow.precip_mm ?? 0) || 0,
          condition:   String(weatherForecastRow.summary ?? '') || null,
          bucket:      weatherBucket,
          source:      weatherForecastRow.is_forecast ? 'open_meteo' : 'cached_history',
          fetched_at:  null,
        }
      : {
          temp_max_c:  null, temp_min_c: null, precip_mm: null, condition: null, bucket: null,
          source:      'unavailable',
          fetched_at:  null,
        },

    weather_lift: {
      factor:           Math.round(weatherLiftFactor * 100) / 100,
      samples_used:     bucketSubset.length,
      min_samples_met:  bucketSubset.length >= MIN_SAMPLES.weather_lift,
      available:        weatherLiftAvailable,
      reason:           weatherLiftAvailable ? undefined : 'insufficient_bucket_samples',
    },

    weather_change_vs_seasonal: {
      available:      false,
      reason:         'piece_3_seasonal_norms_pending',
      applied_factor: 1.0,
    },

    holiday: {
      is_holiday:  holidayMatch !== null,
      name:        holidayMatch?.name_sv ?? null,
      kind:        holidayMatch?.kind ?? null,
      impact:      holidayMatch?.impact ?? null,
      lift_factor: holidayLiftFactor,
    },

    klamdag: {
      is_klamdag:            klamdagInfo.is_klamdag,
      adjacent_holiday_date: klamdagInfo.adjacent_holiday_date,
      adjacent_holiday_name: klamdagInfo.adjacent_holiday_name,
      samples_used:          klamdagInfo.samples_used,
      applied_factor:        klamdagInfo.factor,
      fallback_used:         klamdagInfo.fallback_used,
    },

    school_holiday: {
      active:          schoolHolidayInfo.active,
      name:            schoolHolidayInfo.name,
      kommun:          biz.kommun ?? null,
      lan:             null,
      applied_factor:  schoolHolidayInfo.applied_factor,
    },

    salary_cycle: {
      day_of_month:    dayOfMonth,
      days_since_25th: dayOfMonth >= 25 ? dayOfMonth - 25 : (dayOfMonth + 30 - 25),
      days_until_25th: dayOfMonth <= 25 ? 25 - dayOfMonth : (25 + 30 - dayOfMonth),
      phase,
      samples_used:    salaryCycleSamples,
      applied_factor:  Math.round(salaryCycleFactor * 100) / 100,
    },

    this_week_scaler: {
      raw:              Math.round(scalerResult.raw * 100) / 100,
      applied:          Math.round(scalerResult.scaler * 100) / 100,
      clamped_at_max:   scalerResult.scaler === RECENCY.SCALER_CEIL,
      clamped_at_min:   scalerResult.scaler === RECENCY.SCALER_FLOOR,
      scaler_floor:     RECENCY.SCALER_FLOOR,
      scaler_ceil:      RECENCY.SCALER_CEIL,
    },

    anomaly_contamination: {
      checked:                                true,
      contaminated_dates_in_baseline_window:  Array.from(contaminatedSet) as string[],
      owner_confirmed_count:                  contaminatedSet.size,
      filter_predicate:                       "alert_type IN ('revenue_drop','revenue_spike') AND confirmation_status = 'confirmed'",
    },

    data_quality_flags: dataQualityFlags,
  }

  // ── Capture via Piece 1 helper (unless skipped) ────────────────────
  if (!options.skipLogging) {
    await captureForecastOutcome({
      org_id:            biz.org_id,
      business_id:       businessId,
      forecast_date:     forecastIso,
      surface:           'consolidated_daily',
      predicted_revenue: predictedInt,
      baseline_revenue:  baselineInt,
      model_version:     options.overrideModelVersion ?? MODEL_VERSION_DEFAULT,
      snapshot_version:  SNAPSHOT_VERSION,
      inputs_snapshot:   snapshot as unknown as Record<string, unknown>,
      confidence,
    }, { backfillMode: options.backfillMode, db })
  }

  return {
    predicted_revenue: predictedInt,
    baseline_revenue:  baselineInt,
    components: {
      weekday_baseline:      Math.round(weekdayBaseline),
      yoy_same_month_anchor: yoyAvailable ? yoyAnchorMultiplier : null,
      weather_lift_pct:      Math.round(weatherLiftFactor * 100) / 100,
      weather_change_pct:    1.0,
      holiday_lift_pct:      holidayLiftFactor,
      klamdag_pct:           klamdagInfo.factor,
      school_holiday_pct:    schoolHolidayInfo.applied_factor,
      salary_cycle_pct:      Math.round(salaryCycleFactor * 100) / 100,
      this_week_scaler:      Math.round(scalerResult.scaler * 100) / 100,
    },
    confidence,
    inputs_snapshot:   snapshot,
    model_version:     options.overrideModelVersion ?? MODEL_VERSION_DEFAULT,
    snapshot_version:  SNAPSHOT_VERSION,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}
function subtractDays(d: Date, days: number): Date {
  const out = new Date(d)
  out.setUTCDate(out.getUTCDate() - days)
  return out
}
function mondayOf(d: Date): Date {
  const out = new Date(d)
  const day = out.getUTCDay() || 7
  out.setUTCDate(out.getUTCDate() - (day - 1))
  out.setUTCHours(0, 0, 0, 0)
  return out
}
function sundayOf(d: Date): Date {
  const m = mondayOf(d)
  const out = new Date(m)
  out.setUTCDate(m.getUTCDate() + 6)
  return out
}
function computeStddev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (values.length - 1)
  return Math.sqrt(variance)
}
function sumLastN(monthly: any[], n: number, skip = 0): number {
  // monthly is sorted descending by year+month; sum entries [skip, skip+n)
  const slice = monthly.slice(skip, skip + n)
  return slice.reduce((s, m) => s + Number(m.revenue ?? 0), 0)
}

// Weather bucket — mirrors lib/weather/forecast.ts's classification but
// inlined here to keep daily.ts self-contained. If we evolve the bucket
// taxonomy, sync both files. Common buckets: clear, mild, cold_dry, wet,
// snow, freezing, hot, thunder.
function bucketFromWeather(w: any): string {
  const tempMax = Number(w.temp_max ?? w.temp_avg ?? 0)
  const precip  = Number(w.precip_mm ?? 0)
  const code    = Number(w.weather_code ?? 0)
  if (code >= 95)               return 'thunder'
  if (code >= 71 && code <= 77) return 'snow'
  if (precip >= 5)              return 'wet'
  if (tempMax >= 25)            return 'hot'
  if (tempMax <= 0)             return 'freezing'
  if (tempMax <= 8)             return 'cold_dry'
  if (tempMax >= 18)            return 'clear'
  return 'mild'
}

function computeKlamdag(date: Date, holidays: Holiday[]): {
  is_klamdag:            boolean
  adjacent_holiday_date: string | null
  adjacent_holiday_name: string | null
  samples_used:          number
  factor:                number
  fallback_used?:        string
} {
  const dow = date.getUTCDay()
  // Klämdag only on workdays (Mon-Fri)
  if (dow === 0 || dow === 6) {
    return { is_klamdag: false, adjacent_holiday_date: null, adjacent_holiday_name: null, samples_used: 0, factor: 1.0 }
  }
  // Skip if today is itself a holiday
  const isoToday = ymd(date)
  if (holidays.some(h => h.date === isoToday)) {
    return { is_klamdag: false, adjacent_holiday_date: null, adjacent_holiday_name: null, samples_used: 0, factor: 1.0 }
  }
  // Look at adjacent days (yesterday, tomorrow)
  const yest = ymd(subtractDays(date, 1))
  const tom  = ymd(subtractDays(date, -1))
  const adj  = holidays.find(h => h.date === yest || h.date === tom)
  if (!adj) {
    return { is_klamdag: false, adjacent_holiday_date: null, adjacent_holiday_name: null, samples_used: 0, factor: 1.0 }
  }
  // Klämdag detected. Without prior klämdag history (Piece 3 will track
  // these properly), fall back to the national default factor.
  return {
    is_klamdag:            true,
    adjacent_holiday_date: adj.date,
    adjacent_holiday_name: adj.name_sv,
    samples_used:          0,
    factor:                KLAMDAG_NATIONAL_DEFAULT,
    fallback_used:         `national_default_${KLAMDAG_NATIONAL_DEFAULT}`,
  }
}
