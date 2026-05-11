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
import { getActiveSchoolHoliday } from '@/lib/forecast/school-holidays'

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
    /** Count of baseline candidates that were inside the Christmas
     *  holiday window (Dec 20 - Jan 6) and got dropped because the
     *  forecast date was outside that window in short-history mode.
     *  0 when the filter wasn't eligible or didn't fire. */
    holiday_samples_excluded:      number
    /** True when at least one sample was actually filtered (i.e. the
     *  filter was eligible AND the post-filter sample count cleared
     *  the minimum-samples safety threshold). */
    holiday_filter_active:         boolean
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

const MODEL_VERSION_DEFAULT  = 'consolidated_v1.3.0'   // 2026-05-11: cold-start holiday-period exclusion — when forecasting outside Dec 20-Jan 6 in short-history mode, exclude same-period samples from the weekday baseline so December Christmas-week peaks don't anchor January regular-trading predictions
const SNAPSHOT_VERSION       = 'consolidated_v1' as const
const BASELINE_WINDOW_WEEKS  = 12   // mature businesses (≥180 days history)
const SHORT_HISTORY_WEEKS    = 4    // Vero-style cold-start adjustment
const SHORT_HISTORY_THRESHOLD_DAYS = 180
const HISTORY_DAYS_FOR_HIGH  = 180
const HISTORY_DAYS_FOR_MED   = 60

// Cold-start holiday-period exclusion window. Swedish restaurant revenue
// in late December is a different regime (Christmas / New Year peaks +
// klamdag squeeze days + Jullov school break) that doesn't continue into
// regular January trading. When the 4-week short-history baseline window
// straddles the year boundary, December samples dominate the average and
// inflate January predictions by 2-5×.
//
// Solution: when forecasting OUTSIDE this window in short-history mode,
// drop any baseline samples that fall INSIDE it. Forecasts that are
// themselves inside the window (e.g. forecasting Dec 27 from a Dec 6
// start) keep the holiday samples as peer evidence.
//
// Window: Dec 20 - Jan 6 inclusive. Captures the lead-up to Christmas
// (last shopping Saturdays, Lucia work-do peaks), Christmas week itself,
// New Year, and Trettondedag jul (Jan 6).
//
// Filter only applies in short-history mode (≤ 180 days history). Once
// the business has a full year, the 12-week mature window doesn't reach
// back to the prior December anyway, AND yoy_same_weekday + the proper
// recency-weighted average handle seasonal transitions correctly.
const HOLIDAY_PERIOD_START_MONTH = 11   // December (0-indexed)
const HOLIDAY_PERIOD_START_DAY   = 20
const HOLIDAY_PERIOD_END_MONTH   = 0    // January
const HOLIDAY_PERIOD_END_DAY     = 6
const HOLIDAY_FILTER_MIN_SAMPLES = 2    // below this, fall back to unfiltered to avoid 1-sample noise

