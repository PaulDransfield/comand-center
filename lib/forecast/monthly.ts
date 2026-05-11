// lib/forecast/monthly.ts
//
// Piece 5 — Monthly consolidated forecaster. Replaces the legacy
// rolling-avg × hardcoded-seasonal-factor math at lib/sync/engine.ts:1070
// that the memory `feedback_budget_ai_historical_anchor.md` specifically
// warns against ("NEVER assume generic seasonality. Anchoring on forecasts
// causes overstaffing = cash burn.").
//
// Three computation paths, picked in priority order:
//
//   A. YoY-anchored (high confidence)
//      When same-month-last-year revenue exists AND prior 12m / last 12m
//      both have non-trivial sums (≥50% comparability), anchor on YoY actual
//      and apply a clamped trailing-12-month growth multiplier. Growth
//      multiplier is bounded to [0.85, 1.15] per memory — never extrapolate
//      a steep YoY growth trend onto the future.
//
//   B. Daily-aggregate (medium confidence) — cold-start near-horizon
//      No YoY, but the month being forecast is within ~90 days from today.
//      Sum `dailyForecast()` predicted_revenue across every day of the
//      month. Each day inherits Piece 2's full signal stack (weekday
//      baseline, weather where available, holiday filter, klamdag, school
//      holiday, salary cycle, this-week scaler). Slower (30+ inner calls)
//      but strictly better than industry-generic seasonal factors.
//
//   C. Weekday-extrapolation (low confidence) — cold-start far-horizon
//      No YoY AND the month is >90 days out. Daily-aggregate would be
//      slow + weather-blind anyway. Compute weekday-of-month counts for
//      the target month × per-weekday baseline from history. No hardcoded
//      seasonal factor — the prediction is honestly "what your typical
//      week looks like, summed". Confidence='low' flags this to consumers
//      so the budget AI can apply caution.
//
// Costs (staff / food / other) — common to all three paths:
//   - Derive median per-business ratios from the last 6 closed months
//     (`tracker_data` with `is_provisional` filter + `monthly_metrics`).
//   - Apply ratio × forecast_revenue.
//   - Floor food_cost at 28% of revenue (memory `feedback_budget_ai_extras.md`).
//   - Soft-cap staff_cost at the business's `target_staff_pct + 5pp` so a
//     temporarily-broken sync month doesn't anchor an overstaffed forecast.
//
// Capture: writes to the existing `forecasts` table (the same one the
// `/forecast` page, `/budgets` page, and budget AI generator already read
// from). The legacy `method` field is set to `consolidated_monthly_v1.0:<path>`
// so we can audit which calculation produced each row.

import { dailyForecast } from '@/lib/forecast/daily'

// ── Public types ───────────────────────────────────────────────────────────

export interface MonthlyForecast {
  business_id:        string
  period_year:        number
  period_month:       number
  revenue_forecast:   number
  staff_cost_forecast: number
  food_cost_forecast: number
  other_cost_forecast: number
  net_profit_forecast: number
  margin_forecast:    number
  confidence:         number   // 0-1 scale to match existing `forecasts.confidence`
  method:             string   // 'consolidated_monthly_v1.0:yoy_anchored' | ...
  based_on_months:    number
  inputs_snapshot:    MonthlyV1Snapshot
  model_version:      string
}

export interface MonthlyV1Snapshot {
  snapshot_version:   'monthly_v1'
  path:               'yoy_anchored' | 'daily_aggregate' | 'weekday_extrapolation'
  revenue: {
    method_detail:    string
    yoy_same_month?:  {
      year:           number
      revenue:        number
      growth_multiplier_raw:     number
      growth_multiplier_applied: number
      clamped:        boolean
    }
    daily_aggregate?: {
      days_in_month:  number
      days_with_forecast: number
      mean_daily_forecast: number
      sum_predicted:  number
    }
    weekday_extrapolation?: {
      weekday_baselines: Record<string, number>   // 'Mon' → kr
      weekday_counts_in_month: Record<string, number>
    }
  }
  costs: {
    method:           string
    sample_months:    number
    staff_ratio:      number   // staff_cost / revenue median over sample
    food_ratio:       number
    other_ratio:      number
    food_floored:     boolean  // memory floor (28%) was hit
    staff_capped:     boolean  // business target + 5pp cap was hit
    business_target_staff_pct: number | null
    business_target_food_pct:  number | null
  }
  cold_start_mode:    boolean   // <180 days history
  data_quality_flags: string[]
}

