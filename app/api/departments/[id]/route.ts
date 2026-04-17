// @ts-nocheck
// /api/departments/[id] — detail for one department
// Returns revenue trend + staff breakdown scoped to that department
// The [id] is the department name (URL-encoded) — no UUID needed since names are unique per business

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const getAuth = getRequestAuth

function deptToProviderKey(name: string): string {
  return `inzii_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // [id] is URL-encoded department name e.g. "Bella" or "Bubbel%20%26%20Brus"
  const deptName   = decodeURIComponent(params.id)
  const searchParams = req.nextUrl.searchParams
  const businessId   = searchParams.get('business_id')
  const from         = searchParams.get('from') ?? new Date(new Date().getFullYear(), new Date().getMonth() - 2, 1).toISOString().slice(0, 10)
  const to           = searchParams.get('to')   ?? new Date().toISOString().slice(0, 10)

  const db           = createAdminClient()
  const providerKey  = deptToProviderKey(deptName)

  // ── Revenue: daily rows for this dept — try Inzii POS direct first, then PK per-workplace
  const pkProviderKey = `pk_${deptName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`
  let revQuery = db.from('revenue_logs')
    .select('revenue_date, revenue, covers, food_revenue, bev_revenue')
    .eq('org_id', auth.orgId)
    .in('provider', [providerKey, pkProviderKey])
    .gte('revenue_date', from)
    .lte('revenue_date', to)
    .order('revenue_date', { ascending: true })
  if (businessId) revQuery = revQuery.eq('business_id', businessId)
  revQuery = revQuery.limit(50000)

  // ── Staff: shifts for this dept's PK group ───────────────────────────────
  let staffQuery = db.from('staff_logs')
    .select('shift_date, staff_name, hours_worked, cost_actual, estimated_salary, ob_supplement_kr, ob_type, is_late, late_minutes')
    .eq('org_id', auth.orgId)
    .eq('staff_group', deptName)
    .gte('shift_date', from)
    .lte('shift_date', to)
    .or('cost_actual.gt.0,estimated_salary.gt.0')
  if (businessId) staffQuery = staffQuery.eq('business_id', businessId)
  staffQuery = staffQuery.limit(50000)

  // ── Dept definition (color) ──────────────────────────────────────────────
  let defQuery = db.from('departments')
    .select('name, color')
    .eq('org_id', auth.orgId)
    .eq('name', deptName)
    .limit(1).maybeSingle()

  const [{ data: revLogs }, { data: staffLogs }, { data: deptDef }] = await Promise.all([
    revQuery, staffQuery, defQuery,
  ])

  // ── Aggregate revenue ────────────────────────────────────────────────────
  let totalRevenue = 0, totalCovers = 0
  const revByDate: Record<string, { revenue: number; covers: number }> = {}

  for (const r of revLogs ?? []) {
    totalRevenue += r.revenue ?? 0
    totalCovers  += r.covers  ?? 0
    // If multiple providers return data for the same date (shouldn't happen), last one wins
    revByDate[r.revenue_date] = {
      revenue: Math.round(r.revenue ?? 0),
      covers:  r.covers ?? 0,
    }
  }

  // Revenue daily trend — fill every date in range
  const trend: Array<{ date: string; revenue: number; covers: number }> = []
  const cur = new Date(from)
  const end = new Date(to)
  while (cur <= end) {
    const d = cur.toISOString().slice(0, 10)
    trend.push({ date: d, ...(revByDate[d] ?? { revenue: 0, covers: 0 }) })
    cur.setUTCDate(cur.getUTCDate() + 1)
  }

  // ── Aggregate staff ──────────────────────────────────────────────────────
  let totalCost = 0, totalEstimated = 0, totalHours = 0, totalShifts = 0
  let lateShifts = 0, totalLateMinutes = 0, totalOb = 0
  const staffAccMap: Record<string, any> = {}
  const obTypeMap: Record<string, number> = {}

  for (const s of staffLogs ?? []) {
    const cost = s.cost_actual > 0 ? s.cost_actual : (s.estimated_salary ?? 0)
    totalCost      += s.cost_actual      ?? 0
    totalEstimated += s.estimated_salary ?? 0
    totalHours     += s.hours_worked     ?? 0
    totalShifts    += 1
    totalOb        += s.ob_supplement_kr ?? 0
    if (s.is_late) { lateShifts++; totalLateMinutes += s.late_minutes ?? 0 }

    if (s.ob_type && (s.ob_supplement_kr ?? 0) > 0) {
      obTypeMap[s.ob_type] = (obTypeMap[s.ob_type] ?? 0) + (s.ob_supplement_kr ?? 0)
    }

    const key = s.staff_name ?? 'Unknown'
    if (!staffAccMap[key]) staffAccMap[key] = { name: key, cost: 0, hours: 0, shifts: 0, late_shifts: 0, avg_late_minutes: 0 }
    staffAccMap[key].cost         += cost
    staffAccMap[key].hours        += s.hours_worked ?? 0
    staffAccMap[key].shifts       += 1
    if (s.is_late) { staffAccMap[key].late_shifts++; staffAccMap[key].avg_late_minutes += s.late_minutes ?? 0 }
  }

  const effectiveCost = totalCost > 0 ? totalCost : totalEstimated

  const staff = Object.values(staffAccMap).map((s: any) => ({
    name:             s.name,
    cost:             Math.round(s.cost),
    hours:            Math.round(s.hours * 10) / 10,
    shifts:           s.shifts,
    cost_per_hour:    s.hours > 0 ? Math.round(s.cost / s.hours) : 0,
    late_shifts:      s.late_shifts,
    avg_late_minutes: s.late_shifts > 0 ? Math.round(s.avg_late_minutes / s.late_shifts) : 0,
  })).sort((a, b) => b.cost - a.cost)

  const summary = {
    revenue:          Math.round(totalRevenue),
    covers:           Math.round(totalCovers),
    avg_spend:        totalCovers > 0 ? Math.round((totalRevenue / totalCovers) * 10) / 10 : 0,
    staff_cost:       Math.round(effectiveCost),
    hours:            Math.round(totalHours * 10) / 10,
    shifts:           totalShifts,
    gp_pct:           totalRevenue > 0 ? Math.round(((totalRevenue - effectiveCost) / totalRevenue) * 1000) / 10 : null,
    labour_pct:       totalRevenue > 0 ? Math.round((effectiveCost / totalRevenue) * 1000) / 10 : null,
    rev_per_hour:     totalHours > 0 ? Math.round(totalRevenue / totalHours) : 0,
    cost_per_hour:    totalHours > 0 ? Math.round(effectiveCost / totalHours) : 0,
    ob_supplement:    Math.round(totalOb),
    late_shifts:      lateShifts,
    avg_late_minutes: lateShifts > 0 ? Math.round(totalLateMinutes / lateShifts) : 0,
    payroll_pending:  totalCost === 0 && totalEstimated > 0,
    ob_type_breakdown: Object.entries(obTypeMap)
      .map(([type, kr]) => ({ type, kr: Math.round(kr as number) }))
      .sort((a, b) => b.kr - a.kr),
  }

  return NextResponse.json({
    name:       deptName,
    color:      deptDef?.color ?? '#6366f1',
    summary,
    trend,      // daily revenue + covers
    staff,      // per-person breakdown
    date_from:  from,
    date_to:    to,
  })
}
