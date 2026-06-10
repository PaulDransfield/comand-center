// app/api/scheduling/week/route.ts
//
// GET /api/scheduling/week?business_id=&week=YYYY-Www
//
// Returns the full payload the /scheduling page needs to render a week:
//   - 7-day header (date, weather, holiday, forecast revenue,
//     planned hours, planned cost, projected staff %)
//   - shift templates (rows for the shift-centric view)
//   - staff profiles (rows for the staff-centric view)
//   - shifts (all assignments in the week, both views slice the same data)
//   - week summary (planned cost, target %, gap)

import { NextRequest, NextResponse }   from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess }       from '@/lib/auth/require-role'
import { getHolidaysForCountry }       from '@/lib/holidays'
import { dailyForecast }               from '@/lib/forecast/daily'
import { DEFAULT_LABOR_CONFIG, type LaborConfig } from '@/lib/scheduling/labor-rules-sweden'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const businessId = String(url.searchParams.get('business_id') ?? '').trim()
  const weekIso    = String(url.searchParams.get('week')        ?? '').trim() || isoWeekToday()
  if (!businessId)               return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!/^\d{4}-W\d{2}$/.test(weekIso)) return NextResponse.json({ error: 'week must be YYYY-Www' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // Business context
  const { data: biz } = await db
    .from('businesses')
    .select('id, name, country, opening_days, target_food_pct, target_staff_pct, target_margin_pct, business_stage, scheduling_labor_config')
    .eq('id', businessId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  // Effective Swedish labour ruleset for this business (defaults to Visita–HRF).
  const laborConfig: LaborConfig = { ...DEFAULT_LABOR_CONFIG, ...((biz as any).scheduling_labor_config ?? {}) }

  // Compute Monday-Sunday date range from week ISO
  const { monday, sunday } = isoWeekToRange(weekIso)
  const days: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday); d.setUTCDate(d.getUTCDate() + i)
    days.push(d.toISOString().slice(0, 10))
  }

  // Load shifts + templates + staff_profiles + ai suggestions in parallel
  const [shiftsRes, templatesRes, profilesRes, aiRes] = await Promise.all([
    db.from('staff_shifts')
      .select('id, staff_uid, shift_date, start_at, end_at, start_time_local, end_time_local, staff_name, period_name, description, estimated_cost, shift_template_id, shift_kind, breaks_seconds, has_ob, ob_hours, is_published, is_ai_suggested, source')
      .eq('business_id', businessId)
      .gte('shift_date', days[0])
      .lte('shift_date', days[6])
      .order('shift_date', { ascending: true })
      .order('start_at', { ascending: true }),
    db.from('staff_shift_templates')
      .select('id, name, section, display_colour, modal_start_time, modal_end_time, sort_order, shifts_count_60d')
      .eq('business_id', businessId)
      .is('archived_at', null)
      .order('section')
      .order('sort_order')
      .order('name'),
    db.from('staff_profiles')
      .select('staff_uid, display_name, full_name, primary_section, salary_type, hourly_rate_sek, service_grade_pct, typical_shift_window, closer_confidence, rush_capability, is_minor')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .order('primary_section')
      .order('display_name'),
    db.from('schedule_ai_suggestions')
      .select('*')
      .eq('business_id', businessId)
      .eq('week_iso', weekIso)
      .in('status', ['pending', 'approved', 'modified'])
      .order('confidence', { ascending: false }),
  ])
  if (shiftsRes.error)    return NextResponse.json({ error: `shifts: ${shiftsRes.error.message}` }, { status: 500 })
  if (templatesRes.error) return NextResponse.json({ error: `templates: ${templatesRes.error.message}` }, { status: 500 })
  if (profilesRes.error)  return NextResponse.json({ error: `profiles: ${profilesRes.error.message}` }, { status: 500 })

  const shifts      = shiftsRes.data    ?? []
  const templates   = templatesRes.data ?? []
  const profiles    = profilesRes.data  ?? []
  const suggestions = aiRes.data        ?? []

  // Per-day aggregates
  const holidays = getHolidaysForCountry(biz.country ?? 'SE', new Date(monday).getUTCFullYear())
  const holidaysByDate = new Map(holidays.map(h => [h.date, h]))

  const dayHeaders = days.map(d => {
    const dayShifts = shifts.filter((s: any) => s.shift_date === d && s.shift_kind !== 'semester')
    const plannedSeconds = dayShifts.reduce((sum: number, s: any) => {
      const dur = (new Date(s.end_at).getTime() - new Date(s.start_at).getTime()) / 1000
      return sum + Math.max(0, dur - (s.breaks_seconds ?? 0))
    }, 0)
    const plannedCost = dayShifts.reduce((sum: number, s: any) => sum + Number(s.estimated_cost ?? 0), 0)
    return {
      date: d,
      day_of_week: new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }),
      day_number: new Date(d + 'T00:00:00Z').getUTCDate(),
      planned_hours: Math.round(plannedSeconds / 360) / 10,    // 1dp
      planned_cost:  Math.round(plannedCost),
      forecast_revenue: null as number | null,                  // populated below
      projected_staff_pct: null as number | null,
      target_staff_pct: biz.target_staff_pct != null ? Number(biz.target_staff_pct) : null,
      weather: null as null | { icon: string; temp_c: number | null; precip_mm: number | null },
      holiday: holidaysByDate.get(d) ?? null,
      shifts_count: dayShifts.length,
    }
  })

  // Forecast revenue per day — live via the daily forecaster (same
  // pipeline the dashboard uses). The legacy `forecasts` table read was
  // empty for most businesses, leaving the review panel's KPI cards
  // showing "—" even for businesses with rich history.
  try {
    const fcResults = await Promise.all(
      days.map(async (d) => {
        try {
          const f = await dailyForecast(businessId, new Date(d + 'T00:00:00Z'), { db })
          return { date: d, revenue: Number(f?.predicted_revenue ?? 0) }
        } catch { return { date: d, revenue: 0 } }
      }),
    )
    const fcByDate = new Map(fcResults.map(r => [r.date, r.revenue]))
    for (const h of dayHeaders) {
      const fc = fcByDate.get(h.date)
      if (fc != null && fc > 0) {
        h.forecast_revenue = Math.round(fc)
        h.projected_staff_pct = Math.round((h.planned_cost / fc) * 1000) / 10
      }
    }
  } catch { /* forecast lookup is best-effort; UI handles nulls */ }

  // Week summary
  const totalPlannedCost = dayHeaders.reduce((s, h) => s + h.planned_cost, 0)
  const totalForecast    = dayHeaders.reduce((s, h) => s + (h.forecast_revenue ?? 0), 0)
  const summary = {
    week_iso:           weekIso,
    range_from:         days[0],
    range_to:           days[6],
    planned_cost_sek:   totalPlannedCost,
    forecast_revenue_sek: totalForecast,
    projected_staff_pct:  totalForecast > 0 ? Math.round((totalPlannedCost / totalForecast) * 1000) / 10 : null,
    target_staff_pct:     biz.target_staff_pct != null ? Number(biz.target_staff_pct) : null,
    gap_pct:              (totalForecast > 0 && biz.target_staff_pct != null)
                            ? Math.round(((totalPlannedCost / totalForecast) * 100 - Number(biz.target_staff_pct)) * 10) / 10
                            : null,
    total_shifts:         shifts.filter((s: any) => s.shift_kind !== 'semester').length,
    semester_shifts:      shifts.filter((s: any) => s.shift_kind === 'semester').length,
    staff_scheduled:      new Set(shifts.map((s: any) => s.staff_uid).filter(Boolean)).size,
  }

  return NextResponse.json({
    business: { id: biz.id, name: biz.name, country: biz.country, target_staff_pct: biz.target_staff_pct },
    labor_config: laborConfig,
    week:     summary,
    days:     dayHeaders,
    templates, profiles, shifts, suggestions,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

// ─────────────────────────────────────────────────────────────────────
// ISO week helpers

function isoWeekToday(): string {
  const d = new Date()
  return isoWeekFor(d)
}

function isoWeekFor(d: Date): string {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNr = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNr + 3)
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const weekNr = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
  return `${target.getUTCFullYear()}-W${String(weekNr).padStart(2, '0')}`
}

function isoWeekToRange(weekIso: string): { monday: string; sunday: string } {
  const [yearStr, weekStr] = weekIso.split('-W')
  const year = Number(yearStr)
  const week = Number(weekStr)
  // First Monday of ISO year
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4Dow = (jan4.getUTCDay() + 6) % 7   // 0 = Mon
  const week1Monday = new Date(jan4)
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow)
  const monday = new Date(week1Monday)
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7)
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  return { monday: monday.toISOString().slice(0, 10), sunday: sunday.toISOString().slice(0, 10) }
}
