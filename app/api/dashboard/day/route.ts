// app/api/dashboard/day/route.ts
//
// Powers the /dashboard/day/[date] drill-down. Returns everything the
// operator might want to know about a single day:
//   - Business name + period label
//   - Predicted revenue (from scheduling AI route's same logic — reused)
//   - Actual revenue (daily_metrics)
//   - Hourly breakdown (hourly_metrics)
//   - Scheduled shifts (staff_logs with shift times when present)
//   - Attribution drivers — same shape as WhyThisWeekCard
//   - Anomaly status (anomaly_alerts) + confirm/dismiss capability
//
// Auth: session-based, business-scoped via canAccessBusiness.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { canAccessBusiness }   from '@/lib/auth/permissions'
import { getHolidaysForCountry } from '@/lib/holidays'
import { computeEventImpacts, aggregateDayLiftPct, type EventRecord } from '@/lib/events/impact'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url   = new URL(req.url)
  const bizId = url.searchParams.get('business_id')
  const date  = url.searchParams.get('date')
  if (!bizId)             return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!date || !ISO_DATE.test(date)) return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 })

  const subject = {
    role:              auth.role as any,
    business_ids:      (auth as any).business_ids ?? null,
    can_view_finances: (auth as any).can_view_finances === true,
  }
  if (!canAccessBusiness(subject, bizId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const db = createAdminClient()

  // ── Business + country + city ────────────────────────────────────────
  const { data: biz } = await db
    .from('businesses')
    .select('id, name, city, country, target_staff_pct, target_food_pct')
    .eq('id', bizId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 })

  const country = ((biz as any).country ?? 'SE') as string

  // ── Parallel loads ──────────────────────────────────────────────────
  // 12 weeks of daily_metrics for the weekday baseline
  const dateObj    = new Date(date + 'T12:00:00Z')
  const targetDow  = dateObj.getUTCDay()
  const historyFrom = (() => {
    const d = new Date(dateObj); d.setUTCDate(d.getUTCDate() - 12 * 7); return d.toISOString().slice(0, 10)
  })()
  const historyTo = (() => {
    const d = new Date(dateObj); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10)
  })()

  const [
    actualRowRes,
    historyRes,
    hourlyDayRes,
    shiftsDayRes,
    weatherDayRes,
    anomalyRes,
    eventsRes,
  ] = await Promise.all([
    db.from('daily_metrics')
      .select('date, revenue, staff_cost, food_cost, covers, hours_worked, labour_pct, cost_source')
      .eq('business_id', bizId)
      .eq('date', date)
      .maybeSingle(),
    db.from('daily_metrics')
      .select('date, revenue, hours_worked')
      .eq('business_id', bizId)
      .gte('date', historyFrom)
      .lte('date', historyTo)
      .gt('revenue', 0),
    db.from('hourly_metrics')
      .select('hour, revenue, covers, transactions')
      .eq('business_id', bizId)
      .eq('business_date', date)
      .order('hour', { ascending: true }),
    db.from('staff_logs')
      .select('staff_name, staff_group, hours_worked, estimated_salary, cost_actual, pk_log_url')
      .eq('business_id', bizId)
      .eq('shift_date', date)
      .order('staff_name', { ascending: true }),
    db.from('weather_daily')
      .select('date, temp_min, temp_max, precip_mm, weather_code, summary, is_forecast')
      .eq('business_id', bizId)
      .eq('date', date)
      .maybeSingle(),
    db.from('anomaly_alerts')
      .select('id, alert_type, period_date, severity, status, confirmation_status, message')
      .eq('business_id', bizId)
      .eq('period_date', date)
      .in('alert_type', ['revenue_drop', 'revenue_spike'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Events on or near this date (±2 days)
    (async () => {
      try {
        const fromIso = (() => { const d = new Date(dateObj); d.setUTCDate(d.getUTCDate() - 2); return d.toISOString() })()
        const toIso   = (() => { const d = new Date(dateObj); d.setUTCDate(d.getUTCDate() + 2); return d.toISOString() })()
        return db.from('events')
          .select('id, source, source_id, name, category, start_at, end_at, venue_name, venue_city, venue_lat, venue_lng, venue_capacity, expected_attendance, url')
          .gte('start_at', fromIso)
          .lte('start_at', toIso)
          .not('venue_lat', 'is', null)
          .limit(100)
      } catch { return { data: [] } as any }
    })(),
  ])

  const actual = actualRowRes?.data ?? null
  const history = (historyRes.data ?? []) as any[]
  const hourly  = (hourlyDayRes.data ?? []) as any[]
  const shifts  = (shiftsDayRes.data ?? []) as any[]
  const weather = (weatherDayRes as any)?.data ?? null
  const anomaly = (anomalyRes as any)?.data ?? null
  const events  = ((eventsRes as any)?.data ?? []) as EventRecord[]

  // ── Compute attribution drivers ─────────────────────────────────────
  const sameWeekday = history.filter(r => new Date(r.date + 'T12:00:00Z').getUTCDay() === targetDow)
  const baselineRev = sameWeekday.length > 0
    ? Math.round(sameWeekday.reduce((s, r) => s + Number(r.revenue ?? 0), 0) / sameWeekday.length)
    : 0
  // Recent vs older trend (last 4 same-weekday vs older 8)
  const sortedByDate = [...sameWeekday].sort((a, b) => b.date.localeCompare(a.date))
  const recent4 = sortedByDate.slice(0, 4).map(r => Number(r.revenue ?? 0))
  const older   = sortedByDate.slice(4).map(r => Number(r.revenue ?? 0))
  const recent4Avg = recent4.length ? recent4.reduce((a, b) => a + b, 0) / recent4.length : 0
  const olderAvg   = older.length   ? older.reduce((a, b) => a + b, 0) / older.length     : 0
  const trendPct = olderAvg > 0 ? ((recent4Avg / olderAvg) - 1) * 100 : 0

  // Holiday detection
  let holidayInfo: { name: string; impact: string | null } | null = null
  let klamdagInfo: { adjacent: string | null } | null = null
  try {
    const year = dateObj.getUTCFullYear()
    const holidays = [
      ...getHolidaysForCountry(country, year),
      ...getHolidaysForCountry(country, year + 1),
      ...getHolidaysForCountry(country, year - 1),
    ]
    const holidaySet = new Set(holidays.map((h: any) => h.date))
    const todayHoliday = holidays.find((h: any) => h.date === date)
    if (todayHoliday) {
      holidayInfo = { name: (todayHoliday as any).name_sv ?? (todayHoliday as any).name ?? 'Holiday', impact: (todayHoliday as any).impact ?? null }
    }
    // Klämdag check
    const dow = dateObj.getUTCDay()
    if (dow >= 1 && dow <= 5 && !holidaySet.has(date)) {
      const yesterday = (() => { const d = new Date(dateObj); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10) })()
      const tomorrow  = (() => { const d = new Date(dateObj); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10) })()
      if (holidaySet.has(yesterday)) {
        klamdagInfo = { adjacent: (holidays.find((h: any) => h.date === yesterday) as any)?.name_sv ?? 'a holiday' }
      } else if (holidaySet.has(tomorrow)) {
        klamdagInfo = { adjacent: (holidays.find((h: any) => h.date === tomorrow) as any)?.name_sv ?? 'a holiday' }
      }
    }
  } catch { /* holidays unavailable for this country */ }

  // Salary cycle
  const dom = dateObj.getUTCDate()
  const salaryPhase: 'around_payday' | 'mid_month' | 'end_month' =
    (dom >= 23 && dom <= 27) ? 'around_payday'
    : (dom >= 28 || dom <= 5) ? 'end_month'
    : 'mid_month'
  const salaryEffectPct = salaryPhase === 'around_payday' ? 8 : salaryPhase === 'end_month' ? -3 : 0
  const salaryLabel = salaryPhase === 'around_payday' ? 'Around payday (25th)'
    : salaryPhase === 'end_month' ? 'End of month (post-payday dip)'
    : 'Mid-month'

  // Event impacts
  const bizLat = (biz as any).city ? null : null
  // Reuse the same Stockholm-centred default the scheduling route uses
  const { coordsFor } = await import('@/lib/weather/forecast')
  const bizCoords = coordsFor((biz as any).city)
  const eventImpacts = computeEventImpacts({
    businessLat:  bizCoords.lat,
    businessLng:  bizCoords.lon,
    forecastDate: dateObj,
    events,
  })
  const eventsAggregateLiftPct = aggregateDayLiftPct(eventImpacts)

  // ── Compose response ──────────────────────────────────────────────
  return NextResponse.json({
    business: {
      id:               (biz as any).id,
      name:             (biz as any).name,
      city:             (biz as any).city,
      country,
      target_staff_pct: (biz as any).target_staff_pct ?? 35,
      target_food_pct:  (biz as any).target_food_pct ?? 31,
    },
    date,
    actual: actual ? {
      revenue:      Number(actual.revenue ?? 0),
      staff_cost:   Number(actual.staff_cost ?? 0),
      food_cost:    Number(actual.food_cost ?? 0),
      covers:       Number(actual.covers ?? 0),
      hours_worked: Number(actual.hours_worked ?? 0),
      labour_pct:   actual.labour_pct == null ? null : Number(actual.labour_pct),
      cost_source:  actual.cost_source ?? null,
    } : null,
    hourly: hourly.map((h: any) => ({
      hour:         h.hour,
      revenue:      Number(h.revenue ?? 0),
      covers:       Number(h.covers ?? 0),
      transactions: Number(h.transactions ?? 0),
    })),
    shifts: shifts.map((s: any) => ({
      staff_name:        s.staff_name,
      staff_group:       s.staff_group,
      hours_worked:      Number(s.hours_worked ?? 0),
      estimated_cost:    Math.round(Number(s.estimated_salary ?? s.cost_actual ?? 0)),
      kind:              s.pk_log_url?.endsWith('_scheduled') ? 'scheduled' : 'logged',
    })),
    weather: weather ? {
      summary:    weather.summary,
      temp_min:   Number(weather.temp_min ?? 0),
      temp_max:   Number(weather.temp_max ?? 0),
      precip_mm:  Number(weather.precip_mm ?? 0),
      is_forecast: weather.is_forecast,
    } : null,
    anomaly: anomaly ? {
      id:                  anomaly.id,
      alert_type:          anomaly.alert_type,
      severity:            anomaly.severity,
      status:              anomaly.status,
      confirmation_status: anomaly.confirmation_status,
      message:             anomaly.message,
    } : null,
    attribution: {
      weekday_name:        ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][targetDow],
      baseline_kr:         baselineRev,
      baseline_sample_n:   sameWeekday.length,
      recent_trend_pct:    Math.round(trendPct * 10) / 10,
      holiday:             holidayInfo,
      klamdag:             klamdagInfo,
      salary_phase:        salaryPhase,
      salary_label:        salaryLabel,
      salary_effect_pct:   salaryEffectPct,
      events:              eventImpacts.slice(0, 5).map(ei => ({
        name:        ei.event.name,
        category:    ei.event.category,
        venue_name:  ei.event.venue_name,
        start_at:    ei.event.start_at,
        days_until:  ei.days_until,
        distance_km: ei.distance_km,
        lift_pct:    ei.lift_pct,
      })),
      events_aggregate_lift_pct: Math.round(eventsAggregateLiftPct * 10) / 10,
    },
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}
