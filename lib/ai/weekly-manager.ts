// lib/ai/weekly-manager.ts
//
// Generates a Claude-written "weekly manager memo" per business — a personal,
// opinionated analysis with 3 numbered actions each with SEK impact.
//
// Not a template digest — this is prose. The goal is: the owner reads it and
// thinks "the AI noticed something I missed" at least once a month.
//
// Called from app/api/cron/weekly-digest/route.ts (Monday 06:00 UTC). Tokens
// + cost logged to ai_request_log via logAiRequest.

import { AI_MODELS, MAX_TOKENS } from '@/lib/ai/models'
import { logAiRequest }          from '@/lib/ai/usage'
import { SCOPE_NOTE }            from '@/lib/ai/scope'
import { SCHEDULING_ASYMMETRY, VOICE, INDUSTRY_BENCHMARKS } from '@/lib/ai/rules'
import { getForecast, coordsFor, DailyWeather, weatherBucket } from '@/lib/weather/forecast'
import { computeDemandForecast, type DemandForecast }           from '@/lib/weather/demand'
import { getUpcomingHolidays } from '@/lib/holidays'
import { signFeedback }          from '@/lib/email/feedback-token'

type Db = any

export interface ManagerMemo {
  narrative:   string        // The 150–200 word memo
  actions:     Array<{
    title:     string
    impact:    string        // e.g. "+4 200 kr/wk"
    reasoning: string
  }>
  facts_cited: string[]      // Structured list of facts the memo relies on
}

export interface WeeklyContext {
  businessName: string
  weekLabel:    string       // "Week 14 — 6 Apr to 12 Apr 2026"
  thisWeek:     WeekBlock
  lastWeek:     WeekBlock
  prior4Weeks:  WeekBlock[]  // oldest first, excludes this + last week
  monthToDate:  MonthBlock
  openAlerts:   Array<{ title: string; severity: string; description: string }>
  budget:       { revenue_target: number; food_cost_pct_target: number; staff_cost_pct_target: number } | null
  departments:  Array<{ name: string; revenue: number; labour_pct: number | null }>
  weekdayPattern: Array<{ weekday: string; avg_rev: number; avg_hours: number; avg_labour_pct: number | null }>
  upcomingWeather: DailyWeather[]  // next 7 days — empty array if fetch failed
  // Historical weather↔sales correlation. Only populated after backfill has run.
  weatherPattern: Array<{
    bucket:     string           // 'clear' | 'wet' | 'snow' | ...
    days:       number
    avg_rev:    number
    avg_labour: number | null
    rev_delta_pct: number        // vs overall avg for this business
  }>
  // Next-week forecast matched to the best historical analogue (e.g. "wet Fri")
  nextWeekAnalogues: Array<{
    date:            string
    weekday:         string
    forecast_summary: string     // "Rain, 4-9°C, 0.6mm"
    bucket:          string
    analogue_days:   number      // how many matching (weekday, bucket) days we've seen
    analogue_avg_rev: number | null
    all_weather_avg_rev: number   // for comparison
  }>
  // Upcoming public holidays in the next ~21 days, country-aware. The
  // weekly memo runs on Monday, so 21 days covers the upcoming week +
  // the two after — enough for the AI to flag e.g. "Midsummer Eve in
  // 12 days, plan staffing now". Empty when no holidays in the window.
  upcomingHolidays: Array<{
    date:    string                            // YYYY-MM-DD
    name:    string                            // local-language name
    kind:    'public' | 'observed'
    impact:  'high' | 'low' | null
    days_until: number
  }>
  // Per-day demand forecast for the next 7 days — predicted revenue +
  // delta vs typical + per-day recommendation. Populated when this
  // business has enough weather × revenue history; null otherwise so
  // the prompt can omit the block cleanly.
  demandForecast: DemandForecast | null
}

interface WeekBlock {
  from:         string
  to:           string
  revenue:      number
  staff_cost:   number
  labour_pct:   number | null
  hours:        number
  shifts:       number
  covers:       number
}

interface MonthBlock {
  year:        number
  month:       number
  revenue:     number
  staff_cost:  number
  food_cost:   number
}