export interface MonthlyForecastOptions {
  /** Pre-built admin client. Saves a connection per call. */
  db?:                any
  /** Override the "today" reference (for backtest). Default new Date(). */
  asOfDate?:          Date
  /** Skip the dailyForecast aggregation path even when in range — used
   *  by tests / benchmarks that don't want the deep DB cost. */
  skipDailyAggregate?: boolean
}

// ── Constants ─────────────────────────────────────────────────────────────

const MODEL_VERSION_DEFAULT = 'consolidated_monthly_v1.0'
const SNAPSHOT_VERSION      = 'monthly_v1' as const

// Per memory feedback_budget_ai_historical_anchor.md — clamp YoY growth so
// a fluky last-12-months trend doesn't push the forecast to the moon.
const GROWTH_MULTIPLIER_MIN = 0.85
const GROWTH_MULTIPLIER_MAX = 1.15

// YoY comparability gate — if prior 12m is < 50% of last 12m, the YoY
// anchor is on too-thin-history. Better to fall back to cold-start paths.
const YOY_COMPARABILITY_MIN = 0.5

// Cold-start vs mature switch (matches Piece 2's threshold)
const SHORT_HISTORY_THRESHOLD_DAYS = 180

// Daily-aggregate path only fires for months within this horizon. Beyond
// that, weather forecasts are unavailable anyway and the aggregate becomes
// expensive without proportional accuracy gain.
const DAILY_AGGREGATE_HORIZON_DAYS = 90

// Cost ratio sample window — last N closed months feed the median.
const COST_RATIO_SAMPLE_MONTHS = 6

// Per memory feedback_budget_ai_extras.md — food cost floor 28-32%. Use 28%.
const FOOD_RATIO_FLOOR = 0.28
const FOOD_RATIO_CEIL  = 0.50   // safety: anything above is almost certainly bad data

// Soft-cap staff at business target + buffer. If no target set, use 35% (industry).
const STAFF_RATIO_HEADROOM_PP = 0.05   // 5pp
const STAFF_RATIO_INDUSTRY_DEFAULT = 0.35

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// ── Public entry point ────────────────────────────────────────────────────