function isInHolidayPeriod(d: Date): boolean {
  const month = d.getUTCMonth()
  const day   = d.getUTCDate()
  if (month === HOLIDAY_PERIOD_START_MONTH && day >= HOLIDAY_PERIOD_START_DAY) return true
  if (month === HOLIDAY_PERIOD_END_MONTH   && day <= HOLIDAY_PERIOD_END_DAY)   return true
  return false
}

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
  const contaminatedSet: Set<string> = new Set((confirmedAnomaliesRes.data ?? []).map((a: any) => a.period_date as string))

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
  const baseWeekdayMatches = dailyMetrics
    .filter((r: any) => Number(r.revenue ?? 0) > 0)
    .filter((r: any) => new Date(r.date + 'T12:00:00Z').getUTCDay() === weekday)
    .filter((r: any) => !contaminatedSet.has(r.date))
    // Short-history mode: tighter window (4 weeks instead of 12) so we
    // don't anchor on stale months that no longer represent the customer.
    .filter((r: any) => new Date(r.date + 'T12:00:00Z').getTime() >= baselineCutoffMs)

  // Cold-start holiday-period exclusion (only matters in short-history
  // mode for forecasts in early Jan / late Dec). When the forecast date
  // is OUTSIDE the Christmas holiday window but the baseline would
  // include samples that ARE inside it, those samples represent a
  // different revenue regime and inflate the average. Drop them.
  const forecastInHolidayPeriod = isInHolidayPeriod(date)
  const holidayFilterEligible   = shortHistoryMode && !forecastInHolidayPeriod
  const filteredCandidates      = holidayFilterEligible
    ? baseWeekdayMatches.filter((r: any) => !isInHolidayPeriod(new Date(r.date + 'T12:00:00Z')))
    : baseWeekdayMatches

  // Safety: if the filter removes too much, fall back to the unfiltered
  // set. 1-sample baselines are worse than a holiday-contaminated 4-sample
  // baseline because a single weekday observation has no variance signal.
  const holidayFilterApplied = holidayFilterEligible && filteredCandidates.length >= HOLIDAY_FILTER_MIN_SAMPLES
  const weekdayMatches       = holidayFilterApplied ? filteredCandidates : baseWeekdayMatches
  const holidayFilterFellBack = holidayFilterEligible && !holidayFilterApplied
  const holidaySamplesExcluded = holidayFilterApplied
    ? baseWeekdayMatches.length - filteredCandidates.length
    : 0

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
    // Trailing-12m growth: compare last 12 months sum vs prior 12 months sum.
    // COLD-START GUARD (v1.2.0): when prior12Sum is missing or trivial (the
    // business simply has no real prior-year comparable), the ratio explodes
    // and the clamp pins it at 1.5× — silently inflating every cold-start
    // forecast by 50%. The Piece 4 backtest (2026-05-10) showed this was the
    // dominant cause of Vero's +200% January bias: she has Jan 2025 revenue
    // (so yoyAvailable=true) but no real Feb-Dec 2024 history, so last12Sum
    // dwarfs prior12Sum and the multiplier hits ceiling. The deterministic
    // forecaster cannot extrapolate growth from non-comparable history —
    // skip the multiplier in short-history mode AND when prior12Sum is less
    // than 50% of last12Sum (indicating partial-year baseline).
    const last12Sum  = sumLastN(monthlyMetrics, 12)
    const prior12Sum = sumLastN(monthlyMetrics, 12, 12)
    const priorIsComparable = prior12Sum > 0 && prior12Sum >= last12Sum * 0.5
    if (!shortHistoryMode && priorIsComparable) {
      trailing12mGrowth = Math.max(0.5, Math.min(1.5, last12Sum / prior12Sum))
    } else {
      trailing12mGrowth = 1.0   // cold-start: no inflation
    }
  }

  // ── 2b. YoY same-weekday (Piece 3 — activates at 365+ days history) ─
  // For a forecast on (e.g.) 2026-05-15 Friday, look up 2025-05-16 Friday
  // (52 weeks back, same weekday). When available, blend 30% with the
  // weekday baseline. Vero won't activate this until 2026-11-24; Chicce
  // hits 1 year mid-May 2026 so this engages for her.
  const yoyTarget = subtractDays(date, 364)
  const yoyTargetIso = ymd(yoyTarget)
  const yoyDailyRow = dailyMetrics.find((r: any) => r.date === yoyTargetIso && Number(r.revenue ?? 0) > 0)
  const yoySameWeekdayAvailable = !!yoyDailyRow
  const yoySameWeekdayValue = yoySameWeekdayAvailable ? Number(yoyDailyRow.revenue) : 0

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

  // ── 3b. Weather change vs seasonal norm (Piece 3) ──────────────────
  // For a forecast date, compare its temperature to the same calendar
  // week in prior years. Unusually warm = revenue lift (terrace traffic);
  // unusually cold/wet = small dampening. Asymmetric — heat boosts more
  // than cold dampens (restaurant industry pattern). Default 1.0 when
  // history is too thin.
  let weatherChangeFactor = 1.0
  let weatherChangeAvailable = false
  let weatherChangeReason: string | undefined = 'piece_3_seasonal_norms_pending'
  let weatherChangeDetail: { current_temp: number | null; seasonal_norm: number | null; deviation_c: number | null; samples_used: number } = {
    current_temp: null, seasonal_norm: null, deviation_c: null, samples_used: 0,
  }
  if (weatherForecastRow) {
    const currentTemp = Number(weatherForecastRow.temp_max ?? weatherForecastRow.temp_avg ?? 0) || null
    if (currentTemp != null) {
      const sameWeekSamples: number[] = []
      for (let yearsBack = 1; yearsBack <= 3; yearsBack++) {
        const targetDate = subtractDays(date, yearsBack * 365)
        for (let offset = -3; offset <= 3; offset++) {
          const probeIso = ymd(subtractDays(targetDate, -offset))
          const w = histWeather.get(probeIso)
          if (!w) continue
          const t = Number(w.temp_max ?? w.temp_avg ?? 0)
          if (Number.isFinite(t) && t !== 0) sameWeekSamples.push(t)
        }
      }
      if (sameWeekSamples.length >= 3) {
        const seasonalNorm = sameWeekSamples.reduce((s, v) => s + v, 0) / sameWeekSamples.length
        const deviation = currentTemp - seasonalNorm
        let factor = 1.0
        if (deviation > 0)      factor = 1.0 + Math.min(deviation * 0.01, 0.10)
        else if (deviation < 0) factor = 1.0 + Math.max(deviation * 0.006, -0.08)
        weatherChangeFactor = Math.round(factor * 100) / 100
        weatherChangeAvailable = true
        weatherChangeReason = undefined
        weatherChangeDetail = {
          current_temp:  Math.round(currentTemp * 10) / 10,
          seasonal_norm: Math.round(seasonalNorm * 10) / 10,
          deviation_c:   Math.round(deviation * 10) / 10,
          samples_used:  sameWeekSamples.length,
        }
      } else {
        weatherChangeReason = `insufficient_history_${sameWeekSamples.length}_samples_need_3`
      }
    } else {
      weatherChangeReason = 'forecast_temp_missing'
    }
  } else {
    weatherChangeReason = 'no_weather_forecast_for_date'
  }

  // ── 4. Holiday detection ───────────────────────────────────────────
  const country = (biz.country ?? 'SE') as string
  const yearHolidays  = getHolidaysForCountry(country, date.getUTCFullYear())
  const holidayMatch  = yearHolidays.find(h => h.date === forecastIso) ?? null
  const holidayLiftFactor = holidayMatch?.impact === 'high' ? 1.15
                          : holidayMatch?.impact === 'low'  ? 0.40
                          : 1.0

  // ── 5. Klämdag (bridge day adjacent to holiday) ────────────────────
  // Look for a holiday within ±1 day of the forecast date. Then for the
  // factor: query history for prior klämdag observations (≥2 needed) and
  // use the median ratio vs same-weekday non-klämdag baseline. Falls back
  // to KLAMDAG_NATIONAL_DEFAULT (0.90) when history is too thin.
  // Pass prior 2 years of holidays so we can detect historical klämdag dates.
  const priorYearHolidays = [
    ...getHolidaysForCountry(country, date.getUTCFullYear() - 1),
    ...getHolidaysForCountry(country, date.getUTCFullYear() - 2),
  ]
  const allHolidays = [...yearHolidays, ...priorYearHolidays]
  const klamdagInfo = computeKlamdag(date, allHolidays, dailyMetrics, contaminatedSet)

  // ── 6. School holiday (Piece 3 — populated from M056 + M067 seed) ───
  // Lookup against school_holidays table for the business's kommun. If
  // no kommun is set OR the business is outside our seed coverage, we
  // get a null result and fall back to the neutral 1.0 factor.
  const schoolHolidayMatch = await getActiveSchoolHoliday(db, biz.kommun ?? null, date)
  const schoolHolidayInfo = schoolHolidayMatch
    ? {
        active:         true,
        name:           schoolHolidayMatch.name,
        applied_factor: schoolHolidayMatch.applied_factor,
      }
    : {
        active:         false,
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
  // Step 1: apply YoY same-weekday blend (when 1+ year history). 30% YoY +
  // 70% weekday-baseline. This catches seasonal transitions that the
  // weekday baseline alone misses (post-holiday dips, summer drops, etc.)
  // — exactly the architecture's self-healing path for Vero's January
  // problem once she hits 2026-11-24.
  let blendedBaseline = weekdayBaseline
  if (yoySameWeekdayAvailable && yoySameWeekdayValue > 0) {
    blendedBaseline = weekdayBaseline * 0.7 + yoySameWeekdayValue * 0.3
  }
  let predicted = blendedBaseline
  // Step 2: apply yoy-monthly trailing growth multiplier
  if (yoyAvailable) {
    yoyAnchorMultiplier = trailing12mGrowth
    predicted *= yoyAnchorMultiplier
  }
  predicted *= weatherLiftFactor
  predicted *= weatherChangeFactor   // Piece 3 — multi-year seasonal weather norm comparison
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
  if (totalDaysOfHistory < 60)   dataQualityFlags.push('low_history')
  if (contaminatedSet.size > 0)  dataQualityFlags.push('anomaly_window_uncertain')
  if (shortHistoryMode)          dataQualityFlags.push('short_history_mode_4w_unweighted')
  if (holidayFilterApplied)      dataQualityFlags.push('cold_start_holiday_samples_excluded')
  if (holidayFilterFellBack)     dataQualityFlags.push('cold_start_holiday_filter_fellback_too_few_samples')

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
      holiday_samples_excluded:   holidaySamplesExcluded,
      holiday_filter_active:      holidayFilterApplied,
    },

    yoy_same_weekday: yoySameWeekdayAvailable
      ? {
          available: true as const,
          weekday,
          revenue:   Math.round(yoySameWeekdayValue),
          samples:   1,
        } as any
      : {
          available: false,
          reason:    `no_revenue_for_${yoyTargetIso}_in_history — needs 365+ days for this signal`,
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
      available:      weatherChangeAvailable,
      reason:         weatherChangeReason,
      applied_factor: weatherChangeFactor,
      ...(weatherChangeAvailable ? weatherChangeDetail : {}),
    } as any,

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
      weather_change_pct:    weatherChangeFactor,
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