// ─────────────────────────────────────────────────────────────────────────────
// Build the context blob — what we feed to Claude.
// ─────────────────────────────────────────────────────────────────────────────
export async function buildWeeklyContext(
  db:           Db,
  orgId:        string,
  businessId:   string,
  businessName: string,
  mondayOfBriefing: Date,  // the Monday AFTER the week being summarised
  businessCity: string | null = null,  // used for weather coord lookup
  businessCountry: string | null = null,  // used for upcoming-holiday lookup
): Promise<WeeklyContext> {
  const lastSunday = new Date(mondayOfBriefing); lastSunday.setDate(lastSunday.getDate() - 1)
  const lastMonday = new Date(mondayOfBriefing); lastMonday.setDate(lastMonday.getDate() - 7)
  const toDate     = lastSunday.toISOString().slice(0, 10)
  const fromDate   = lastMonday.toISOString().slice(0, 10)

  const weekBefore = new Date(lastMonday); weekBefore.setDate(weekBefore.getDate() - 7)
  const weekBeforeTo = new Date(lastSunday); weekBeforeTo.setDate(weekBeforeTo.getDate() - 7)

  const priorStart = new Date(weekBefore); priorStart.setDate(priorStart.getDate() - 28)
  const priorEnd   = new Date(weekBefore); priorEnd.setDate(priorEnd.getDate() - 1)

  // 6 weeks of daily_metrics to cover: this week, last week, 4 prior weeks.
  const { data: dailies } = await db
    .from('daily_metrics')
    .select('date, revenue, staff_cost, hours_worked, shifts, covers, labour_pct')
    .eq('business_id', businessId)
    .gte('date', priorStart.toISOString().slice(0, 10))
    .lte('date', toDate)
    .order('date', { ascending: true })

  const weekBlock = (from: Date, to: Date): WeekBlock => {
    const fromS = from.toISOString().slice(0, 10)
    const toS   = to.toISOString().slice(0, 10)
    const rows  = (dailies ?? []).filter((r: any) => r.date >= fromS && r.date <= toS)
    const rev    = rows.reduce((s: number, r: any) => s + Number(r.revenue ?? 0), 0)
    const cost   = rows.reduce((s: number, r: any) => s + Number(r.staff_cost ?? 0), 0)
    const hours  = rows.reduce((s: number, r: any) => s + Number(r.hours_worked ?? 0), 0)
    const shifts = rows.reduce((s: number, r: any) => s + Number(r.shifts ?? 0), 0)
    const covers = rows.reduce((s: number, r: any) => s + Number(r.covers ?? 0), 0)
    return {
      from: fromS, to: toS,
      revenue: Math.round(rev), staff_cost: Math.round(cost),
      labour_pct: rev > 0 ? Math.round((cost / rev) * 1000) / 10 : null,
      hours: Math.round(hours * 10) / 10, shifts, covers,
    }
  }

  const thisWeek = weekBlock(lastMonday, lastSunday)
  const lastWeekBlk = weekBlock(weekBefore, weekBeforeTo)

  const prior4Weeks: WeekBlock[] = []
  for (let i = 4; i >= 2; i--) {
    const wStart = new Date(lastMonday); wStart.setDate(wStart.getDate() - 7 * i)
    const wEnd   = new Date(lastSunday); wEnd.setDate(wEnd.getDate() - 7 * i)
    prior4Weeks.push(weekBlock(wStart, wEnd))
  }

  // Weekday pattern: avg per day-of-week from the 4 prior weeks.
  const byDow: Record<number, { rev: number[]; hours: number[]; labour: number[] }> = {}
  for (let d = 0; d < 7; d++) byDow[d] = { rev: [], hours: [], labour: [] }
  for (const r of (dailies ?? [])) {
    if (!r.date) continue
    if (r.date > priorEnd.toISOString().slice(0, 10)) continue  // only 4 prior weeks
    const dow = (new Date(r.date).getUTCDay() + 6) % 7          // Mon=0 … Sun=6
    byDow[dow].rev.push(Number(r.revenue ?? 0))
    byDow[dow].hours.push(Number(r.hours_worked ?? 0))
    if (r.labour_pct != null) byDow[dow].labour.push(Number(r.labour_pct))
  }
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const avg = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0
  const weekdayPattern = DAYS.map((label, i) => ({
    weekday:         label,
    avg_rev:         Math.round(avg(byDow[i].rev)),
    avg_hours:       Math.round(avg(byDow[i].hours) * 10) / 10,
    avg_labour_pct:  byDow[i].labour.length ? Math.round(avg(byDow[i].labour) * 10) / 10 : null,
  }))

  // Month-to-date at time of the briefing.
  const mtdMonth = lastSunday.getMonth() + 1
  const mtdYear  = lastSunday.getFullYear()
  const { data: mm } = await db
    .from('monthly_metrics')
    .select('revenue, staff_cost, food_cost')
    .eq('business_id', businessId)
    .eq('year',  mtdYear)
    .eq('month', mtdMonth)
    .maybeSingle()
  const monthToDate: MonthBlock = {
    year: mtdYear, month: mtdMonth,
    revenue:    Number(mm?.revenue    ?? 0),
    staff_cost: Number(mm?.staff_cost ?? 0),
    food_cost:  Number(mm?.food_cost  ?? 0),
  }

  // Budget for this month
  const { data: bud } = await db
    .from('budgets')
    .select('revenue_target, food_cost_pct_target, staff_cost_pct_target')
    .eq('business_id', businessId).eq('year', mtdYear).eq('month', mtdMonth)
    .maybeSingle()

  // Last 14 days of open alerts
  const sinceAlerts = new Date(lastMonday); sinceAlerts.setDate(sinceAlerts.getDate() - 14)
  const { data: alerts } = await db
    .from('anomaly_alerts')
    .select('title, severity, description, created_at')
    .eq('business_id', businessId)
    .gte('created_at', sinceAlerts.toISOString())
    .order('created_at', { ascending: false })
    .limit(5)

  // Dept breakdown for this week
  const { data: deptRows } = await db
    .from('dept_metrics')
    .select('dept_name, revenue, staff_cost, labour_pct, year, month')
    .eq('business_id', businessId)
    .eq('year',  mtdYear)
    .eq('month', mtdMonth)
  const departments = (deptRows ?? [])
    .map((d: any) => ({
      name:        d.dept_name,
      revenue:     Number(d.revenue ?? 0),
      labour_pct:  d.labour_pct != null ? Number(d.labour_pct) : null,
    }))
    .sort((a: any, b: any) => b.revenue - a.revenue)

  const weekLabel = `${lastMonday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${lastSunday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`

  // ── Upcoming weather (next 7 days) ─────────────────────────────────────────
  // Failure is non-fatal — AI memo renders fine without weather.
  let upcomingWeather: DailyWeather[] = []
  try {
    const { lat, lon } = coordsFor(businessCity)
    const forecast = await getForecast(lat, lon)
    const todayIso = new Date().toISOString().slice(0, 10)
    upcomingWeather = forecast.filter(d => d.date >= todayIso).slice(0, 7)
  } catch (e: any) {
    console.warn('[weekly-manager] weather fetch failed:', e.message)
  }

  // ── Historical weather × sales (only if weather_daily has been backfilled) ─
  // Join observed weather to daily_metrics, group by bucket, compute deltas.
  // Also compute "analogue" match for each upcoming day — the historical
  // (weekday, bucket) sample that most closely matches next week's forecast.
  let weatherPattern: WeeklyContext['weatherPattern'] = []
  let nextWeekAnalogues: WeeklyContext['nextWeekAnalogues'] = []
  try {
    const priorStartIso = priorStart.toISOString().slice(0, 10)
    const lastSundayIso = lastSunday.toISOString().slice(0, 10)
    const { data: wx } = await db
      .from('weather_daily')
      .select('date, temp_avg, precip_mm, weather_code, summary, is_forecast')
      .eq('business_id', businessId)
      .gte('date', priorStartIso)
      .lte('date', lastSundayIso)
      .eq('is_forecast', false)

    if (wx && wx.length) {
      const wxByDate: Record<string, any> = {}
      for (const w of wx) wxByDate[w.date] = w

      // Bucket aggregation
      const byBucket: Record<string, { rev: number[]; labour: number[] }> = {}
      // (weekday, bucket) analogue aggregation
      const byDowBucket: Record<string, { rev: number[] }> = {}
      let overallRev = 0, overallN = 0

      for (const r of (dailies ?? [])) {
        if (!r.date || Number(r.revenue ?? 0) <= 0) continue
        const w = wxByDate[r.date]; if (!w) continue
        const bucket = weatherBucket(w)
        const dow = (new Date(r.date).getUTCDay() + 6) % 7
        if (!byBucket[bucket]) byBucket[bucket] = { rev: [], labour: [] }
        byBucket[bucket].rev.push(Number(r.revenue))
        if (r.labour_pct != null) byBucket[bucket].labour.push(Number(r.labour_pct))
        const k = `${dow}|${bucket}`
        if (!byDowBucket[k]) byDowBucket[k] = { rev: [] }
        byDowBucket[k].rev.push(Number(r.revenue))
        overallRev += Number(r.revenue); overallN++
      }
      const overallAvg = overallN > 0 ? overallRev / overallN : 0

      weatherPattern = Object.entries(byBucket)
        .map(([bucket, b]) => {
          const avgRev = avg(b.rev)
          return {
            bucket,
            days:          b.rev.length,
            avg_rev:       Math.round(avgRev),
            avg_labour:    b.labour.length ? Math.round(avg(b.labour) * 10) / 10 : null,
            rev_delta_pct: overallAvg > 0 ? Math.round(((avgRev - overallAvg) / overallAvg) * 1000) / 10 : 0,
          }
        })
        .filter(p => p.days >= 2)
        .sort((a, b) => b.rev_delta_pct - a.rev_delta_pct)

      // For each forecast day next week, find matching analogue
      nextWeekAnalogues = upcomingWeather.map(f => {
        const dow = (new Date(f.date).getUTCDay() + 6) % 7
        const bucket = weatherBucket(f)
        const matches = byDowBucket[`${dow}|${bucket}`]?.rev ?? []
        const allDow  = (dailies ?? [])
          .filter((r: any) => r.date && Number(r.revenue ?? 0) > 0 && ((new Date(r.date).getUTCDay() + 6) % 7) === dow)
          .map((r: any) => Number(r.revenue))
        return {
          date:               f.date,
          weekday:            DAYS[dow],
          forecast_summary:   `${f.summary}, ${f.temp_min}–${f.temp_max}°C${f.precip_mm > 0.5 ? `, ${f.precip_mm}mm` : ''}`,
          bucket,
          analogue_days:      matches.length,
          analogue_avg_rev:   matches.length >= 2 ? Math.round(avg(matches)) : null,
          all_weather_avg_rev: allDow.length ? Math.round(avg(allDow)) : 0,
        }
      })
    }
  } catch (e: any) {
    console.warn('[weekly-manager] weather correlation skipped:', e.message)
  }

  // ── Per-day demand forecast (next 7 days) ────────────────────────────────
  // Uses computeDemandForecast which combines forecast + per-business bucket
  // lifts + per-weekday baseline + holiday gate. Null if business has too
  // little history; the prompt omits the block cleanly when null.
  let demandForecast: DemandForecast | null = null
  try {
    demandForecast = await computeDemandForecast({
      db,
      orgId,
      businessId,
      days: 7,
    })
  } catch (e: any) {
    console.warn('[weekly-manager] demand-forecast skipped:', e?.message)
  }

  return {
    businessName,
    weekLabel,
    thisWeek,
    lastWeek: lastWeekBlk,
    prior4Weeks,
    monthToDate,
    openAlerts: (alerts ?? []).map((a: any) => ({
      title: a.title, severity: a.severity, description: a.description,
    })),
    budget: bud ? {
      revenue_target:        Number(bud.revenue_target ?? 0),
      food_cost_pct_target:  Number(bud.food_cost_pct_target ?? 0),
      staff_cost_pct_target: Number(bud.staff_cost_pct_target ?? 0),
    } : null,
    departments,
    weekdayPattern,
    upcomingWeather,
    weatherPattern,
    nextWeekAnalogues,
    upcomingHolidays: buildUpcomingHolidays(businessCountry, mondayOfBriefing),
    demandForecast,
  }
}

