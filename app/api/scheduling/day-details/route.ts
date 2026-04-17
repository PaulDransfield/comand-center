// @ts-nocheck
// app/api/scheduling/day-details/route.ts
// Drill-down for a single day-of-week inside the selected scheduling period.
// GET ?business_id=X&from=YYYY-MM-DD&to=YYYY-MM-DD&weekday=0..6 (0=Mon … 6=Sun)
//
// Returns:
//   {
//     dates:  [{ date, revenue, hours, cost, rev_per_hour, staff_count }]  — one row per actual date that matched
//     staff:  [{ name, group, hours, cost, shifts, avg_cost_per_hour }]    — aggregated across those dates
//     totals: { revenue, hours, cost, rev_per_hour, shifts, staff_count }
//   }

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const params     = req.nextUrl.searchParams
  const businessId = params.get('business_id')
  const from       = params.get('from')
  const to         = params.get('to')
  const weekdayStr = params.get('weekday')

  if (!businessId || !from || !to || weekdayStr === null) {
    return NextResponse.json({ error: 'business_id, from, to, weekday required' }, { status: 400 })
  }
  const targetWeekday = parseInt(weekdayStr, 10) // 0=Mon..6=Sun

  const db = createAdminClient()

  // Pull daily_metrics and staff_logs in the window, filter by weekday in memory
  const [dmRes, slRes] = await Promise.all([
    db.from('daily_metrics')
      .select('date, revenue, staff_cost, hours_worked, shifts')
      .eq('business_id', businessId)
      .gte('date', from).lte('date', to)
      .limit(50000),
    db.from('staff_logs')
      .select('shift_date, staff_name, staff_group, hours_worked, cost_actual, estimated_salary')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .gte('shift_date', from).lte('shift_date', to)
      .or('cost_actual.gt.0,estimated_salary.gt.0')
      .not('pk_log_url', 'like', '%_scheduled')
      .limit(50000),
  ])

  // Convert JS dow (0=Sun..6=Sat) → our weekday index (0=Mon..6=Sun)
  const toMonIdx = (jsDow: number) => (jsDow + 6) % 7
  const matchesDay = (iso: string) => toMonIdx(new Date(iso).getUTCDay()) === targetWeekday

  // ── Per-date rows ──────────────────────────────────────────────
  const datesMap: Record<string, any> = {}
  for (const d of dmRes.data ?? []) {
    if (!matchesDay(d.date)) continue
    datesMap[d.date] = {
      date:         d.date,
      revenue:      Math.round(Number(d.revenue ?? 0)),
      hours:        Math.round(Number(d.hours_worked ?? 0) * 10) / 10,
      cost:         Math.round(Number(d.staff_cost ?? 0)),
      shifts:       Number(d.shifts ?? 0),
      staff_count:  0,
      rev_per_hour: 0,
    }
  }

  // Count unique staff per date from staff_logs (daily_metrics.shifts is shift count, not people count)
  const staffPerDate: Record<string, Set<string>> = {}
  for (const s of slRes.data ?? []) {
    if (!matchesDay(s.shift_date)) continue
    if (!staffPerDate[s.shift_date]) staffPerDate[s.shift_date] = new Set()
    if (s.staff_name) staffPerDate[s.shift_date].add(s.staff_name)
  }
  for (const [date, set] of Object.entries(staffPerDate)) {
    if (datesMap[date]) datesMap[date].staff_count = set.size
  }

  const dates = Object.values(datesMap)
    .map((d: any) => ({ ...d, rev_per_hour: d.hours > 0 ? Math.round(d.revenue / d.hours) : 0 }))
    .sort((a: any, b: any) => a.date.localeCompare(b.date))

  // ── Per-staff aggregate across matching dates ─────────────────
  const staffAcc: Record<string, any> = {}
  for (const s of slRes.data ?? []) {
    if (!matchesDay(s.shift_date)) continue
    const name  = s.staff_name ?? 'Unknown'
    const group = s.staff_group ?? '—'
    const cost  = Number(s.cost_actual ?? 0) > 0 ? Number(s.cost_actual) : Number(s.estimated_salary ?? 0)
    const hours = Number(s.hours_worked ?? 0)
    if (!staffAcc[name]) staffAcc[name] = { name, group, hours: 0, cost: 0, shifts: 0 }
    staffAcc[name].hours  += hours
    staffAcc[name].cost   += cost
    staffAcc[name].shifts += 1
  }

  const staff = Object.values(staffAcc).map((s: any) => ({
    name:               s.name,
    group:              s.group,
    hours:              Math.round(s.hours * 10) / 10,
    cost:               Math.round(s.cost),
    shifts:             s.shifts,
    avg_cost_per_hour:  s.hours > 0 ? Math.round(s.cost / s.hours) : 0,
  })).sort((a, b) => b.cost - a.cost)

  // ── Totals ────────────────────────────────────────────────────
  const totals = {
    revenue:      dates.reduce((x, r: any) => x + r.revenue, 0),
    hours:        Math.round(dates.reduce((x, r: any) => x + r.hours, 0) * 10) / 10,
    cost:         dates.reduce((x, r: any) => x + r.cost, 0),
    rev_per_hour: 0,
    shifts:       dates.reduce((x, r: any) => x + r.shifts, 0),
    staff_count:  staff.length,
  }
  totals.rev_per_hour = totals.hours > 0 ? Math.round(totals.revenue / totals.hours) : 0

  return NextResponse.json({ dates, staff, totals })
}
