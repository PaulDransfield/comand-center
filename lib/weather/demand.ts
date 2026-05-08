// lib/weather/demand.ts
//
// Demand-forecast model. Combines:
//   - Live 7-day weather forecast (Open-Meteo, sourced from SMHI for Sweden)
//   - Per-business bucket lift factors derived from historical correlation
//     (weather_daily × daily_metrics)
//   - Per-weekday baseline revenue (8-12 weeks rolling)
//   - Holiday gate (predictions on holidays are unreliable — use baseline only,
//     flag the holiday name)
//
// Multiplicative model:
//   predicted_revenue(date) = baseline(weekday) × bucket_lift(weather_bucket)
//
// Per-business lift factors learn the business's own personality without any
// black-box ML — a terrace-heavy bistro shows large clear+hot lifts, a
// windowless basement Italian shows small ones. Same model, different coeffs.
//
// Confidence is sample-size driven: high if the bucket has ≥8 historical
// samples for this business, medium 4-7, low <4. Below 4 we still return
// a prediction but tag it as a rough estimate so the UI can show it muted.

import { getForecast, weatherBucket, coordsFor, type DailyWeather } from './forecast'
import { getUpcomingHolidays }                                       from '@/lib/holidays'

// ── Types ────────────────────────────────────────────────────────────────────

export type Confidence = 'high' | 'medium' | 'low' | 'unavailable'

export interface DemandDay {
  date:                string                  // YYYY-MM-DD
  weekday:             string                  // 'Mon', 'Tue', ...
  weather: {
    summary:           string
    temp_min:          number
    temp_max:          number
    precip_mm:         number
    wind_max:          number
    weather_code:      number
    bucket:            string
  }
  /** Whether this date is a public holiday in the business's country. */
  is_holiday:          boolean
  holiday_name:        string | null
  /** Average revenue for this weekday from the last 8-12 weeks. */
  baseline_revenue:    number
  /** Predicted revenue = baseline × bucket lift. Falls back to baseline on holidays. */
  predicted_revenue:   number
  /** (predicted - baseline) / baseline as a percentage. Negative = below typical. */
  delta_pct:           number
  confidence:          Confidence
  /** How many historical days we have in this bucket for this business. */
  sample_size:         number
  /** Optional one-line owner-facing recommendation. Null when delta is small. */
  recommendation:      string | null
}

export interface DemandForecast {
  business_id:         string
  business_name:       string
  business_city:       string | null
  generated_at:        string
  baseline_window: {
    from_date:         string
    to_date:           string
    weeks:             number
  }
  correlation: {
    sample_days:       number
    overall_avg_rev:   number
  }
  days:                DemandDay[]
}

export interface ComputeDemandOpts {
  /** Supabase admin client. Caller-provided so this module is environment-agnostic. */
  db:                  any
  /** CommandCenter org id — must match the business's org for safety. */
  orgId:               string
  /** Target business. */
  businessId:          string
  /** Days of forecast to project. Default 7. Open-Meteo gives up to 16. */
  days?:               number
}

// Sample-size thresholds for confidence labelling.
const HIGH_CONFIDENCE_N   = 8
const MEDIUM_CONFIDENCE_N = 4

// Magnitude thresholds for surfacing recommendations. Below these we stay quiet.
const RECOMMEND_DELTA_PCT       = 12   // |delta| ≥ 12% → suggest action
const STRONG_DELTA_PCT          = 20   // |delta| ≥ 20% → strong language

// Days-of-week with Monday=0 (matching ISO standard / Sweden's convention).
// Date.getDay() is Sunday=0; convert via (getDay()+6)%7.
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// ── Public entry point ───────────────────────────────────────────────────────

