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
import { weightedAvg, thisWeekScaler, RECENCY } from '@/lib/forecast/recency'
import { captureForecastOutcomes }              from '@/lib/forecast/audit'

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
  }

  // ── Historical pattern: last 12 complete weeks of daily_metrics + weather ─
  // The history window ends the day before the target range starts, so a
  // prediction never peeks at data from within the period it's predicting.
  const histEnd = new Date(rangeStart); histEnd.setDate(rangeStart.getDate() - 1)
  const histStart = new Date(histEnd); histStart.setDate(histEnd.getDate() - 7 * 12)
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
      recentWindowDays:  RECENCY.RECENT_WINDOW_DAYS,
      recencyMultiplier: RECENCY.RECENCY_MULTIPLIER,
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
    const avgRev      = Math.round(dayHasActual ? rawAvgRev : rawAvgRev * thisWeekScale)
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
    })
  }

  // ── Audit ledger capture (Piece 1, M059) ──────────────────────────────────
  // Phase A "shadow mode" — we log every revenue prediction this endpoint
  // emits to daily_forecast_outcomes. The reconciler at 10:00 UTC pairs each
  // row against actual revenue once daily_metrics catches up. Soft-fails;
  // never blocks the response. Backtest write guard inside captureForecastOutcomes
  // skips past dates so dashboard back-test calls don't pollute MAPE-by-horizon.
  await captureForecastOutcomes(
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

function fmtKr(n: number): string {
  return Math.round(n).toLocaleString('en-GB') + ' kr'
}