export async function monthlyForecast(
  businessId: string,
  year:       number,
  month:      number,   // 1-12
  options:    MonthlyForecastOptions = {},
): Promise<MonthlyForecast> {
  if (month < 1 || month > 12) throw new Error(`monthlyForecast: invalid month ${month}`)
  const { createAdminClient } = await import('@/lib/supabase/server')
  const db    = options.db ?? createAdminClient()
  const asOf  = options.asOfDate ?? new Date()

  // ── Load business + history in parallel ──────────────────────────────
  const [bizRes, mmRes, trRes, dmCountRes] = await Promise.all([
    db.from('businesses')
      .select('id, org_id, target_food_pct, target_staff_pct')
      .eq('id', businessId)
      .maybeSingle(),

    db.from('monthly_metrics')
      .select('year, month, revenue, staff_cost, food_cost, other_cost, net_profit')
      .eq('business_id', businessId)
      .order('year').order('month'),

    db.from('tracker_data')
      .select('period_year, period_month, revenue, staff_cost, food_cost, other_cost, net_profit, is_provisional')
      .eq('business_id', businessId)
      .or('is_provisional.is.null,is_provisional.eq.false')
      .order('period_year').order('period_month'),

    db.from('daily_metrics')
      .select('date', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .gt('revenue', 0),
  ])

  if (!bizRes.data) {
    throw new Error(`monthlyForecast: business ${businessId} not found`)
  }
  const biz = bizRes.data
  const dailyPositiveDays = Number(dmCountRes.count ?? 0)
  const coldStartMode = dailyPositiveDays < SHORT_HISTORY_THRESHOLD_DAYS

  // Build history merged map (monthly_metrics wins; tracker_data fills gaps + food_cost)
  const history = mergeHistory(trRes.data ?? [], mmRes.data ?? [])

  // ── Decide path ──────────────────────────────────────────────────────
  const yoyRow = history.find(h => h.period_year === year - 1 && h.period_month === month && Number(h.revenue ?? 0) > 0)
  const last12  = sumLastN(history, 12, 0, year, month)
  const prior12 = sumLastN(history, 12, 12, year, month)
  const yoyComparable = !!yoyRow && prior12 > 0 && prior12 >= last12 * YOY_COMPARABILITY_MIN

  const monthAnchorDate = new Date(Date.UTC(year, month - 1, 15))
  const daysFromNow = Math.round((monthAnchorDate.getTime() - asOf.getTime()) / 86_400_000)

  let path: 'yoy_anchored' | 'daily_aggregate' | 'weekday_extrapolation'
  // Cold-start guard: block YoY anchoring when business has < 180 days
  // history. Even when a same-month-LY row exists, it may be partial
  // (e.g. Vero opened Nov 24, 2025 → her 2025-11 row is half-month data).
  // Memory `project_vero_2025_data_gap.md` documents this exact pattern.
  if (yoyComparable && !coldStartMode) {
    path = 'yoy_anchored'
  } else if (!options.skipDailyAggregate && daysFromNow >= -15 && daysFromNow <= DAILY_AGGREGATE_HORIZON_DAYS) {
    path = 'daily_aggregate'
  } else {
    path = 'weekday_extrapolation'
  }

  // ── Compute revenue forecast per path ────────────────────────────────
  let revenue = 0
  let confidence = 0.45
  let revenueSnapshot: MonthlyV1Snapshot['revenue'] = { method_detail: 'unknown' }

  if (path === 'yoy_anchored') {
    const yoyRevenue = Number(yoyRow!.revenue)
    const rawGrowth  = last12 / Math.max(1, prior12)
    const clamped    = rawGrowth < GROWTH_MULTIPLIER_MIN || rawGrowth > GROWTH_MULTIPLIER_MAX
    const appliedGrowth = Math.max(GROWTH_MULTIPLIER_MIN, Math.min(GROWTH_MULTIPLIER_MAX, rawGrowth))
    revenue = Math.round(yoyRevenue * appliedGrowth)
    confidence = 0.80
    revenueSnapshot = {
      method_detail: 'yoy_same_month × clamped_trailing_12m_growth',
      yoy_same_month: {
        year:                       year - 1,
        revenue:                    yoyRevenue,
        growth_multiplier_raw:      Math.round(rawGrowth * 1000) / 1000,
        growth_multiplier_applied:  Math.round(appliedGrowth * 1000) / 1000,
        clamped,
      },
    }
  } else if (path === 'daily_aggregate') {
    const daysInMonth = new Date(year, month, 0).getDate()  // last day of month
    const dailyResults = await Promise.allSettled(
      Array.from({ length: daysInMonth }, (_, i) => {
        const d = new Date(Date.UTC(year, month - 1, i + 1))
        return dailyForecast(businessId, d, { db, skipLogging: true })
      }),
    )
    const validForecasts = dailyResults
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && r.value.predicted_revenue > 0)
      .map(r => r.value.predicted_revenue as number)
    const sumPredicted = validForecasts.reduce((s, v) => s + v, 0)
    revenue = Math.round(sumPredicted)
    confidence = validForecasts.length === daysInMonth ? 0.65 : 0.55
    revenueSnapshot = {
      method_detail: `sum of dailyForecast() over ${validForecasts.length}/${daysInMonth} days`,
      daily_aggregate: {
        days_in_month:        daysInMonth,
        days_with_forecast:   validForecasts.length,
        mean_daily_forecast:  validForecasts.length > 0 ? Math.round(sumPredicted / validForecasts.length) : 0,
        sum_predicted:        sumPredicted,
      },
    }
  } else {
    // weekday_extrapolation — count weekdays in the target month, multiply by per-weekday baseline.
    // In cold-start mode (< 180 days history), apply the same Dec 20-Jan 6
    // holiday-period exclusion that Piece 2's daily forecaster uses. Without
    // this, Vero's last-12-weeks baseline includes Christmas peak Fridays
    // and anchors August/September predictions ~2× too high.
    const baselinesByWeekday = await computeWeekdayBaselines(db, businessId, asOf, { excludeHolidayPeriod: coldStartMode })
    const weekdayCounts = countWeekdaysInMonth(year, month)
    let total = 0
    for (let i = 0; i < 7; i++) {
      total += (baselinesByWeekday[i] ?? 0) * (weekdayCounts[i] ?? 0)
    }
    revenue = Math.round(total)
    confidence = 0.40
    const weekdayBaselineMap: Record<string, number> = {}
    const weekdayCountMap:    Record<string, number> = {}
    for (let i = 0; i < 7; i++) {
      weekdayBaselineMap[WEEKDAY_LABELS[i]] = Math.round(baselinesByWeekday[i] ?? 0)
      weekdayCountMap[WEEKDAY_LABELS[i]]    = weekdayCounts[i] ?? 0
    }
    revenueSnapshot = {
      method_detail: 'Σ weekday_baseline × weekday_count_in_target_month',
      weekday_extrapolation: {
        weekday_baselines:        weekdayBaselineMap,
        weekday_counts_in_month:  weekdayCountMap,
      },
    }
  }

  // ── Cost ratios ──────────────────────────────────────────────────────
  const costMonths = pickClosedMonthsForRatios(history, year, month, COST_RATIO_SAMPLE_MONTHS)
  const costSnapshot = deriveCostRatios(costMonths, biz)

  const dataQualityFlags: string[] = []
  if (coldStartMode)              dataQualityFlags.push('cold_start_lt_180_days_history')
  if (costMonths.length === 0)    dataQualityFlags.push('no_cost_history_using_business_targets')
  if (costMonths.length < 3)      dataQualityFlags.push('cost_history_thin_lt_3_months')
  if (path !== 'yoy_anchored')    dataQualityFlags.push('no_yoy_anchor_available')
  if (costSnapshot.food_floored)  dataQualityFlags.push('food_ratio_floor_28pct_applied')
  if (costSnapshot.staff_capped)  dataQualityFlags.push('staff_ratio_capped_at_target_plus_5pp')

  // ── Apply ratios to revenue → costs ──────────────────────────────────
  const staffCost = Math.round(revenue * costSnapshot.staff_ratio)
  const foodCost  = Math.round(revenue * costSnapshot.food_ratio)
  const otherCost = Math.round(revenue * costSnapshot.other_ratio)
  const netProfit = revenue - staffCost - foodCost - otherCost
  const margin    = revenue > 0 ? Math.round((netProfit / revenue) * 1000) / 10 : 0

  return {
    business_id:        businessId,
    period_year:        year,
    period_month:       month,
    revenue_forecast:   revenue,
    staff_cost_forecast: staffCost,
    food_cost_forecast: foodCost,
    other_cost_forecast: otherCost,
    net_profit_forecast: netProfit,
    margin_forecast:    margin,
    confidence,
    method:             `${MODEL_VERSION_DEFAULT}:${path}`,
    based_on_months:    costMonths.length,
    model_version:      MODEL_VERSION_DEFAULT,
    inputs_snapshot: {
      snapshot_version: SNAPSHOT_VERSION,
      path,
      revenue:          revenueSnapshot,
      costs: {
        method:                    costMonths.length === 0 ? 'business_target_fallback' : `median over last ${costMonths.length} closed months`,
        sample_months:             costMonths.length,
        staff_ratio:               Math.round(costSnapshot.staff_ratio * 10000) / 10000,
        food_ratio:                Math.round(costSnapshot.food_ratio  * 10000) / 10000,
        other_ratio:               Math.round(costSnapshot.other_ratio * 10000) / 10000,
        food_floored:              costSnapshot.food_floored,
        staff_capped:              costSnapshot.staff_capped,
        business_target_staff_pct: biz.target_staff_pct ?? null,
        business_target_food_pct:  biz.target_food_pct  ?? null,
      },
      cold_start_mode:    coldStartMode,
      data_quality_flags: dataQualityFlags,
    },
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

interface HistoryRow {
  period_year:  number
  period_month: number
  revenue:      number
  staff_cost:   number
  food_cost:    number
  other_cost:   number
  net_profit:   number
}

function mergeHistory(trackerRows: any[], monthlyRows: any[]): HistoryRow[] {
  const map = new Map<string, HistoryRow>()
  for (const t of trackerRows) {
    map.set(`${t.period_year}-${t.period_month}`, {
      period_year:  Number(t.period_year),
      period_month: Number(t.period_month),
      revenue:      Number(t.revenue    ?? 0),
      staff_cost:   Number(t.staff_cost ?? 0),
      food_cost:    Number(t.food_cost  ?? 0),
      other_cost:   Number(t.other_cost ?? 0),
      net_profit:   Number(t.net_profit ?? 0),
    })
  }
  for (const m of monthlyRows) {
    const key = `${m.year}-${m.month}`
    const existing = map.get(key)
    map.set(key, {
      period_year:  Number(m.year),
      period_month: Number(m.month),
      revenue:      Number(m.revenue    ?? 0),
      staff_cost:   Number(m.staff_cost ?? 0),
      // monthly_metrics doesn't always carry food_cost / other_cost — keep tracker's value when present
      food_cost:    Number(m.food_cost  ?? 0) > 0 ? Number(m.food_cost) : (existing?.food_cost  ?? 0),
      other_cost:   Number(m.other_cost ?? 0) > 0 ? Number(m.other_cost) : (existing?.other_cost ?? 0),
      net_profit:   Number(m.net_profit ?? 0),
    })
  }
  return Array.from(map.values())
    .filter(r => r.revenue > 0)
    .sort((a, b) => a.period_year !== b.period_year ? a.period_year - b.period_year : a.period_month - b.period_month)
}

function sumLastN(history: HistoryRow[], n: number, skip: number, refYear: number, refMonth: number): number {
  const refIndex = refYear * 12 + refMonth
  const sliced = history
    .filter(h => {
      const idx = h.period_year * 12 + h.period_month
      return idx <= refIndex - 1 - skip && idx >= refIndex - skip - n
    })
  return sliced.reduce((s, r) => s + Number(r.revenue ?? 0), 0)
}

function pickClosedMonthsForRatios(history: HistoryRow[], targetYear: number, targetMonth: number, maxMonths: number): HistoryRow[] {
  const refIndex = targetYear * 12 + targetMonth
  return history
    .filter(h => h.period_year * 12 + h.period_month < refIndex)   // only past months
    .filter(h => h.revenue > 0)                                     // need revenue denominator
    .slice(-maxMonths)
}

function deriveCostRatios(months: HistoryRow[], biz: { target_food_pct?: number | null; target_staff_pct?: number | null }) {
  // Defaults when no history: use business targets or industry standards.
  if (months.length === 0) {
    return {
      staff_ratio: (biz.target_staff_pct != null ? Number(biz.target_staff_pct) / 100 : STAFF_RATIO_INDUSTRY_DEFAULT),
      food_ratio:  (biz.target_food_pct  != null ? Math.max(FOOD_RATIO_FLOOR, Number(biz.target_food_pct)  / 100) : FOOD_RATIO_FLOOR),
      other_ratio: 0.15,
      food_floored: biz.target_food_pct == null || Number(biz.target_food_pct) / 100 < FOOD_RATIO_FLOOR,
      staff_capped: false,
    }
  }

  const ratios = months
    .filter(m => m.revenue > 0)
    .map(m => ({
      staff: m.staff_cost / m.revenue,
      food:  m.food_cost  / m.revenue,
      other: m.other_cost / m.revenue,
    }))

  const sortedStaff = ratios.map(r => r.staff).sort((a, b) => a - b)
  const sortedFood  = ratios.map(r => r.food).filter(v => v > 0).sort((a, b) => a - b)
  const sortedOther = ratios.map(r => r.other).filter(v => v >= 0).sort((a, b) => a - b)

  let staffRatio = median(sortedStaff)
  let foodRatio  = sortedFood.length > 0 ? median(sortedFood)  : FOOD_RATIO_FLOOR
  let otherRatio = sortedOther.length > 0 ? median(sortedOther) : 0.15

  // Floor / cap per memory rules
  const foodFloorTriggered = foodRatio < FOOD_RATIO_FLOOR
  if (foodFloorTriggered) foodRatio = FOOD_RATIO_FLOOR
  if (foodRatio > FOOD_RATIO_CEIL) foodRatio = FOOD_RATIO_CEIL  // bad data guard

  const targetStaffPct = biz.target_staff_pct != null ? Number(biz.target_staff_pct) / 100 : STAFF_RATIO_INDUSTRY_DEFAULT
  const staffCap = targetStaffPct + STAFF_RATIO_HEADROOM_PP
  const staffCapTriggered = staffRatio > staffCap
  if (staffCapTriggered) staffRatio = staffCap

  return { staff_ratio: staffRatio, food_ratio: foodRatio, other_ratio: otherRatio, food_floored: foodFloorTriggered, staff_capped: staffCapTriggered }
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function isInChristmasHolidayPeriod(d: Date): boolean {
  const m = d.getUTCMonth()
  const day = d.getUTCDate()
  if (m === 11 && day >= 20) return true   // Dec 20-31
  if (m === 0  && day <= 6)  return true   // Jan 1-6
  return false
}

async function computeWeekdayBaselines(
  db: any,
  businessId: string,
  asOfDate: Date,
  opts: { excludeHolidayPeriod?: boolean } = {},
): Promise<Record<number, number>> {
  // 12-week recency-weighted average per weekday. Matches Piece 2's weekday
  // baseline math, simplified (no anomaly filter, no recency multiplier —
  // far-horizon prediction doesn't benefit from those).
  //
  // Cold-start guard: when excludeHolidayPeriod=true, drop Dec 20-Jan 6
  // samples from the average. The Swedish Christmas/New Year regime is
  // structurally different from regular trading, and a 4-week-old business
  // forecasting August shouldn't anchor on December peak Fridays.
  const cutoff = new Date(asOfDate.getTime() - 84 * 86_400_000)
  const cutoffIso = cutoff.toISOString().slice(0, 10)
  const { data } = await db.from('daily_metrics')
    .select('date, revenue')
    .eq('business_id', businessId)
    .gte('date', cutoffIso)
    .gt('revenue', 0)
  const byDow: Record<number, number[]> = {}
  for (const r of data ?? []) {
    const sample = new Date((r as any).date + 'T12:00:00Z')
    if (opts.excludeHolidayPeriod && isInChristmasHolidayPeriod(sample)) continue
    const dow = sample.getUTCDay()
    if (!byDow[dow]) byDow[dow] = []
    byDow[dow].push(Number((r as any).revenue))
  }
  const result: Record<number, number> = {}
  for (let i = 0; i < 7; i++) {
    const vals = byDow[i] ?? []
    result[i] = vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0
  }
  return result
}

function countWeekdaysInMonth(year: number, month: number): Record<number, number> {
  const result: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }
  const daysInMonth = new Date(year, month, 0).getDate()
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay()
    result[dow]++
  }
  return result
}

/** Exported for the wiring point in lib/sync/engine.ts and audit. */
export const MONTHLY_MODEL_VERSION = MODEL_VERSION_DEFAULT