export async function computeDemandForecast(opts: ComputeDemandOpts): Promise<DemandForecast | null> {
  const days = Math.min(Math.max(opts.days ?? 7, 1), 14)

  // Load business — used for city, country, name. Verify org ownership.
  const { data: biz } = await opts.db
    .from('businesses')
    .select('id, org_id, name, city, country')
    .eq('id', opts.businessId)
    .eq('org_id', opts.orgId)
    .maybeSingle()
  if (!biz) return null

  const { lat, lon } = coordsFor(biz.city)

  // Three parallel data fetches: live forecast, historical correlation, baseline.
  const [forecast, correlation, baselineByWeekday] = await Promise.all([
    fetchForecast(lat, lon, days),
    fetchBucketLifts(opts.db, opts.businessId),
    fetchBaselineByWeekday(opts.db, opts.businessId),
  ])

  // Holidays — best-effort. Failure isn't fatal, we just don't gate on them.
  const holidaysByDate: Map<string, string> = new Map()
  try {
    const todayYmd = new Date().toISOString().slice(0, 10)
    const upcoming = getUpcomingHolidays(biz.country ?? 'SE', todayYmd, days + 2)
    for (const h of upcoming) {
      // Holiday has name_sv + name_en (per lib/holidays/sweden.ts). Pick
      // English by default — UI translates separately if it wants the
      // localised form. Keeping English here so the AI memo prompt sees
      // a consistent value.
      holidaysByDate.set(h.date, h.name_en ?? h.name_sv ?? 'Holiday')
    }
  } catch { /* missing country module — ignore */ }

  const out: DemandDay[] = []
  for (const f of forecast.slice(0, days)) {
    const weekdayIdx = (new Date(f.date).getUTCDay() + 6) % 7
    const weekday    = WEEKDAY_LABELS[weekdayIdx]
    const baseline   = baselineByWeekday.get(weekday) ?? 0
    const bucket     = weatherBucket(f)
    const lift       = correlation.byBucket.get(bucket)
    const sampleSize = lift?.sampleSize ?? 0
    const isHoliday  = holidaysByDate.has(f.date)
    const holidayName = holidaysByDate.get(f.date) ?? null

    let predicted = baseline
    let confidence: Confidence = 'unavailable'

    if (isHoliday) {
      // Holiday breaks the baseline pattern — return baseline for shape but
      // flag clearly. The widget renders these in a distinct style.
      predicted  = baseline
      confidence = 'low'
    } else if (lift && baseline > 0) {
      predicted  = baseline * lift.factor
      confidence = sampleSize >= HIGH_CONFIDENCE_N ? 'high'
                 : sampleSize >= MEDIUM_CONFIDENCE_N ? 'medium'
                 : 'low'
    } else {
      // Either we have no baseline (new business) or no lift data for this
      // bucket. Fall back to baseline; mark unavailable so UI shows muted.
      predicted  = baseline
      confidence = baseline > 0 ? 'low' : 'unavailable'
    }

    const delta_pct = baseline > 0 ? ((predicted - baseline) / baseline) * 100 : 0

    out.push({
      date:              f.date,
      weekday,
      weather: {
        summary:         f.summary,
        temp_min:        f.temp_min,
        temp_max:        f.temp_max,
        precip_mm:       f.precip_mm,
        wind_max:        f.wind_max,
        weather_code:    f.weather_code,
        bucket,
      },
      is_holiday:        isHoliday,
      holiday_name:      holidayName,
      baseline_revenue:  Math.round(baseline),
      predicted_revenue: Math.round(predicted),
      delta_pct:         Math.round(delta_pct * 10) / 10,
      confidence,
      sample_size:       sampleSize,
      recommendation:    deriveRecommendation({
        deltaPct:    delta_pct,
        bucket,
        weekday,
        confidence,
        isHoliday,
      }),
    })
  }

  return {
    business_id:    biz.id,
    business_name:  biz.name,
    business_city:  biz.city,
    generated_at:   new Date().toISOString(),
    baseline_window: {
      from_date:    correlation.baselineWindow.fromDate,
      to_date:      correlation.baselineWindow.toDate,
      weeks:        correlation.baselineWindow.weeks,
    },
    correlation: {
      sample_days:     correlation.totalDays,
      overall_avg_rev: Math.round(correlation.overallAvgRev),
    },
    days:               out,
  }
}

// ── Data loaders ─────────────────────────────────────────────────────────────

/** Live forecast from Open-Meteo. Cached in-memory by lib/weather/forecast.ts. */
async function fetchForecast(lat: number, lon: number, days: number): Promise<DailyWeather[]> {
  // getForecast returns 16 days (Open-Meteo max). Today is index 0.
  const all = await getForecast(lat, lon)
  return all.slice(0, days)
}

interface BucketLift {
  bucket:     string
  factor:     number   // avg_rev_in_bucket / overall_avg_rev
  sampleSize: number
}

interface CorrelationData {
  byBucket:        Map<string, BucketLift>
  overallAvgRev:   number
  totalDays:       number
  baselineWindow: { fromDate: string; toDate: string; weeks: number }
}

/**
 * Compute per-bucket lift factors from weather_daily × daily_metrics, using
 * up to 12 months of history. Same logic as /api/weather/correlation but
 * returned as a lookup map rather than rendered as a UI payload.
 */