function computeKlamdag(
  date:            Date,
  holidays:        Holiday[],
  dailyMetrics:    any[],
  contaminatedSet: Set<string>,
): {
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

  // Klämdag detected. Look at history (Piece 3) — for every PRIOR date
  // in dailyMetrics that was ALSO a klämdag (workday adjacent to a
  // holiday in our holidays list), compute its actual revenue ratio
  // against the same-weekday baseline. Median of ≥2 samples = our
  // klamdag factor; fewer samples = national default.
  const holidayDateSet = new Set(holidays.map(h => h.date))
  const isWorkday = (d: Date) => {
    const dd = d.getUTCDay()
    return dd >= 1 && dd <= 5
  }
  const isKlamdagHistoric = (d: Date): boolean => {
    if (!isWorkday(d)) return false
    const isoD = ymd(d)
    if (holidayDateSet.has(isoD)) return false
    const yIso = ymd(subtractDays(d, 1))
    const tIso = ymd(subtractDays(d, -1))
    return holidayDateSet.has(yIso) || holidayDateSet.has(tIso)
  }

  // Build per-weekday baseline from non-klämdag, non-contaminated days
  // so we can compute "actual / baseline" ratios for each prior klämdag.
  const baselineByWeekday: Record<number, number[]> = {}
  for (const r of dailyMetrics) {
    const rev = Number(r.revenue ?? 0)
    if (rev <= 0) continue
    if (contaminatedSet.has(r.date)) continue
    const rd = new Date(r.date + 'T12:00:00Z')
    if (isKlamdagHistoric(rd)) continue   // exclude klämdag from baseline
    const dw = rd.getUTCDay()
    if (!baselineByWeekday[dw]) baselineByWeekday[dw] = []
    baselineByWeekday[dw].push(rev)
  }
  const baselineMedian = (dw: number): number | null => {
    const arr = baselineByWeekday[dw]
    if (!arr || arr.length === 0) return null
    const sorted = [...arr].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }

  // Collect klämdag observations and their ratios
  const ratios: number[] = []
  for (const r of dailyMetrics) {
    const rev = Number(r.revenue ?? 0)
    if (rev <= 0) continue
    if (contaminatedSet.has(r.date)) continue
    const rd = new Date(r.date + 'T12:00:00Z')
    if (!isKlamdagHistoric(rd)) continue
    const baseline = baselineMedian(rd.getUTCDay())
    if (!baseline || baseline <= 0) continue
    ratios.push(rev / baseline)
  }

  if (ratios.length >= 2) {
    const sorted = [...ratios].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    // Sanity-clamp: factor should be between 0.5 and 1.5. If history is
    // wild, fall back to the national default — extreme historical
    // ratios usually indicate noise (single anomalous day) not signal.
    const clamped = Math.max(0.5, Math.min(1.5, median))
    return {
      is_klamdag:            true,
      adjacent_holiday_date: adj.date,
      adjacent_holiday_name: adj.name_sv,
      samples_used:          ratios.length,
      factor:                Math.round(clamped * 1000) / 1000,
    }
  }

  // Insufficient history — national default
  return {
    is_klamdag:            true,
    adjacent_holiday_date: adj.date,
    adjacent_holiday_name: adj.name_sv,
    samples_used:          ratios.length,
    factor:                KLAMDAG_NATIONAL_DEFAULT,
    fallback_used:         `national_default_${KLAMDAG_NATIONAL_DEFAULT}`,
  }
}
