// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
export const dynamic = 'force-dynamic'

const getAuth = getRequestAuth

export async function GET(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const params     = req.nextUrl.searchParams
  const from       = params.get('from') ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10)
  const to         = params.get('to')   ?? new Date().toISOString().slice(0,10)
  const businessId = params.get('business_id')

  const db = createAdminClient()

  // Check integration — match by org, not business (connection may be org-level)
  const { data: integ } = await db
    .from('integrations')
    .select('id, status, business_id')
    .eq('org_id', auth.orgId)
    .eq('provider', 'personalkollen')
    .eq('status', 'connected')
    .limit(1).maybeSingle()

  // Read from staff_logs — include any row with cost OR lateness data
  let query = db.from('staff_logs')
    .select('staff_name, staff_group, shift_date, hours_worked, cost_actual, estimated_salary, pk_staff_url, is_late, late_minutes, ob_supplement_kr, ob_type')
    .eq('org_id', auth.orgId)
    .gte('shift_date', from)
    .lte('shift_date', to)
    // Include rows with cost data OR lateness data (late shifts may have 0 cost on casual rates)
    .or('cost_actual.gt.0,estimated_salary.gt.0,is_late.eq.true')

  if (businessId) query = query.eq('business_id', businessId)
  query = query.limit(50000)

  const { data: logs, error } = await query
  if (error) return NextResponse.json({ error: error.message, connected: true }, { status: 500 })

  // Aggregate by staff member + lateness rollups in one pass
  const staffMap:   Record<string, any> = {}
  const deptMap:    Record<string, any> = {}  // dept → lateness stats
  const weekdayMap: Record<number, any> = {}  // 0=Mon … 6=Sun
  const obTypeMap:  Record<string, number> = {}  // ob_type → total supplement kr (period-wide)

  for (const log of logs ?? []) {
    const key = log.pk_staff_url ?? log.staff_name
    if (!key) continue

    // ── Per-staff aggregation ───────────────────────────────────────────────
    if (!staffMap[key]) {
      staffMap[key] = {
        id: key, name: log.staff_name, group: log.staff_group,
        hours_logged: 0, cost_actual: 0, estimated_salary: 0, shifts_logged: 0,
        late_shifts: 0, avg_late_minutes: 0, ob_supplement_kr: 0,
        ob_types: {},   // ob_type → total kr supplement
        costgroups: {},
      }
    }
    const s = staffMap[key]
    s.hours_logged      += log.hours_worked      ?? 0
    s.cost_actual       += log.cost_actual       ?? 0
    s.estimated_salary  += log.estimated_salary  ?? 0
    s.shifts_logged     += 1
    s.ob_supplement_kr  += log.ob_supplement_kr  ?? 0
    if (log.ob_type && (log.ob_supplement_kr ?? 0) > 0) {
      s.ob_types[log.ob_type] = (s.ob_types[log.ob_type] ?? 0) + (log.ob_supplement_kr ?? 0)
      obTypeMap[log.ob_type]  = (obTypeMap[log.ob_type]  ?? 0) + (log.ob_supplement_kr ?? 0)
    }
    if (log.is_late) { s.late_shifts++; s.avg_late_minutes += log.late_minutes ?? 0 }
    if (log.staff_group) s.costgroups[log.staff_group] = (s.costgroups[log.staff_group] ?? 0) + (log.cost_actual ?? 0)

    // ── Department lateness rollup ──────────────────────────────────────────
    const dept = log.staff_group ?? 'Unknown'
    if (!deptMap[dept]) deptMap[dept] = { dept, total_shifts: 0, late_count: 0, total_late_minutes: 0 }
    deptMap[dept].total_shifts      += 1
    if (log.is_late) {
      deptMap[dept].late_count        += 1
      deptMap[dept].total_late_minutes += log.late_minutes ?? 0
    }

    // ── Weekday lateness rollup (0=Mon … 6=Sun) ─────────────────────────────
    if (log.shift_date) {
      // new Date('YYYY-MM-DD') parses as UTC midnight → getUTCDay() avoids timezone shift
      const d   = new Date(log.shift_date)
      const dow = (d.getUTCDay() + 6) % 7  // convert Sun=0 → Mon=0 … Sun=6
      if (!weekdayMap[dow]) weekdayMap[dow] = { weekday: dow, total_shifts: 0, late_count: 0, total_late_minutes: 0 }
      weekdayMap[dow].total_shifts       += 1
      if (log.is_late) {
        weekdayMap[dow].late_count         += 1
        weekdayMap[dow].total_late_minutes += log.late_minutes ?? 0
      }
    }
  }

  const staff = Object.values(staffMap).map((s: any) => {
    // For shifts where payroll isn't approved yet, cost_actual = 0 — use estimated_salary as proxy
    const effectiveCost = s.cost_actual > 0 ? s.cost_actual : s.estimated_salary
    // Tax multiplier: how much employer cost exceeds net salary (typically ~1.42 in Sweden)
    const multiplier = s.estimated_salary > 0 && s.cost_actual > 0
      ? Math.round((s.cost_actual / s.estimated_salary) * 100) / 100
      : null
    return {
      ...s,
      effective_cost:   effectiveCost,
      cost_variance:    s.cost_actual > 0 && s.estimated_salary > 0 ? s.cost_actual - s.estimated_salary : 0,
      tax_multiplier:   multiplier,
      hours_scheduled:  0,
      cost_per_hour:    s.hours_logged > 0 ? Math.round(effectiveCost / s.hours_logged) : 0,
      variance_hours:   0,
      avg_late_minutes: s.late_shifts > 0 ? Math.round(s.avg_late_minutes / s.late_shifts) : 0,
    }
  })

  const totalEstimated = Math.round(staff.reduce((s, m) => s + m.estimated_salary, 0))
  const totalActual    = Math.round(staff.reduce((s, m) => s + m.cost_actual, 0))

  const summary = {
    logged_hours:           Math.round(staff.reduce((s, m) => s + m.hours_logged, 0) * 10) / 10,
    scheduled_hours:        0,
    staff_cost_actual:      totalActual,
    staff_cost_estimated:   totalEstimated,
    // Fallback: if payroll not yet approved, use estimated as effective cost
    staff_cost_effective:   totalActual > 0 ? totalActual : totalEstimated,
    staff_cost_scheduled:   totalEstimated, // keep for backward compat with dashboard
    cost_variance:          totalActual > 0 && totalEstimated > 0 ? totalActual - totalEstimated : 0,
    tax_multiplier:         totalActual > 0 && totalEstimated > 0
      ? Math.round((totalActual / totalEstimated) * 100) / 100
      : null,
    shifts_logged:          staff.reduce((s, m) => s + m.shifts_logged, 0),
    shifts_scheduled:       0,
    late_shifts:            staff.reduce((s, m) => s + m.late_shifts, 0),
    shifts_with_ob:         staff.filter(m => m.ob_supplement_kr > 0).length,
    total_ob_supplement:    Math.round(staff.reduce((s, m) => s + m.ob_supplement_kr, 0)),
    ob_type_breakdown:      Object.entries(obTypeMap)
      .map(([type, kr]) => ({ type, kr: Math.round(kr as number) }))
      .sort((a, b) => b.kr - a.kr),  // highest cost type first
    payroll_pending:        totalActual === 0 && totalEstimated > 0, // shifts not yet approved
  }

  // Finalise department lateness — add derived fields, sort worst first
  const dept_lateness = Object.values(deptMap)
    .map((d: any) => ({
      ...d,
      late_rate_pct:    d.total_shifts > 0 ? Math.round((d.late_count / d.total_shifts) * 1000) / 10 : 0,
      avg_late_minutes: d.late_count > 0   ? Math.round(d.total_late_minutes / d.late_count) : 0,
    }))
    .sort((a: any, b: any) => b.late_rate_pct - a.late_rate_pct)

  // Finalise weekday lateness — fill all 7 days even if no data, Mon–Sun order
  const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
  const weekday_lateness = DAYS.map((label, i) => {
    const d = weekdayMap[i] ?? { weekday: i, total_shifts: 0, late_count: 0, total_late_minutes: 0 }
    return {
      ...d,
      label,
      late_rate_pct:    d.total_shifts > 0 ? Math.round((d.late_count / d.total_shifts) * 1000) / 10 : 0,
      avg_late_minutes: d.late_count > 0   ? Math.round(d.total_late_minutes / d.late_count) : 0,
    }
  })

  return NextResponse.json({ connected: true, summary, staff, dept_lateness, weekday_lateness })
}