/**
 * Pull the next ~21 days of country-aware holidays for the AI memo.
 * Pure function on top of lib/holidays — failure-tolerant (returns []
 * if anything throws so the memo generation never crashes on this).
 */
function buildUpcomingHolidays(
  country: string | null,
  mondayOfBriefing: Date,
): WeeklyContext['upcomingHolidays'] {
  try {
    // Window starts at the Monday of the briefing (i.e. "next week"
    // from the owner's POV). 21 days covers the upcoming week + the
    // two after it — enough lead time for staffing decisions.
    const fromYmd = mondayOfBriefing.toISOString().slice(0, 10)
    const list    = getUpcomingHolidays(country ?? 'SE', fromYmd, 21)
    const fromMs  = Date.UTC(mondayOfBriefing.getUTCFullYear(), mondayOfBriefing.getUTCMonth(), mondayOfBriefing.getUTCDate())
    return list.map(h => {
      const [y, m, d] = h.date.split('-').map(Number)
      const days_until = Math.round((Date.UTC(y, m - 1, d) - fromMs) / 86_400_000)
      return {
        date:    h.date,
        // Sweden gets the Swedish name (more familiar to local owners);
        // other countries fall back to English. We don't have a per-AI
        // locale signal here yet — keep it simple, can refine later.
        name:    (country ?? 'SE').toUpperCase() === 'SE' ? h.name_sv : h.name_en,
        kind:    h.kind,
        impact:  h.impact,
        days_until,
      }
    })
  } catch (e: any) {
    console.warn('[weekly-manager] upcoming-holidays lookup failed:', e?.message)
    return []
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The prompt. Deliberately strict — 3 numbered actions, each SEK-quantified,
// 150–200 words max. Claude has a known habit of padding; the constraints force
// signal.
// ─────────────────────────────────────────────────────────────────────────────
function buildPrompt(ctx: WeeklyContext): string {
  const wp = ctx.weekdayPattern.filter(w => w.avg_rev > 0)
  return `You are the general manager of ${ctx.businessName}. You have access to the full week's trading data. Write a short memo to the owner — not a report, a conversation. Your job is to notice 3 things worth acting on and tell them in plain language with exact numbers and SEK impact.

TRADING DATA (all figures in SEK, ex-VAT)
Week just finished: ${ctx.weekLabel}
Revenue: ${fmt(ctx.thisWeek.revenue)}  (prev week ${fmt(ctx.lastWeek.revenue)} · ${delta(ctx.thisWeek.revenue, ctx.lastWeek.revenue)})
Labour cost: ${fmt(ctx.thisWeek.staff_cost)}  (${ctx.thisWeek.labour_pct ?? '—'} %)
Hours worked: ${ctx.thisWeek.hours}  ·  Shifts: ${ctx.thisWeek.shifts}
Covers: ${ctx.thisWeek.covers}
${ctx.budget ? `Month budget target revenue: ${fmt(ctx.budget.revenue_target)} / staff % target: ${ctx.budget.staff_cost_pct_target}` : ''}

WEEKDAY PATTERN (last 4 complete weeks avg)
${wp.map(w => `  ${w.weekday}: ${fmt(w.avg_rev)} rev · ${w.avg_hours}h · ${w.avg_labour_pct ?? '—'}% labour`).join('\n')}

DEPARTMENT MIX (month-to-date ${ctx.monthToDate.year}-${String(ctx.monthToDate.month).padStart(2,'0')})
${ctx.departments.slice(0, 6).map(d => `  ${d.name}: ${fmt(d.revenue)} rev · ${d.labour_pct ?? '—'}% labour`).join('\n')}

4-WEEK REVENUE TREND  (oldest → newest)
${ctx.prior4Weeks.map((w, i) => `  Week -${4 - i}: ${fmt(w.revenue)}`).join('\n')}
  Last week:  ${fmt(ctx.lastWeek.revenue)}
  This week:  ${fmt(ctx.thisWeek.revenue)}

${ctx.openAlerts.length ? `OPEN ALERTS\n${ctx.openAlerts.map(a => `  [${a.severity}] ${a.title} — ${a.description}`).join('\n')}` : 'OPEN ALERTS\n  None.'}

${ctx.upcomingWeather.length ? `UPCOMING WEATHER (next 7 days)
${ctx.upcomingWeather.map(w => `  ${w.date} ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(w.date).getUTCDay()]}: ${w.summary}, ${w.temp_min}-${w.temp_max}°C${w.precip_mm > 0.5 ? `, ${w.precip_mm}mm rain` : ''}${w.wind_max > 12 ? `, wind ${w.wind_max}m/s` : ''}`).join('\n')}` : 'UPCOMING WEATHER: not available'}

${ctx.weatherPattern.length ? `HISTORICAL WEATHER EFFECT (your own trading days, last 12 weeks)
${ctx.weatherPattern.map(p => `  ${p.bucket.padEnd(10)}  ${p.days} days  avg ${fmt(p.avg_rev)}  ${p.rev_delta_pct >= 0 ? '+' : ''}${p.rev_delta_pct}% vs overall${p.avg_labour != null ? ` · labour ${p.avg_labour}%` : ''}`).join('\n')}` : ''}

${ctx.nextWeekAnalogues.length ? `NEXT WEEK ANALOGUES (forecast matched to your own history)
${ctx.nextWeekAnalogues.map(a => `  ${a.date} ${a.weekday}: forecast ${a.forecast_summary} → bucket=${a.bucket}. ${a.analogue_days >= 2 ? `Matching historicals: ${a.analogue_days} days, avg rev ${fmt(a.analogue_avg_rev ?? 0)} (vs all-${a.weekday} avg ${fmt(a.all_weather_avg_rev)})` : `Only ${a.analogue_days} matching historicals — not enough to be confident.`}`).join('\n')}` : ''}

${ctx.demandForecast?.days?.length ? `WEATHER-DRIVEN DEMAND FORECAST (next 7 days, this business)
Model: predicted_revenue = baseline_for_weekday × bucket_lift_for_this_business. Baseline = trailing 12-week per-weekday average. Bucket lift = (avg revenue in this bucket) / (overall avg) for this business specifically. Confidence reflects historical sample size in the matched bucket.
${ctx.demandForecast.days.map(d => {
  const tag = d.is_holiday ? `HOLIDAY: ${d.holiday_name}` : `${d.confidence.toUpperCase()} confidence (${d.sample_size} historical days in bucket)`
  const delta = d.is_holiday ? '' : ` (${d.delta_pct >= 0 ? '+' : ''}${d.delta_pct}% vs typical ${d.weekday})`
  const rec = d.recommendation ? `\n      → ${d.recommendation}` : ''
  return `  ${d.date} ${d.weekday}: ${d.weather.bucket} (${d.weather.summary}, ${d.weather.temp_min}-${d.weather.temp_max}°C${d.weather.precip_mm > 0.5 ? `, ${d.weather.precip_mm}mm` : ''}). Predicted ${fmt(d.predicted_revenue)} kr${delta}. ${tag}.${rec}`
}).join('\n')}

USE THIS FORECAST in your memo:
  - Identify the SINGLE biggest weather-driven swing of the week (largest |delta_pct| with confidence ≥ medium) and call it out by name.
  - Recommendation language is suggestive ("consider"), not directive — the model is advisory, owner decides.
  - Don't lecture about the model's existence. Just use the numbers ("Saturday's forecast is 22% below your typical Sat — heavy rain expected, consider trimming a closing shift").
  - Skip the swing call-out when no day has |delta_pct| ≥ 12% with confidence medium-or-better — quiet weeks don't need a weather alert.` : ''}

${ctx.upcomingHolidays.length ? `UPCOMING PUBLIC HOLIDAYS (next 21 days)
${ctx.upcomingHolidays.map(h => {
  const inWhen = h.days_until === 0 ? 'today'
               : h.days_until === 1 ? 'tomorrow'
               : `in ${h.days_until} days`
  const tag = h.impact === 'high' ? ' · HIGH-DEMAND day (peak revenue, bookings full early)'
            : h.impact === 'low'  ? ' · LOW-DEMAND day (most restaurants close or run reduced service)'
            : ''
  const off = h.kind === 'observed' ? ' (observed — not a public holiday but de-facto closed/peak)' : ''
  return `  ${h.date} (${inWhen}): ${h.name}${off}${tag}`
}).join('\n')}

USE THESE HOLIDAYS in your memo when they materially shift the week's pattern.
Examples of GOOD use:
  - "Friday is Midsommarafton — book extra cover and lock the menu now; staff cost will spike but revenue should clear it"
  - "Christmas Day next Sunday — confirm closed status, no shifts to schedule"
DO NOT mention a holiday if it falls outside the upcoming week or has no impact field set.` : 'UPCOMING PUBLIC HOLIDAYS: none in next 21 days'}

${SCOPE_NOTE}

${INDUSTRY_BENCHMARKS}

${VOICE}

${SCHEDULING_ASYMMETRY}

WRITE YOUR MEMO
Constraints — NON-NEGOTIABLE:
- 150–200 words total
- Open with a one-sentence verdict on the week ("Strong week — X is carrying you", "Quiet week, and here's what to do about it", etc.)
- Then exactly 3 numbered actions. Each action MUST include:
  (a) A specific observation with concrete numbers
  (b) The action in imperative form
  (c) Expected SEK impact ("saves 4 200 kr/wk", "recovers 1.2 pts labour %", etc.)
- No generic advice. Every action must reference numbers from the data above.
- All 3 numbered actions must be cost-saves, revenue-mix shifts, pricing moves, or supplier asks — not "staff up" (see SCHEDULING RULE above).
- Weather matters for footfall. Two layers of weather data are provided:
  1. UPCOMING WEATHER — raw forecast for next 7 days
  2. HISTORICAL WEATHER EFFECT + NEXT WEEK ANALOGUES — what YOUR OWN trading days show at each weather pattern (when a backfill has run; may be empty on first weeks)
- When the analogues show a concrete delta ("matching historicals avg 142k vs all-Friday avg 168k"), USE THAT SPECIFIC NUMBER in one of your actions rather than a generic "rain might reduce footfall" statement. That specificity is what makes this feel like a real manager's advice.
- Only mention weather if it's actually notable for that week's forecast — don't force it when the week looks neutral.
- End with ONE sentence flagging the biggest risk for next week if it exists.
- Call the submit_memo tool with the finished memo. narrative is the full 150–200 word prose with the 3 numbered actions inline; actions is the structured breakdown (title ≤ 6 words, impact as "+X kr/wk" or similar, one-sentence reasoning); facts_cited is an array of specific numeric facts from the data above that you referenced.`
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-GB').replace(/,/g, ' ') + ' kr'
}
function delta(curr: number, prev: number): string {
  if (prev <= 0) return '—'
  const p = ((curr - prev) / prev) * 100
  const s = p >= 0 ? '+' : ''
  return `${s}${p.toFixed(1)}%`
}

// ─────────────────────────────────────────────────────────────────────────────
// Call Claude, parse, log cost.
// ─────────────────────────────────────────────────────────────────────────────
export async function generateWeeklyMemo(
  db:           Db,
  orgId:        string,
  businessId:   string,
  ctx:          WeeklyContext,
): Promise<ManagerMemo | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null

  const prompt = buildPrompt(ctx)
  const started = Date.now()

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

    // Tool use — forces Claude to respond via the submit_memo tool with a
    // strict JSON schema. Replaces regex-extract-JSON which silently dropped
    // responses when Claude added surrounding commentary.
    const submitMemoTool = {
      name: 'submit_memo',
      description: 'Submit the finished weekly manager memo.',
      input_schema: {
        type: 'object',
        properties: {
          narrative:   { type: 'string', description: '150–200 words of prose with 3 numbered actions inline.' },
          actions:     {
            type: 'array',
            minItems: 3,
            maxItems: 3,
            items: {
              type: 'object',
              properties: {
                title:     { type: 'string' },
                impact:    { type: 'string' },
                reasoning: { type: 'string' },
              },
              required: ['title', 'impact', 'reasoning'],
            },
          },
          facts_cited: { type: 'array', items: { type: 'string' } },
        },
        required: ['narrative', 'actions', 'facts_cited'],
      },
    }

    const response = await (claude as any).messages.create({
      model:       AI_MODELS.AGENT,
      max_tokens:  MAX_TOKENS.AGENT_SUMMARY,
      tools:       [submitMemoTool],
      tool_choice: { type: 'tool', name: 'submit_memo' },
      messages:    [{ role: 'user', content: prompt }],
    })

    // Log cost regardless of parse success.
    try {
      await logAiRequest(db, {
        org_id:        orgId,
        request_type:  'weekly_manager_memo',
        model:         AI_MODELS.AGENT,
        input_tokens:  response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
        duration_ms:   Date.now() - started,
      })
    } catch { /* non-fatal */ }

    // Tool use: the validated input lives on the tool_use block.
    const toolUse = (response.content ?? []).find((b: any) => b.type === 'tool_use')
    const parsed = toolUse?.input
    if (!parsed?.narrative) {
      console.warn('[weekly-manager] tool_use returned no narrative', parsed)
      return null
    }
    return {
      narrative:   String(parsed.narrative),
      actions:     Array.isArray(parsed.actions) ? parsed.actions.slice(0, 3) : [],
      facts_cited: Array.isArray(parsed.facts_cited) ? parsed.facts_cited : [],
    }
  } catch (e: any) {
    console.error('[weekly-manager] Claude call failed:', e.message)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Email HTML — minimal, reads like a letter, not a dashboard.
// ─────────────────────────────────────────────────────────────────────────────
export function memoEmailHtml(
  ctx: WeeklyContext,
  memo: ManagerMemo,
  appUrl: string,
  orgId: string,
  briefingId: string | null = null,
  /** Optional pre-loaded label dictionary. When omitted the email renders
   *  in English (default). Caller (cron) loads via getEmailMessages and
   *  passes a small object — keeps this function synchronous. */
  labels?: {
    weekOf:        string   // "Week of"
    h1:            string   // "Monday memo from your AI manager"
    actionsHeader: string   // "Recommended actions"
    feedbackAsk:   string   // "Was this memo useful?"
    useful:        string   // "👍 Useful"
    notUseful:     string   // "👎 Not useful"
    schedLink:     string   // "View schedule comparison →"
    pnlLink:       string   // "P&L detail →"
    generatedBy:   string   // "Generated by CommandCenter AI"
    unsubscribe:   string   // "Unsubscribe"
  },
): string {
  const L = labels ?? {
    weekOf:        'Week of',
    h1:            'Monday memo from your AI manager',
    actionsHeader: 'Recommended actions',
    feedbackAsk:   'Was this memo useful?',
    useful:        '👍 Useful',
    notUseful:     '👎 Not useful',
    schedLink:     'View schedule comparison →',
    pnlLink:       'P&L detail →',
    generatedBy:   'Generated by CommandCenter AI',
    unsubscribe:   'Unsubscribe',
  }
  const safe = (s: string) => (s ?? '').replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;')
  // Feedback links — only rendered if we have a briefing id (generated after
  // the briefings row is persisted). CRON_SECRET must be set in the env that
  // runs the digest cron for signFeedback to work.
  let feedbackBlock = ''
  if (briefingId) {
    try {
      const upToken   = signFeedback(briefingId, 'up')
      const downToken = signFeedback(briefingId, 'down')
      const upUrl     = `${appUrl}/api/memo-feedback?briefing=${briefingId}&rating=up&token=${upToken}`
      const downUrl   = `${appUrl}/api/memo-feedback?briefing=${briefingId}&rating=down&token=${downToken}`
      feedbackBlock = `
        <div style="border-top:1px solid #d4d4d0;padding-top:20px;margin-bottom:20px;font-family:-apple-system,Segoe UI,sans-serif;text-align:center;">
          <div style="font-size:11px;color:#6b7280;letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px;">${L.feedbackAsk}</div>
          <a href="${upUrl}" style="display:inline-block;margin:0 6px;padding:8px 18px;background:#ffffff;border:1px solid #d4d4d0;border-radius:8px;color:#059669;font-weight:600;font-size:13px;text-decoration:none;">${L.useful}</a>
          <a href="${downUrl}" style="display:inline-block;margin:0 6px;padding:8px 18px;background:#ffffff;border:1px solid #d4d4d0;border-radius:8px;color:#dc2626;font-weight:600;font-size:13px;text-decoration:none;">${L.notUseful}</a>
        </div>`
    } catch { /* CRON_SECRET missing in dry-run mode — skip feedback block */ }
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:Georgia,serif;color:#1a1f2e;">
  <div style="max-width:620px;margin:0 auto;padding:32px 24px;">
    <div style="font-size:12px;color:#6b7280;letter-spacing:.1em;text-transform:uppercase;margin-bottom:12px;font-family:-apple-system,Segoe UI,sans-serif;">
      ${safe(ctx.businessName)} · ${L.weekOf} ${safe(ctx.weekLabel)}
    </div>
    <h1 style="font-size:24px;font-weight:500;margin:0 0 24px;line-height:1.3;">
      ${L.h1}
    </h1>
    <div style="font-size:15px;line-height:1.7;white-space:pre-wrap;margin-bottom:32px;">
      ${safe(memo.narrative)}
    </div>
    ${memo.actions.length ? `
      <div style="border-top:1px solid #d4d4d0;padding-top:24px;margin-bottom:24px;font-family:-apple-system,Segoe UI,sans-serif;">
        <div style="font-size:11px;color:#6b7280;letter-spacing:.08em;text-transform:uppercase;margin-bottom:12px;">${L.actionsHeader}</div>
        ${memo.actions.map((a, i) => `
          <div style="margin-bottom:16px;padding:12px 14px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;">
              <div style="font-weight:600;font-size:14px;color:#1a1f2e;">${i + 1}. ${safe(a.title)}</div>
              <div style="font-size:12px;color:#059669;font-weight:600;white-space:nowrap;">${safe(a.impact)}</div>
            </div>
            <div style="font-size:13px;color:#4b5563;margin-top:4px;">${safe(a.reasoning)}</div>
          </div>
        `).join('')}
      </div>
    ` : ''}
    ${feedbackBlock}
    <div style="border-top:1px solid #d4d4d0;padding-top:16px;font-size:12px;color:#6b7280;font-family:-apple-system,Segoe UI,sans-serif;">
      <a href="${appUrl}/scheduling" style="color:#1e3a5f;text-decoration:none;margin-right:12px;">${L.schedLink}</a>
      <a href="${appUrl}/tracker" style="color:#1e3a5f;text-decoration:none;">${L.pnlLink}</a>
    </div>
    <div style="margin-top:24px;font-size:10px;color:#9ca3af;font-family:-apple-system,Segoe UI,sans-serif;">
      ${L.generatedBy} · <a href="${appUrl}/api/unsubscribe?org=${orgId}&amp;token=${Buffer.from(orgId).toString('base64')}" style="color:#9ca3af;">${L.unsubscribe}</a>
    </div>
  </div>
</body></html>`
}
