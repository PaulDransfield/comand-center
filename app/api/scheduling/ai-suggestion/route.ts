// @ts-nocheck
// app/api/scheduling/ai-suggestion/route.ts
//
// Returns the current PK schedule for next week AND an AI-suggested one
// derived from 8 weeks of actual revenue-per-hour patterns. Side-by-side
// display, owner decides what to act on.
//
// Shape:
// {
//   weekStart: "2026-04-20",
//   current:  [{ date, weekday, shifts, hours, est_cost, dept_breakdown }],
//   suggested:[{ date, weekday, hours, est_cost, est_revenue, rev_per_hour,
//                delta_hours, delta_cost, reasoning }],
//   summary:  { current_hours, suggested_hours, saving_kr, rationale }
// }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { fetchAllPaged } from '@/lib/supabase/page'
import { decrypt }                    from '@/lib/integrations/encryption'
import { getWorkPeriods }              from '@/lib/pos/personalkollen'
import { weatherBucket, getForecast, coordsFor } from '@/lib/weather/forecast'
import { weightedAvg, thisWeekScaler, RECENCY, adaptiveRecencyParams } from '@/lib/forecast/recency'
import { captureForecastOutcomes }              from '@/lib/forecast/audit'
import { dailyForecast }                        from '@/lib/forecast/daily'
import { hourlyForecast, detectMealPeriods, type MealPeriodCluster, type MealPeriodLabel } from '@/lib/forecast/hourly'
import { isPredictionV2FlagEnabled }            from '@/lib/featureFlags/prediction-v2'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
// Personalkollen fetch + 8 weeks of aggregation + (optional) AI — stays
// comfortably under 60 s, but declare the ceiling so we fail loudly
// instead of getting silently truncated on Hobby.
export const maxDuration = 60

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const bizId = req.nextUrl.searchParams.get('business_id')
  if (!bizId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()

  // Confirm the caller owns this business. Pulling `city` here so we can
  // drive the live weather fetch off the business's location.
  const { data: biz } = await db.from('businesses').select('id,org_id,name,city').eq('id', bizId).maybeSingle()
  if (!biz || biz.org_id !== auth.orgId) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  // Target range — defaults to "next calendar Monday → Sunday" but callers
  // (e.g. dashboard current-week chart) can override with explicit from/to to
  // get predictions for the remainder of the current week or any arbitrary
  // date range. History window, forecast fetch, and PK live fetch all use the
  // resolved range.
  const qFrom = req.nextUrl.searchParams.get('from')
  const qTo   = req.nextUrl.searchParams.get('to')
  const now = new Date()
  let weekFrom: string, weekTo: string
  if (qFrom && qTo && /^\d{4}-\d{2}-\d{2}$/.test(qFrom) && /^\d{4}-\d{2}-\d{2}$/.test(qTo)) {
    weekFrom = qFrom
    weekTo   = qTo
  } else {
    const daysUntilMon = ((1 - now.getDay() + 7) % 7) || 7
    const nextMon = new Date(now); nextMon.setDate(now.getDate() + daysUntilMon); nextMon.setHours(0,0,0,0)
    const nextSun = new Date(nextMon); nextSun.setDate(nextMon.getDate() + 6)
    weekFrom = nextMon.toISOString().slice(0,10)
    weekTo   = nextSun.toISOString().slice(0,10)
  }

  // ── Current PK schedule for next week ──────────────────────────────────────
  // Fetch LIVE from PK — staff_logs only holds past+sync-window data, but next
  // week's schedule often sits in PK awaiting the next sync. Going direct
  // means the user sees real PK state whenever they load this page.
  //
  // Shift mapping: each WorkPeriod has start + end timestamps. hours = (end-start)/3600.
  let scheduledRows: any[] = []
  let liveFetchError: string | null = null
  let integrationStatus: string | null = null
  let periodsReturned = 0
  try {
    // Removed the .eq('status','connected') filter — if a sync briefly
    // flipped the status to 'error' while PK itself is actually fine, we'd
    // skip the live fetch and the AI table would silently render empty.
    // Try the fetch regardless and let the PK call itself be the oracle on
    // whether the token still works.
    const { data: integ } = await db.from('integrations')
      .select('credentials_enc, status')
      .eq('business_id', bizId)
      .eq('provider', 'personalkollen')
      .maybeSingle()
    integrationStatus = integ?.status ?? 'missing'
    if (integ?.credentials_enc) {
      const token = decrypt(integ.credentials_enc)
      if (token) {
        const periods = await getWorkPeriods(token, weekFrom, weekTo)
        periodsReturned = periods.length
        scheduledRows = periods.map((p: any) => {
          const startMs = p.start ? new Date(p.start).getTime() : 0
          const endMs   = p.end   ? new Date(p.end).getTime()   : 0
          const grossHrs = startMs && endMs ? Math.max(0, (endMs - startMs) / 3_600_000) : 0
          const breakHrs = (p.breaks_duration ?? 0) / 3600
          const hours    = Math.max(0, grossHrs - breakHrs)
          return {
            shift_date:        p.date ?? (p.start ? p.start.slice(0, 10) : null),
            staff_name:        p.staff_name,
            staff_group:       p.costgroup ?? null,
            hours_worked:      hours,
            estimated_salary:  p.estimated_cost ?? 0,
            // Preserved for meal-period splitting (Phase A week 3).
            // ISO timestamps; downstream we convert to Stockholm-local
            // hour-of-day and intersect with detected meal-period hours.
            shift_start_iso:   p.start ?? null,
            shift_end_iso:     p.end   ?? null,
            breaks_duration:   p.breaks_duration ?? 0,
          }
        }).filter((r: any) => r.shift_date && r.shift_date >= weekFrom && r.shift_date <= weekTo)
      }
    }
  } catch (e: any) {
    liveFetchError = e.message
    console.warn('[ai-suggestion] live PK WorkPeriods fetch failed, falling back to staff_logs:', e.message)
  }

  // Fallback: if PK call failed OR returned nothing, read from staff_logs.
  if (scheduledRows.length === 0) {
    const fallback = await fetchAllPaged(async (lo, hi) =>
      db.from('staff_logs')
        .select('shift_date, staff_name, staff_group, hours_worked, estimated_salary, cost_actual')
        .eq('business_id', bizId)
        .gte('shift_date', weekFrom)
        .lte('shift_date', weekTo)
        .like('pk_log_url', '%_scheduled')
        .order('shift_date', { ascending: true })
        .range(lo, hi)
    ).catch(() => [])
    scheduledRows = fallback
  }

  const currentByDate: Record<string, any> = {}
  const rangeStart = new Date(weekFrom + 'T00:00:00')
  const rangeEnd   = new Date(weekTo   + 'T00:00:00')
  for (let d = new Date(rangeStart); d <= rangeEnd; d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10)
    currentByDate[iso] = {
      date:            iso,
      weekday:         DAYS[(new Date(iso).getUTCDay() + 6) % 7],
      shifts:          0,
      hours:           0,
      est_cost:        0,
      dept_breakdown:  {} as Record<string, { hours: number; cost: number }>,
      // Phase A week 3.5 — per-shift detail for the rota timeline view.
      // Empty when PK fell back to staff_logs (which lacks shift times).
      shift_list:      [] as Array<{
        staff_name:      string | null
        staff_group:     string | null
        shift_start_iso: string | null
        shift_end_iso:   string | null
        hours_worked:    number
        estimated_cost:  number
      }>,
    }
  }
  for (const s of scheduledRows) {
    const row = currentByDate[s.shift_date]
    if (!row) continue
    const hours = Number(s.hours_worked ?? 0)
    const cost  = Number(s.estimated_salary ?? 0) > 0 ? Number(s.estimated_salary) : Number(s.cost_actual ?? 0)
    row.shifts += 1
    row.hours  += hours
    row.est_cost += cost
    const dept = s.staff_group ?? 'Unknown'
    if (!row.dept_breakdown[dept]) row.dept_breakdown[dept] = { hours: 0, cost: 0 }
    row.dept_breakdown[dept].hours += hours
    row.dept_breakdown[dept].cost  += cost
    // Push shift detail. Only useful when we got start/end from PK live.
    if (s.shift_start_iso && s.shift_end_iso) {
      row.shift_list.push({
        staff_name:      s.staff_name ?? null,
        staff_group:     s.staff_group ?? null,
        shift_start_iso: s.shift_start_iso,
        shift_end_iso:   s.shift_end_iso,
        hours_worked:    hours,
        estimated_cost:  Math.round(cost),
      })
    }
  }

  // ── Historical pattern: 12 weeks (mature) or 4 weeks (short-history) ──
  // The history window ends the day before the target range starts, so a
  // prediction never peeks at data from within the period it's predicting.
  //
  // Short-history mode (Vero-style cold-start protection, 2026-05-10):
  // for businesses with <180 days of positive revenue, the standard 12-week
  // window + 2.0× recency multiplier amplifies whichever direction the
  // most-recent month happened to go. Use a 4-week flat-mean window
  // instead. Helper at lib/forecast/recency.ts encapsulates the rule.
  // We need a quick history-day count BEFORE deciding the window — fetch
  // a probe count first.
  const probeStartIso = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)
  const { count: historyDayCount } = await db.from('daily_metrics')
    .select('*', { count: 'exact', head: true })
    .eq('business_id', bizId)
    .gt('revenue', 0)
    .gte('date', probeStartIso)
  const adaptive = adaptiveRecencyParams(Number(historyDayCount ?? 0))
  const histEnd = new Date(rangeStart); histEnd.setDate(rangeStart.getDate() - 1)
  const histStart = new Date(histEnd); histStart.setDate(histEnd.getDate() - 7 * adaptive.baselineWindowWeeks)
  const histStartIso = histStart.toISOString().slice(0, 10)
  const histEndIso   = histEnd.toISOString().slice(0, 10)
  // Historical weather comes from weather_daily (populated by the one-shot
  // backfill). Forecasts come live from Open-Meteo so we're never stale —
  // weather_daily's future rows go out of date whenever the backfill hasn't
  // run recently, which was the root cause of "weather not loading".
  const { lat, lon } = coordsFor(biz.city)
  const [dailyRes, wxHistRes, fcastResult, thisRangeDailyRes] = await Promise.all([
    db.from('daily_metrics')
      .select('date, revenue, staff_cost, hours_worked, labour_pct')
      .eq('business_id', bizId)
      .gte('date', histStartIso).lte('date', histEndIso),
    // Observed weather for the same range (correlation input)
    db.from('weather_daily')
      .select('date, temp_avg, precip_mm, weather_code, summary, is_forecast')
      .eq('business_id', bizId)
      .gte('date', histStartIso).lte('date', histEndIso)
      .eq('is_forecast', false),
    // Live 10-day forecast (cached 1h in-process by getForecast).
    getForecast(lat, lon).catch((e: any) => {
      console.warn('[ai-suggestion] live weather fetch failed:', e?.message)
      return []
    }),
    // This-period actuals for the requested range — used for the
    // "this-week pull-forward" scaler. If completed days run materially
    // above/below the model's prediction, the remaining days get scaled
    // by the same ratio (clamped 0.75-1.25).
    db.from('daily_metrics')
      .select('date, revenue')
      .eq('business_id', bizId)
      .gte('date', weekFrom).lte('date', weekTo)
      .gt('revenue', 0),
  ])
  const daily   = dailyRes.data ?? []
  const wxHist  = wxHistRes.data ?? []
  const thisRangeActuals = thisRangeDailyRes.data ?? []
  const wxNext  = (fcastResult ?? []).filter(w => w.date >= weekFrom && w.date <= weekTo)
  const wxNextByDate: Record<string, any> = {}
  for (const w of wxNext) wxNextByDate[w.date] = w
  const wxHistByDate: Record<string, any> = {}
  for (const w of wxHist) wxHistByDate[w.date] = w

  // Per-weekday historical averages (ignore days with zero rev). Retain
  // each sample's date so recency weighting can apply (last 4 weeks 2×).
  const byDow: Record<number, { rev: number[]; hours: number[]; revPerHour: number[]; labourPct: number[]; dates: string[]; rphDates: string[] }> = {}
  for (let i = 0; i < 7; i++) byDow[i] = { rev: [], hours: [], revPerHour: [], labourPct: [], dates: [], rphDates: [] }

  // Per (weekday × bucket) for weather-aware refinement.
  const byDowBucket: Record<string, { rev: number[]; hours: number[]; revPerHour: number[]; dates: string[]; rphDates: string[] }> = {}

  for (const r of (daily ?? [])) {
    if (!r.date || Number(r.revenue ?? 0) <= 0) continue
    const dow = (new Date(r.date).getUTCDay() + 6) % 7
    const rev = Number(r.revenue ?? 0)
    const hrs = Number(r.hours_worked ?? 0)
    byDow[dow].rev.push(rev)
    byDow[dow].hours.push(hrs)
    byDow[dow].dates.push(r.date)
    if (hrs > 0) {
      byDow[dow].revPerHour.push(rev / hrs)
      byDow[dow].rphDates.push(r.date)
    }
    if (r.labour_pct != null) byDow[dow].labourPct.push(Number(r.labour_pct))

    const wx = wxHistByDate[r.date]
    if (wx) {
      const bucket = weatherBucket(wx)
      const key    = `${dow}|${bucket}`
      if (!byDowBucket[key]) byDowBucket[key] = { rev: [], hours: [], revPerHour: [], dates: [], rphDates: [] }
      byDowBucket[key].rev.push(rev)
      byDowBucket[key].hours.push(hrs)
      byDowBucket[key].dates.push(r.date)
      if (hrs > 0) {
        byDowBucket[key].revPerHour.push(rev / hrs)
        byDowBucket[key].rphDates.push(r.date)
      }
    }
  }
  // Plain mean — used for things that aren't time-series (e.g. quantile
  // input). Recency weighting applies to revenue / hours / rev-per-hour
  // averages explicitly via weightedAvg().
  const avg = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0
  const refDate = new Date()
  const wAvg = (vals: number[], dates: string[]) =>
    weightedAvg(vals, dates, refDate, {
      recentWindowDays:  adaptive.recentWindowDays,
      recencyMultiplier: adaptive.recencyMultiplier,
    })

  // ── This-week pull-forward scaler ──────────────────────────────────────────
  // Pre-compute the model's revenue prediction for every date in the
  // requested range. Pair completed days (those with actual revenue) with
  // their prediction and derive a single multiplicative scaler — clamped
  // 0.75-1.25, median across days. Apply to all output dates so days
  // running 14% above the pattern lift the rest of the week's forecast
  // proportionally instead of staying anchored to a stale 12-week mean.
  const rawPredByDate: Record<string, number> = {}
  for (const date of Object.keys(currentByDate)) {
    const dow = (new Date(date).getUTCDay() + 6) % 7
    const d   = byDow[dow]
    const fcast = wxNextByDate[date]
    const bucket = fcast ? weatherBucket(fcast) : null
    const bucketKey = bucket ? `${dow}|${bucket}` : null
    const bucketData = bucketKey ? byDowBucket[bucketKey] : null
    const useBucket  = !!(bucketData && bucketData.rev.length >= 3)
    const srcRev     = useBucket ? bucketData!.rev   : d.rev
    const srcDates   = useBucket ? bucketData!.dates : d.dates
    rawPredByDate[date] = Math.round(wAvg(srcRev, srcDates))
  }

  const actualByDateInRange: Record<string, number> = {}
  for (const r of thisRangeActuals) actualByDateInRange[r.date] = Number(r.revenue ?? 0)

  const scalerInput: Array<{ actual: number; predicted: number }> = []
  for (const date of Object.keys(rawPredByDate)) {
    const actual    = actualByDateInRange[date] ?? 0
    const predicted = rawPredByDate[date]
    if (actual > 0 && predicted > 0) scalerInput.push({ actual, predicted })
  }
  const { scaler: thisWeekScale, samples: thisWeekSamples, raw: thisWeekRaw } = thisWeekScaler(scalerInput)

  // ── Piece 2 / v2 cutover: per-business flag-gated revenue source ─────────
  // When PREDICTION_V2_DASHBOARD_CHART is enabled for this business, we
  // replace the legacy "weekday-weighted-avg × this-week-scaler" revenue
  // prediction with the consolidated forecaster's output (lib/forecast/
  // daily.ts → dailyForecast). Everything downstream (scheduling math,
  // P75 rev/hour, hour targets, owner UI) continues to consume the same
  // `avgRev` variable — the swap is invisible to the rest of the route.
  //
  // Off (default): legacy math, no behavioural change.
  // On:            consolidated_v1.3.0 — holiday-period filter, klamdag,
  //                school-holiday, salary-cycle, weather-bucket lift,
  //                yoy-anchor, this-week scaler. MAPE 64.6% / bias +13.9 %
  //                on 116 Vero days (2026-05-11 backtest).
  //
  // We pre-fetch one consolidated prediction per future date in the
  // range so the inner loop is sync. Past days fall back to actuals
  // regardless of flag.
  const v2ChartFlagOn = await isPredictionV2FlagEnabled(bizId, 'PREDICTION_V2_DASHBOARD_CHART', db)
  const consolidatedRevByDate: Record<string, number> = {}

  // ── Shadow-mode capture (2026-05-19 forward-horizon fix) ──────────────
  // Phase 0 measurement surfaced that we have ZERO h>1 resolved rows on
  // consolidated_daily. Root cause: this branch only ran when v2 was ON,
  // and even then it called dailyForecast with skipLogging:true. So the
  // capture path never fired from real-user dashboard hits.
  //
  // New rule: ALWAYS run dailyForecast for every future date in the
  // requested range, with skipLogging:false so capture rows land in
  // daily_forecast_outcomes at their actual horizon (forecast_date -
  // today). Whether we USE the consolidated value downstream depends on
  // the flag (consolidatedRevByDate is only populated when v2 is on),
  // but the capture happens unconditionally. After 1-2 weeks of shadow
  // capture we'll finally have apples-to-apples h=1..14 comparison data.
  const futureDates = Object.keys(currentByDate)
    .filter(d => (actualByDateInRange[d] ?? 0) <= 0)
    .sort()
  const results = await Promise.allSettled(
    futureDates.map(async d => {
      const fc = await dailyForecast(bizId, new Date(d + 'T12:00:00Z'), { db, skipLogging: false })
      return { date: d, predicted: fc.predicted_revenue }
    }),
  )
  if (v2ChartFlagOn) {
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.predicted > 0) {
        consolidatedRevByDate[r.value.date] = r.value.predicted
      }
    }
  }

  // ── Meal-period predictions (Nordic Plan Phase A week 3) ───────────────
  // Pre-load 12 weeks of hourly_metrics once + this-week-so-far rows once,
  // then call hourlyForecast() per (date, meal_period, hour) with the
  // preloaded data so we don't burn 400+ queries on the per-cell math.
  // Detected meal periods are intersected with the business's universal
  // Swedish meal-period map (lunch / afternoon / dinner / late).
  const HOURLY_HISTORY_WEEKS = 12
  const historyFromIso = (() => {
    const d = new Date(rangeStart)
    d.setDate(d.getDate() - HOURLY_HISTORY_WEEKS * 7)
    return d.toISOString().slice(0, 10)
  })()
  const weekStartIsoForHourly = (() => {
    const d = new Date(rangeStart)
    // mondayOf semantics: rangeStart should already be Monday for next-week
    // mode, but for arbitrary from/to it may not be. Walk back to Monday.
    const wd = d.getUTCDay() || 7
    d.setUTCDate(d.getUTCDate() - (wd - 1))
    return d.toISOString().slice(0, 10)
  })()
  const [hourlyHistoryRes, hourlyThisWeekRes] = await Promise.all([
    db.from('hourly_metrics')
      .select('business_date, hour, revenue, covers')
      .eq('business_id', bizId)
      .gte('business_date', historyFromIso)
      .lt('business_date',  weekFrom),
    db.from('hourly_metrics')
      .select('business_date, hour, revenue, covers')
      .eq('business_id', bizId)
      .gte('business_date', weekStartIsoForHourly)
      .lt('business_date',  weekFrom),
  ])
  const hourlyHistory  = (hourlyHistoryRes.data  ?? []) as any[]
  const hourlyThisWeek = (hourlyThisWeekRes.data ?? []) as any[]
  const detectedMealPeriods = detectMealPeriods(hourlyHistory)

  // Per-meal-period historical P75 rev/hour. We DON'T have shift-level
  // start/end times in staff_logs, so we proxy meal-period hours by
  // distributing daily_metrics.hours_worked proportionally to that day's
  // revenue share within the meal period:
  //   lunch_hours[day] ≈ total_hours[day] × (lunch_rev[day] / daily_rev[day])
  //
  // Crude — lunch typically uses ~50 % more staff per revenue krona than
  // dinner (prep-heavy, lower covers-per-hour) — but the directional
  // signal holds. When customer #N's PK pull includes hourly staff
  // attribution (or we add it), swap the proxy for actuals.
  //
  // Output: p75RphByMeal[label] = 75th percentile rev/hour across days
  // with sufficient signal. Used as the model's target rev/hour when
  // computing per-meal-period cut recommendations below.
  const hourlyHistoryByDate: Record<string, Record<number, number>> = {}
  for (const r of hourlyHistory) {
    if (!hourlyHistoryByDate[r.business_date]) hourlyHistoryByDate[r.business_date] = {}
    hourlyHistoryByDate[r.business_date][r.hour] = Number(r.revenue ?? 0)
  }
  const dailyByDate: Record<string, { revenue: number; hours: number }> = {}
  for (const r of (daily ?? []) as any[]) {
    if (Number(r.revenue ?? 0) > 0 && Number(r.hours_worked ?? 0) > 0) {
      dailyByDate[r.date] = { revenue: Number(r.revenue), hours: Number(r.hours_worked) }
    }
  }
  const p75RphByMeal: Record<string, number> = {}
  for (const cluster of detectedMealPeriods) {
    const rphSamples: number[] = []
    for (const [date, d] of Object.entries(dailyByDate)) {
      const dayHourly = hourlyHistoryByDate[date]
      if (!dayHourly) continue
      const mealRev = cluster.hours.reduce((s, h) => s + (dayHourly[h] ?? 0), 0)
      if (mealRev <= 0 || d.revenue <= 0) continue
      const mealHoursProxy = d.hours * (mealRev / d.revenue)
      if (mealHoursProxy >= 0.5) {
        rphSamples.push(mealRev / mealHoursProxy)
      }
    }
    if (rphSamples.length >= 3) {
      rphSamples.sort((a, b) => a - b)
      p75RphByMeal[cluster.label] = rphSamples[Math.floor(rphSamples.length * 0.75)]
    } else {
      p75RphByMeal[cluster.label] = 0  // insufficient data → no recommendation
    }
  }

  // Distribute each scheduled shift's hours across the detected meal periods
  // by intersecting Stockholm-local shift hours with meal-period buckets.
  // Map: `${date}|${meal_label}` → { hours, cost }
  type ShiftSlot = { hours: number; cost: number }
  const scheduledByDateMeal: Record<string, ShiftSlot> = {}
  for (const shift of scheduledRows) {
    if (!shift.shift_start_iso || !shift.shift_end_iso) continue
    const distribution = distributeShiftHoursAcrossMealPeriods(
      shift.shift_start_iso,
      shift.shift_end_iso,
      Number(shift.breaks_duration ?? 0),
      detectedMealPeriods,
    )
    const costPerHour = Number(shift.hours_worked) > 0
      ? Number(shift.estimated_salary ?? 0) / Number(shift.hours_worked)
      : 0
    for (const { label, hours } of distribution) {
      const key = `${shift.shift_date}|${label}`
      if (!scheduledByDateMeal[key]) scheduledByDateMeal[key] = { hours: 0, cost: 0 }
      scheduledByDateMeal[key].hours += hours
      scheduledByDateMeal[key].cost  += hours * costPerHour
    }
  }

  // Per-date hourly + meal-period predictions.
  // hourlyDemandByDate[date] = full 24-hour array for the rota view's
  //                            demand curve overlay
  // mealPredictionsByDate[date] = aggregated per-meal-period for cards/cuts
  const mealPredictionsByDate: Record<string, any[]> = {}
  const hourlyDemandByDate:    Record<string, Array<{
    hour:              number
    predicted_revenue: number
    predicted_covers:  number
    is_closed:         boolean
    confidence:        'high' | 'medium' | 'low'
  }>> = {}
  if (detectedMealPeriods.length > 0 && hourlyHistory.length > 0) {
    const futureDates = Object.keys(currentByDate).filter(d => (actualByDateInRange[d] ?? 0) <= 0)
    await Promise.all(futureDates.map(async dateIso => {
      const forecastDate = new Date(dateIso + 'T12:00:00Z')
      // Predict every hour 0-23 in parallel — preloaded history makes
      // this cheap (no DB roundtrips inside the helper).
      const allHourPreds = await Promise.all(Array.from({ length: 24 }, (_, h) =>
        hourlyForecast(bizId, forecastDate, h, {
          db,
          preloadedHistory:  hourlyHistory,
          preloadedThisWeek: hourlyThisWeek,
        }),
      ))
      const hourLookup: Record<number, any> = {}
      for (const fc of allHourPreds) hourLookup[fc.hour] = fc
      hourlyDemandByDate[dateIso] = allHourPreds.map(fc => ({
        hour:              fc.hour,
        predicted_revenue: fc.predicted_revenue,
        predicted_covers:  fc.predicted_covers,
        is_closed:         fc.is_closed_hour,
        confidence:        fc.confidence,
      }))

      const perPeriod = detectedMealPeriods.map(cluster => {
        const hourly = cluster.hours.map(h => hourLookup[h])
        const predictedRev    = hourly.reduce((s, r) => s + r.predicted_revenue, 0)
        const predictedCovers = hourly.reduce((s, r) => s + r.predicted_covers,  0)
        // Confidence = worst of constituent hours.
        const conf: 'high' | 'medium' | 'low' =
          hourly.some(h => h.confidence === 'low')    ? 'low'
          : hourly.some(h => h.confidence === 'medium') ? 'medium'
          : 'high'
        const scheduled = scheduledByDateMeal[`${dateIso}|${cluster.label}`] ?? { hours: 0, cost: 0 }
        const revPerHour = scheduled.hours > 0 ? Math.round(predictedRev / scheduled.hours) : null

        // Cut recommendation (cuts-only, same asymmetric policy as daily).
        // Skip when:
        //   - p75 unavailable (insufficient history per the proxy)
        //   - no shifts scheduled for this period (nothing to cut)
        //   - confidence is 'low' (don't drive ops decisions on noise)
        const targetRph = p75RphByMeal[cluster.label] ?? 0
        const costPerHour = scheduled.hours > 0 ? scheduled.cost / scheduled.hours : 0
        let modelTargetHours: number | null = null
        let targetHours:      number | null = null
        let deltaHours = 0
        let deltaCost  = 0
        if (targetRph > 0 && scheduled.hours > 0 && conf !== 'low') {
          modelTargetHours = predictedRev / targetRph
          // Cuts only — never recommend adding hours per the existing policy.
          targetHours = Math.min(scheduled.hours, modelTargetHours)
          deltaHours = Math.round((targetHours - scheduled.hours) * 10) / 10  // ≤ 0
          deltaCost  = Math.round(deltaHours * costPerHour)                    // ≤ 0
        }
        return {
          label:               cluster.label,
          hours_in_period:     cluster.hours,
          predicted_revenue:   Math.round(predictedRev),
          predicted_covers:    Math.round(predictedCovers),
          scheduled_hours:     Math.round(scheduled.hours * 10) / 10,
          scheduled_cost:      Math.round(scheduled.cost),
          rev_per_hour:        revPerHour,
          confidence:          conf,
          // Phase A week 3 (continued) — cut recommendations per period.
          target_rev_per_hour: targetRph > 0 ? Math.round(targetRph) : null,
          model_target_hours:  modelTargetHours != null ? Math.round(modelTargetHours * 10) / 10 : null,
          target_hours:        targetHours != null ? Math.round(targetHours * 10) / 10 : null,
          delta_hours:         deltaHours,    // ≤ 0, negative = cut
          delta_cost:          deltaCost,     // ≤ 0, negative = saving
        }
      })
      mealPredictionsByDate[dateIso] = perPeriod
    }))
  }

  // ── Suggested schedule: target rev-per-hour at 75th percentile of history ─
  // If last 8 weeks Mon averaged 25k rev at 40h (= 625 kr/h), and the best Mons
  // ran 800 kr/h with 32h, target 32h next Monday on a 25k forecast = "8h less
  // than current if they have 40h scheduled".
  //
  // Choice of P75 rev-per-hour as target: aggressive enough to save hours, not
  // so aggressive that service suffers. P50 would be "match average" = no
  // gain. P90 would risk understaffing on high-demand days.
  //
  // ── Policy: asymmetric toward cuts ─────────────────────────────────────────
  // We never recommend *adding* hours. Reasoning: if we suggest a cut and the
  // day is slower than expected, the customer saves more than we predicted
  // (still strictly a win). If we suggest an add and the extra demand doesn't
  // materialise, the customer spends real money on labour against our advice.
  // The asymmetric liability means the safe default is: model target is used
  // only to trim, never to pad. Where the model *would* have added, we emit
  // an informational note ("your schedule looks lighter than the 12-week
  // pattern — no recommendation, judgment call") instead of a numeric delta.
  const suggested: any[] = []
  for (const date of Object.keys(currentByDate).sort()) {
    const dow = (new Date(date).getUTCDay() + 6) % 7
    const d   = byDow[dow]

    // Weather-aware refinement: if we have a forecast for this date AND we've
    // seen ≥3 historical days with the same (weekday, bucket) combination,
    // use THAT subset's rev/hour + revenue expectation. Otherwise fall back
    // to plain all-weather weekday averages.
    const fcast = wxNextByDate[date]
    const bucket = fcast ? weatherBucket(fcast) : null
    const bucketKey = bucket ? `${dow}|${bucket}` : null
    const bucketData = bucketKey ? byDowBucket[bucketKey] : null

    const useBucket       = !!(bucketData && bucketData.rev.length >= 3)
    const sourceRev       = useBucket ? bucketData!.rev        : d.rev
    const sourceHours     = useBucket ? bucketData!.hours      : d.hours
    const sourceRph       = useBucket ? bucketData!.revPerHour : d.revPerHour
    const sourceRevDates  = useBucket ? bucketData!.dates      : d.dates
    const sourceHoursDates= useBucket ? bucketData!.dates      : d.dates

    // Recency-weighted: last 4 weeks count 2× weeks 5-12. P75 still uses
    // raw values because percentiles aren't a "what's the typical day"
    // statistic — they're a "what's a good day" target.
    const rawAvgRev = wAvg(sourceRev, sourceRevDates)
    // Scaler applies to days that DON'T already have an actual — past
    // days within the period keep their actual value as the prediction
    // (no scaling needed; the truth IS the actual).
    const dayHasActual = (actualByDateInRange[date] ?? 0) > 0
    // V2 cutover: if PREDICTION_V2_DASHBOARD_CHART is on for this business
    // AND we have a consolidated prediction for this date, use it. Falls
    // back to legacy math if the consolidated call failed for any reason
    // (soft-fail: never block the dashboard).
    const consolidatedRev = v2ChartFlagOn ? consolidatedRevByDate[date] : undefined
    const avgRev = Math.round(
      dayHasActual
        ? rawAvgRev
        : (consolidatedRev != null ? consolidatedRev : rawAvgRev * thisWeekScale),
    )
    const avgHours    = Math.round(wAvg(sourceHours, sourceHoursDates) * 10) / 10
    const sortedRph   = [...sourceRph].sort((a, b) => a - b)
    const p75Rph      = sortedRph.length ? sortedRph[Math.floor(sortedRph.length * 0.75)] : 0
    const modelTarget = avgRev > 0 && p75Rph > 0 ? Math.round((avgRev / p75Rph) * 10) / 10 : avgHours

    const current   = currentByDate[date]
    // Cap the recommendation at the currently-scheduled hours — we never
    // propose adding. "Under-staffed vs model" surfaces as a soft note below.
    const targetHours = Math.min(current.hours, modelTarget)
    const deltaHrs  = Math.round((targetHours - current.hours) * 10) / 10
    const avgCostPerHour = current.hours > 0 ? current.est_cost / current.hours : 0
    const deltaCost = Math.round(deltaHrs * avgCostPerHour)  // ≤ 0 by construction
    const modelWouldAdd = modelTarget > current.hours + 2 && sourceRev.length >= 3

    // Plain-language weather labels — "wet" / "cold_dry" etc. are internal
    // tags and leak jargon into the rationale if used raw.
    const BUCKET_LABEL: Record<string, string> = {
      clear:   'clear days',
      mild:    'mild days',
      cold_dry:'cold days',
      wet:     'rainy days',
      snow:    'snowy days',
      freezing:'freezing days',
      hot:     'hot days',
      thunder: 'stormy days',
    }
    const weatherLabel = bucket ? (BUCKET_LABEL[bucket] ?? `${bucket} days`) : null
    const dayName = DAYS[dow]
    const cutKr = Math.abs(deltaCost)

    const rationale = (() => {
      if (sourceRev.length < 3) {
        return `Only ${sourceRev.length} ${dayName}${sourceRev.length === 1 ? '' : 's'} of history yet — not enough signal. Holding your schedule.`
      }
      if (modelWouldAdd) {
        // Informational only. No monetary claim. Owner judgment call.
        const ctxLabel = useBucket ? `${dayName}s with similar weather` : `${dayName}s`
        return `${dayName}: your ${ctxLabel} average ${fmtKr(avgRev)} on ${avgHours}h. You've scheduled ${current.hours}h — lighter than your pattern. Not suggesting an add: only you know the booking outlook.`
      }
      if (Math.abs(deltaHrs) < 2) {
        return `${dayName}: your ${current.hours}h matches the ${useBucket ? `${weatherLabel} ` : ''}pattern. No change.`
      }
      // deltaHrs is negative here — a cut.
      const ctxLabel = useBucket
        ? `${weatherLabel} on a ${dayName} (${sourceRev.length} in your history)`
        : `${dayName}s (${sourceRev.length} in your history)`
      return `${ctxLabel} average ${fmtKr(avgRev)} rev and only need about ${targetHours}h of cover at your top pace. You have ${current.hours}h — trim ${Math.abs(deltaHrs)}h to save ~${fmtKr(cutKr)}.`
    })()

    suggested.push({
      date,
      weekday:       current.weekday,
      hours:         targetHours,
      est_cost:      Math.round(current.est_cost + deltaCost),
      est_revenue:   avgRev,
      rev_per_hour:  Math.round(p75Rph),
      model_target_hours: modelTarget,  // what the model would have picked un-capped
      under_staffed_note: modelWouldAdd, // UI hint: show informational style
      delta_hours:   deltaHrs,          // always ≤ 0
      delta_cost:    deltaCost,         // always ≤ 0
      weather:       fcast ? {
        summary:  fcast.summary,
        temp_min: fcast.temp_min, temp_max: fcast.temp_max,
        precip_mm: fcast.precip_mm,
        bucket,
      } : null,
      bucket_days_seen: useBucket ? bucketData!.rev.length : 0,
      reasoning:     rationale,
      // Phase A week 3: per-meal-period predictions + scheduled hours.
      // Empty array when:
      //   - business has no hourly_metrics yet (backfill not run)
      //   - the day is in the past and consumed actuals instead
      meal_periods:  mealPredictionsByDate[date] ?? [],
      // Phase A week 3.5: full-day demand curve for the Nory-style rota
      // visualization. 24-element array; downstream renders the open
      // hours and overlays scheduled shifts from current[i].shift_list.
      hourly_demand: hourlyDemandByDate[date] ?? [],
    })
  }

  // ── Audit ledger capture (Piece 1, M059) ──────────────────────────────────
  // Phase A "shadow mode" — we log every revenue prediction this endpoint
  // emits to daily_forecast_outcomes. The reconciler at 10:00 UTC pairs each
  // row against actual revenue once daily_metrics catches up. Soft-fails;
  // never blocks the response. Backtest write guard inside captureForecastOutcomes
  // skips past dates so dashboard back-test calls don't pollute MAPE-by-horizon.
  //
  // 2026-05-19 update: write BOTH captures regardless of v2 flag. When v2 is
  // on, suggested[].est_revenue is the consolidated value — capture it as
  // scheduling_ai_revenue ONLY when the legacy math produced it (v2 flag
  // off). The consolidated_daily capture is handled by dailyForecast itself
  // (skipLogging:false above). This way we get apples-to-apples h=1..14
  // comparison data from both surfaces emitted by the same dashboard hit.
  if (!v2ChartFlagOn) await captureForecastOutcomes(
    suggested
      .filter((s: any) => s.est_revenue > 0)
      .map((s: any) => ({
        org_id:           biz.org_id,
        business_id:      bizId,
        forecast_date:    s.date,
        surface:          'scheduling_ai_revenue' as const,
        predicted_revenue: s.est_revenue,
        baseline_revenue:  null,            // legacy forecaster doesn't separate baseline from final prediction
        model_version:    'scheduling_ai_v1.0',
        snapshot_version: 'legacy_v1' as const,
        inputs_snapshot: {
          snapshot_version:                  'legacy_scheduling_ai_v1',
          weekday:                            s.weekday,
          weather_bucket:                     s.weather?.bucket ?? null,
          weather_summary:                    s.weather?.summary ?? null,
          bucket_days_seen:                   s.bucket_days_seen ?? 0,
          this_week_scaler_applied:           Math.round(thisWeekScale * 100) / 100,
          this_week_scaler_raw:               Math.round(thisWeekRaw   * 100) / 100,
          this_week_scaler_samples:           thisWeekSamples,
          recency_weighted:                   true,
          recency_window_days:                RECENCY.RECENT_WINDOW_DAYS,
          recency_multiplier:                 RECENCY.RECENCY_MULTIPLIER,
          model_target_hours:                 s.model_target_hours,
          chosen_target_hours:                s.hours,
          under_staffed_note:                 !!s.under_staffed_note,
          data_quality_flags:                 [],
        },
      })),
  )

  const curHours = Object.values(currentByDate).reduce((s: number, r: any) => s + r.hours, 0)
  const sugHours = suggested.reduce((s: number, r: any) => s + r.hours, 0)
  // Savings only — deltaCost is ≤0 by construction, so savings are the
  // absolute sum. Kept `added_cost_kr: 0` + `net_saving_kr` for API stability.
  const savingKr = Math.round(suggested.reduce((s: number, r: any) => s + (r.delta_cost < 0 ? -r.delta_cost : 0), 0))
  const underStaffedDays = suggested.filter((s: any) => s.under_staffed_note).length

  return NextResponse.json({
    week_from:       weekFrom,
    week_to:         weekTo,
    business_name:   biz.name,
    pk_shifts_found: scheduledRows.length,
    pk_fetch_error:  liveFetchError,
    // Diagnostics for the UI: if pk_shifts_found is 0, this tells us why.
    // 'periods_returned=0' means PK responded OK but has no shifts published
    // for this week yet. 'pk_fetch_error' means the token or endpoint broke.
    // 'integration_status' shows whether the row is still marked connected.
    diag: {
      integration_status: integrationStatus,
      periods_returned:   periodsReturned,
    },
    current:         Object.values(currentByDate),
    suggested,
    summary: {
      current_hours:    Math.round(curHours * 10) / 10,
      suggested_hours:  Math.round(sugHours * 10) / 10,
      saving_kr:        savingKr,
      added_cost_kr:    0,
      net_saving_kr:    savingKr,
      under_staffed_days: underStaffedDays,
      // v8.1 forecast tuning: surface the recency model's response so
      // callers can SEE that the prediction adapted to this week.
      this_week_scaler:        Math.round(thisWeekScale * 100) / 100,
      this_week_scaler_raw:    Math.round(thisWeekRaw   * 100) / 100,
      this_week_scaler_samples: thisWeekSamples,
      recency_weighted:        true,
      rationale:        'Cuts only — we never recommend adding hours. Adding exposes the business to labour cost on days where the extra demand may not show up; trimming only risks slightly more savings than projected. Target rev-per-hour is the 75th-percentile of your last 12 weeks (recency-weighted: last 4 weeks count 2× the older 8); where the forecast matches ≥3 days of the same weekday+weather combination (e.g. rainy Friday), that subset drives the target. When this week is running materially above or below pattern, remaining-day forecasts are scaled by the same ratio (clamped 0.75-1.25). Days where the model would have added are shown with an informational note — a judgment call for you, not a recommendation from us.',
    },
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}

// ── Shift / meal-period hour distribution ────────────────────────────────────
// Each scheduled shift spans some Stockholm-local hours. The hourly
// forecaster reasons in (weekday × hour) cells. To make per-meal-period
// scheduled-vs-predicted comparisons, we need to know how many of each
// shift's hours fall inside each detected meal-period bucket.
//
// Method: walk the shift hour-by-hour, classify each hour by its
// Stockholm-local position, and bucket it into the meal-period cluster
// that owns that hour (if any). Fractional hour at start/end is
// preserved. Break minutes are distributed across the bucketed hours
// proportionally (no PK signal for WHICH hours a break falls in).
function distributeShiftHoursAcrossMealPeriods(
  startIso:  string,
  endIso:    string,
  breakSec:  number,
  periods:   MealPeriodCluster[],
): Array<{ label: MealPeriodLabel; hours: number }> {
  const result = new Map<MealPeriodLabel, number>()
  for (const p of periods) result.set(p.label, 0)

  const start = new Date(startIso)
  const end   = new Date(endIso)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return []
  if (end <= start) return []

  // Iterate the shift in 5-minute slices — small enough to handle a
  // 10:55-11:05 boundary correctly (5 min lands in pre-lunch, 5 in lunch),
  // big enough to keep the inner loop cheap (~120 slices for a 10-hour shift).
  const SLICE_MIN = 5
  const SLICE_MS  = SLICE_MIN * 60_000
  for (let t = start.getTime(); t < end.getTime(); t += SLICE_MS) {
    const sliceEnd = Math.min(end.getTime(), t + SLICE_MS)
    const sliceHrs = (sliceEnd - t) / 3_600_000
    const localHour = stockholmLocalHourOf(new Date(t))
    const period = periods.find(p => p.hours.includes(localHour))
    if (period) {
      result.set(period.label, (result.get(period.label) ?? 0) + sliceHrs)
    }
  }

  // Distribute breaks proportionally across the meal periods that received hours.
  const totalHrs = Array.from(result.values()).reduce((s, h) => s + h, 0)
  if (totalHrs > 0 && breakSec > 0) {
    const breakHrs = breakSec / 3600
    for (const [label, hours] of Array.from(result)) {
      const share = hours / totalHrs
      const adjusted = Math.max(0, hours - breakHrs * share)
      result.set(label, adjusted)
    }
  }

  return Array.from(result, ([label, hours]) => ({ label, hours }))
    .filter(slot => slot.hours > 0)
}

function stockholmLocalHourOf(d: Date): number {
  try {
    const hourStr = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Stockholm', hour: '2-digit', hour12: false,
    }).format(d)
    return parseInt(hourStr, 10)
  } catch {
    return d.getUTCHours()  // best-effort fallback
  }
}

function fmtKr(n: number): string {
  return Math.round(n).toLocaleString('en-GB') + ' kr'
}