async function fetchBucketLifts(db: any, businessId: string): Promise<CorrelationData> {
  const now = new Date()
  const fromDate = new Date(now.getTime() - 365 * 86400_000).toISOString().slice(0, 10)
  const toDate   = now.toISOString().slice(0, 10)

  const [{ data: weather }, { data: metrics }] = await Promise.all([
    db.from('weather_daily')
      .select('date, temp_avg, precip_mm, weather_code')
      .eq('business_id', businessId)
      .eq('is_forecast', false)
      .gte('date', fromDate),
    db.from('daily_metrics')
      .select('date, revenue')
      .eq('business_id', businessId)
      .gte('date', fromDate),
  ])

  const wxByDate: Record<string, any> = {}
  for (const w of weather ?? []) wxByDate[w.date] = w

  const joined = (metrics ?? [])
    .filter((r: any) => Number(r.revenue ?? 0) > 0 && wxByDate[r.date])
    .map((r: any) => ({
      revenue: Number(r.revenue),
      bucket:  weatherBucket(wxByDate[r.date]),
    }))

  const overallAvg = joined.length > 0
    ? joined.reduce((s: number, d: { revenue: number }) => s + d.revenue, 0) / joined.length
    : 0

  const byBucketRaw: Record<string, { total: number; days: number }> = {}
  for (const d of joined) {
    if (!byBucketRaw[d.bucket]) byBucketRaw[d.bucket] = { total: 0, days: 0 }
    byBucketRaw[d.bucket].total += d.revenue
    byBucketRaw[d.bucket].days  += 1
  }

  const byBucket = new Map<string, BucketLift>()
  for (const [bucket, info] of Object.entries(byBucketRaw)) {
    const avg = info.days > 0 ? info.total / info.days : 0
    const factor = overallAvg > 0 ? avg / overallAvg : 1
    byBucket.set(bucket, {
      bucket,
      factor,
      sampleSize: info.days,
    })
  }

  return {
    byBucket,
    overallAvgRev:  overallAvg,
    totalDays:      joined.length,
    baselineWindow: {
      fromDate,
      toDate,
      weeks: Math.round(joined.length / 7),
    },
  }
}

/**
 * Per-weekday rolling-average baseline revenue. Uses the last 12 weeks of
 * daily_metrics. Returns a Map weekday → avg_revenue. Excludes zero-revenue
 * days (closed days, missing data) so the baseline reflects actual operations.
 */
async function fetchBaselineByWeekday(db: any, businessId: string): Promise<Map<string, number>> {
  const fromDate = new Date(Date.now() - 12 * 7 * 86400_000).toISOString().slice(0, 10)

  const { data } = await db
    .from('daily_metrics')
    .select('date, revenue')
    .eq('business_id', businessId)
    .gte('date', fromDate)
    .gt('revenue', 0)
    .limit(2000)

  const byWeekday: Record<string, { total: number; days: number }> = {}
  for (const row of data ?? []) {
    const idx = (new Date(row.date).getUTCDay() + 6) % 7
    const wd  = WEEKDAY_LABELS[idx]
    if (!byWeekday[wd]) byWeekday[wd] = { total: 0, days: 0 }
    byWeekday[wd].total += Number(row.revenue ?? 0)
    byWeekday[wd].days  += 1
  }

  const out = new Map<string, number>()
  for (const [wd, info] of Object.entries(byWeekday)) {
    if (info.days > 0) out.set(wd, info.total / info.days)
  }
  return out
}

// ── Recommendation derivation ────────────────────────────────────────────────
//
// Owner-facing one-liner. Stays quiet on small deltas to avoid noise. Tone is
// suggestive ("consider"), never directive ("you should") — owner makes the
// call; we surface the signal.

function deriveRecommendation(opts: {
  deltaPct:   number
  bucket:     string
  weekday:    string
  confidence: Confidence
  isHoliday:  boolean
}): string | null {
  // Don't recommend when we don't trust the signal.
  if (opts.confidence === 'unavailable' || opts.confidence === 'low') return null
  if (opts.isHoliday) return null
  if (Math.abs(opts.deltaPct) < RECOMMEND_DELTA_PCT) return null

  const isWeekend = opts.weekday === 'Fri' || opts.weekday === 'Sat' || opts.weekday === 'Sun'
  const strong    = Math.abs(opts.deltaPct) >= STRONG_DELTA_PCT

  if (opts.deltaPct < 0) {
    // Below baseline — staffing-cut hint
    if (opts.bucket === 'wet' || opts.bucket === 'snow' || opts.bucket === 'thunder') {
      return strong
        ? `Heavy weather expected — ${isWeekend ? 'weekend traffic' : 'walk-ins'} typically drop sharply. Consider trimming a shift.`
        : `Wet weather expected — ${isWeekend ? 'weekend traffic' : 'walk-ins'} usually trail. Consider trimming a shift.`
    }
    if (opts.bucket === 'freezing' || opts.bucket === 'cold_dry') {
      return `Cold day — your history shows lower covers. Consider trimming a shift.`
    }
    return `Below-typical day in your history. Consider trimming a shift.`
  } else {
    // Above baseline — opportunity hint
    if (opts.bucket === 'hot' || opts.bucket === 'clear') {
      return isWeekend
        ? `Clear ${strong ? 'and warm — strong weekend traffic likely' : 'forecast — weekend traffic typically lifts'}. Consider opening any outdoor seating early and stocking accordingly.`
        : `Clear forecast — covers typically lift on days like this. Stock and staff for a busier service.`
    }
    return `Above-typical day in your history. Plan for a busier service.`
  }
}
