// @ts-nocheck
// /api/departments — group overview: all departments for a business
// Returns each dept with revenue (from Inzii) + staff cost (from PK) + derived metrics
// Also returns monthly trend and per-staff breakdown for the expanded detail view

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

async function getAuth(req: NextRequest) {
  const raw = req.cookies.get('sb-llzmixkrysduztsvmfzi-auth-token')?.value
  if (!raw) return null
  try {
    let token = raw
    try { const d = decodeURIComponent(raw); const p = JSON.parse(d); token = Array.isArray(p) ? p[0] : (p.access_token ?? raw) } catch {}
    const db = createAdminClient()
    const { data: { user } } = await db.auth.getUser(token)
    if (!user) return null
    const { data: m } = await db.from('organisation_members').select('org_id').eq('user_id', user.id).single()
    return m ? { userId: user.id, orgId: m.org_id } : null
  } catch { return null }
}

// Convert a department name to the Inzii revenue_logs provider key
// Mirrors the logic in lib/sync/engine.ts syncInzii()
function deptToProviderKey(name: string): string {
  return `inzii_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`
}

export async function GET(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const params     = req.nextUrl.searchParams
  const businessId = params.get('business_id')
  const from       = params.get('from') ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10)
  const to         = params.get('to')   ?? new Date().toISOString().slice(0, 10)
  // Legacy year param support (old page still passes ?year=)
  const year       = params.get('year') ? parseInt(params.get('year')!) : null

  const db = createAdminClient()

  // ── 1. Load department definitions ────────────────────────────────────────
  // Try departments table first — if no rows yet, fall back to inferring from
  // staff_logs.staff_group so the page works before admin setup
  let deptDefs: Array<{ name: string; color: string; sort_order: number }> = []

  let deptQuery = db.from('departments')
    .select('name, color, sort_order')
    .eq('org_id', auth.orgId)
    .order('sort_order', { ascending: true })
  if (businessId) deptQuery = deptQuery.eq('business_id', businessId)

  const { data: deptRows } = await deptQuery

  if (deptRows && deptRows.length > 0) {
    deptDefs = deptRows
  } else {
    // Fallback: derive from staff_logs.staff_group
    let sgQuery = db.from('staff_logs')
      .select('staff_group')
      .eq('org_id', auth.orgId)
      .not('staff_group', 'is', null)
    if (businessId) sgQuery = sgQuery.eq('business_id', businessId)
    const { data: sgRows } = await sgQuery
    const seen = new Set<string>()
    for (const r of sgRows ?? []) {
      if (r.staff_group && !seen.has(r.staff_group)) {
        seen.add(r.staff_group)
        deptDefs.push({ name: r.staff_group, color: '#6366f1', sort_order: 0 })
      }
    }
    deptDefs.sort((a, b) => a.name.localeCompare(b.name))
  }

  if (deptDefs.length === 0) {
    return NextResponse.json({ departments: [], monthly: [], totals: {}, staff: [], summary: {} })
  }

  const deptNames = deptDefs.map(d => d.name)

  // ── 2. Determine date range ────────────────────────────────────────────────
  let dateFrom = from
  let dateTo   = to
  if (year) {
    dateFrom = `${year}-01-01`
    dateTo   = `${year}-12-31`
  }

  // ── 3. Revenue logs — one row per day per Inzii provider ─────────────────
  // Collect all inzii_* provider keys for this business's departments
  const inziiProviders = deptNames.map(deptToProviderKey)

  let revQuery = db.from('revenue_logs')
    .select('date, provider, revenue_net, covers')
    .eq('org_id', auth.orgId)
    .gte('date', dateFrom)
    .lte('date', dateTo)
    .in('provider', inziiProviders)
  if (businessId) revQuery = revQuery.eq('business_id', businessId)

  const { data: revLogs } = await revQuery

  // ── 4. Staff logs — hours + cost per shift ────────────────────────────────
  let staffQuery = db.from('staff_logs')
    .select('shift_date, staff_name, staff_group, hours_worked, cost_actual, estimated_salary, ob_supplement_kr, is_late, period_month')
    .eq('org_id', auth.orgId)
    .gte('shift_date', dateFrom)
    .lte('shift_date', dateTo)
    .in('staff_group', deptNames)
    .or('cost_actual.gt.0,estimated_salary.gt.0')
  if (businessId) staffQuery = staffQuery.eq('business_id', businessId)

  const { data: staffLogs } = await staffQuery

  // ── 5. Aggregate per department ───────────────────────────────────────────
  // Build lookup: provider_key → dept name
  const providerToDept: Record<string, string> = {}
  for (const d of deptDefs) providerToDept[deptToProviderKey(d.name)] = d.name

  // Per-dept accumulators
  const deptAcc: Record<string, {
    revenue: number; covers: number
    cost: number; estimated_salary: number; hours: number; shifts: number
    ob_supplement: number; late_shifts: number
    staffMap: Record<string, { name: string; cost: number; hours: number; shifts: number }>
  }> = {}

  for (const d of deptDefs) {
    deptAcc[d.name] = {
      revenue: 0, covers: 0,
      cost: 0, estimated_salary: 0, hours: 0, shifts: 0,
      ob_supplement: 0, late_shifts: 0,
      staffMap: {},
    }
  }

  for (const r of revLogs ?? []) {
    const dept = providerToDept[r.provider]
    if (!dept || !deptAcc[dept]) continue
    deptAcc[dept].revenue += r.revenue_net ?? 0
    deptAcc[dept].covers  += r.covers      ?? 0
  }

  for (const s of staffLogs ?? []) {
    const dept = s.staff_group
    if (!dept || !deptAcc[dept]) continue
    const cost = s.cost_actual > 0 ? s.cost_actual : (s.estimated_salary ?? 0)
    deptAcc[dept].cost               += s.cost_actual       ?? 0
    deptAcc[dept].estimated_salary   += s.estimated_salary  ?? 0
    deptAcc[dept].hours              += s.hours_worked       ?? 0
    deptAcc[dept].shifts             += 1
    deptAcc[dept].ob_supplement      += s.ob_supplement_kr  ?? 0
    if (s.is_late) deptAcc[dept].late_shifts += 1

    // Per-staff within dept
    const key = s.staff_name ?? 'Unknown'
    if (!deptAcc[dept].staffMap[key]) deptAcc[dept].staffMap[key] = { name: key, cost: 0, hours: 0, shifts: 0 }
    deptAcc[dept].staffMap[key].cost   += cost
    deptAcc[dept].staffMap[key].hours  += s.hours_worked ?? 0
    deptAcc[dept].staffMap[key].shifts += 1
  }

  // ── 6. Build output ───────────────────────────────────────────────────────
  const departments = deptDefs.map(d => {
    const a = deptAcc[d.name]
    const effectiveCost = a.cost > 0 ? a.cost : a.estimated_salary
    const gp            = a.revenue > 0 ? Math.round(((a.revenue - effectiveCost) / a.revenue) * 1000) / 10 : null
    const revPerHour    = a.hours > 0 ? Math.round(a.revenue / a.hours) : 0
    const costPerHour   = a.hours > 0 ? Math.round(effectiveCost / a.hours) : 0
    const avgSpend      = a.covers > 0 ? Math.round((a.revenue / a.covers) * 10) / 10 : 0
    return {
      name:             d.name,
      color:            d.color,
      revenue:          Math.round(a.revenue),
      covers:           Math.round(a.covers),
      avg_spend:        avgSpend,
      staff_cost:       Math.round(effectiveCost),
      hours:            Math.round(a.hours * 10) / 10,
      shifts:           a.shifts,
      gp_pct:           gp,
      rev_per_hour:     revPerHour,
      cost_per_hour:    costPerHour,
      labour_pct:       a.revenue > 0 ? Math.round((effectiveCost / a.revenue) * 1000) / 10 : null,
      ob_supplement:    Math.round(a.ob_supplement),
      late_shifts:      a.late_shifts,
      payroll_pending:  a.cost === 0 && a.estimated_salary > 0,
      staff:            Object.values(a.staffMap)
        .map(s => ({ ...s, cost: Math.round(s.cost), hours: Math.round(s.hours * 10) / 10 }))
        .sort((a, b) => b.cost - a.cost),
    }
  })

  // ── 7. Summary rollup ────────────────────────────────────────────────────
  const totalRevenue = departments.reduce((s, d) => s + d.revenue, 0)
  const totalCost    = departments.reduce((s, d) => s + d.staff_cost, 0)
  const totalHours   = departments.reduce((s, d) => s + d.hours, 0)
  const totalCovers  = departments.reduce((s, d) => s + d.covers, 0)
  const summary = {
    total_revenue:    Math.round(totalRevenue),
    total_staff_cost: Math.round(totalCost),
    total_hours:      Math.round(totalHours * 10) / 10,
    total_covers:     Math.round(totalCovers),
    gp_pct:           totalRevenue > 0 ? Math.round(((totalRevenue - totalCost) / totalRevenue) * 1000) / 10 : null,
    labour_pct:       totalRevenue > 0 ? Math.round((totalCost / totalRevenue) * 1000) / 10 : null,
    rev_per_hour:     totalHours > 0 ? Math.round(totalRevenue / totalHours) : 0,
  }

  // ── 8. Monthly breakdown (staff + revenue) ────────────────────────────────
  const monthlyMap: Record<string, any> = {}

  for (const r of revLogs ?? []) {
    const dept = providerToDept[r.provider]
    if (!dept) continue
    const d   = new Date(r.date)
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`
    if (!monthlyMap[key]) monthlyMap[key] = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }
    if (!monthlyMap[key][dept]) monthlyMap[key][dept] = { revenue: 0, cost: 0, hours: 0 }
    monthlyMap[key][dept].revenue += r.revenue_net ?? 0
  }

  for (const s of staffLogs ?? []) {
    const dept = s.staff_group
    if (!dept || !monthlyMap) continue
    const d   = new Date(s.shift_date)
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`
    if (!monthlyMap[key]) monthlyMap[key] = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }
    if (!monthlyMap[key][dept]) monthlyMap[key][dept] = { revenue: 0, cost: 0, hours: 0 }
    const cost = (s.cost_actual > 0 ? s.cost_actual : (s.estimated_salary ?? 0))
    monthlyMap[key][dept].cost  += cost
    monthlyMap[key][dept].hours += s.hours_worked ?? 0
  }

  const monthly = Object.values(monthlyMap).sort((a: any, b: any) =>
    a.year !== b.year ? a.year - b.year : a.month - b.month
  )

  // Legacy fields kept for backward compat with old page shape
  const totalsLegacy: Record<string, any> = {}
  for (const d of departments) {
    totalsLegacy[d.name] = { cost: d.staff_cost, hours: d.hours, staff: d.staff.length }
  }
  const staffLegacy = departments.flatMap(d =>
    d.staff.map(s => ({ ...s, group: d.name }))
  )

  return NextResponse.json({
    departments,
    summary,
    monthly,
    // Legacy shape so old page still renders during transition
    totals:      totalsLegacy,
    staff:       staffLegacy,
    date_from:   dateFrom,
    date_to:     dateTo,
  })
}
