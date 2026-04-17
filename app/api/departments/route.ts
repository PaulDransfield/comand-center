// @ts-nocheck
// /api/departments — group overview: all departments for a business
// Returns each dept with revenue (from Inzii) + staff cost (from PK) + derived metrics
// Also returns monthly trend and per-staff breakdown for the expanded detail view

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const getAuth = getRequestAuth

// Convert a department name to all possible revenue_logs provider keys.
// 'inzii_*'  = direct Swess/Inzii POS API sync
// 'pk_*'     = Personalkollen per-workplace sales sync (same POS data, different source)
function deptToProviderKeys(name: string): string[] {
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '_')
  return [`inzii_${slug}`, `pk_${slug}`]
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
  // Source A: departments table (set up via admin panel, has colour + sort order)
  // Source B: staff_logs.staff_group (always available — auto-fallback)
  // Merge both: table rows take priority, staff_groups fill any gaps
  let deptDefs: Array<{ name: string; color: string; sort_order: number }> = []
  const PALETTE = ['#f59e0b','#10b981','#ef4444','#3b82f6','#8b5cf6','#06b6d4','#f97316','#ec4899','#84cc16','#14b8a6','#a855f7','#0ea5e9']

  // Source A — departments table (may not exist if M006 migration not yet run)
  try {
    let deptQuery = db.from('departments')
      .select('name, color, sort_order')
      .eq('org_id', auth.orgId)
      .order('sort_order', { ascending: true })
    if (businessId) deptQuery = deptQuery.eq('business_id', businessId)
    const { data: deptRows, error: deptErr } = await deptQuery
    if (!deptErr && deptRows && deptRows.length > 0) {
      deptDefs = deptRows
    }
  } catch { /* table may not exist yet — fall through to staff_logs */ }

  // Source B — staff_logs.staff_group (always try; fills gaps when table is empty)
  try {
    let sgQuery = db.from('staff_logs')
      .select('staff_group')
      .eq('org_id', auth.orgId)
      .not('staff_group', 'is', null)
    // Don't filter by businessId here — some orgs share staff across businesses
    const { data: sgRows } = await sgQuery
    const existingNames = new Set(deptDefs.map(d => d.name))
    const newFromStaff: typeof deptDefs = []
    const seen = new Set<string>()
    for (const r of sgRows ?? []) {
      if (r.staff_group && !seen.has(r.staff_group) && !existingNames.has(r.staff_group)) {
        seen.add(r.staff_group)
        newFromStaff.push({ name: r.staff_group, color: PALETTE[seen.size % PALETTE.length], sort_order: 999 })
      }
    }
    newFromStaff.sort((a, b) => a.name.localeCompare(b.name))
    deptDefs = [...deptDefs, ...newFromStaff]
  } catch { /* ignore */ }

  if (deptDefs.length === 0) {
    return NextResponse.json({ departments: [], monthly: [], totals: {}, staff: [], summary: {}, _debug: 'no_depts_found' })
  }

  const deptNames = deptDefs.map(d => d.name)

  // ── 2. Determine date range ────────────────────────────────────────────────
  let dateFrom = from
  let dateTo   = to
  if (year) {
    dateFrom = `${year}-01-01`
    dateTo   = `${year}-12-31`
  }

  // ── 3. Revenue logs — one row per day per provider ───────────────────────
  // Look for both inzii_* (Swess direct) and pk_* (Personalkollen per-workplace) sources
  const allRevProviders = deptNames.flatMap(deptToProviderKeys)

  let revQuery = db.from('revenue_logs')
    .select('revenue_date, provider, revenue, covers')
    .eq('org_id', auth.orgId)
    .gte('revenue_date', dateFrom)
    .lte('revenue_date', dateTo)
    .in('provider', allRevProviders)
  if (businessId) revQuery = revQuery.eq('business_id', businessId)
  revQuery = revQuery.limit(50000)

  const { data: revLogs } = await revQuery

  // ── 4. Staff logs — hours + cost per shift ────────────────────────────────
  let staffQuery = db.from('staff_logs')
    .select('shift_date, staff_name, staff_group, hours_worked, cost_actual, estimated_salary, ob_supplement_kr, is_late, period_month')
    .eq('org_id', auth.orgId)
    .gte('shift_date', dateFrom)
    .lte('shift_date', dateTo)
    .in('staff_group', deptNames)
    .or('cost_actual.gt.0,estimated_salary.gt.0')
    .not('pk_log_url', 'like', '%_scheduled')
  if (businessId) staffQuery = staffQuery.eq('business_id', businessId)
  staffQuery = staffQuery.limit(50000)

  const { data: staffLogs } = await staffQuery

  // ── 5. Aggregate per department ───────────────────────────────────────────
  // Build lookup: provider_key → dept name (covers both inzii_* and pk_* keys)
  const providerToDept: Record<string, string> = {}
  for (const d of deptDefs) {
    for (const key of deptToProviderKeys(d.name)) providerToDept[key] = d.name
  }

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
    deptAcc[dept].revenue += r.revenue ?? 0
    deptAcc[dept].covers  += r.covers  ?? 0
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
    const d   = new Date(r.revenue_date)
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`
    if (!monthlyMap[key]) monthlyMap[key] = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }
    if (!monthlyMap[key][dept]) monthlyMap[key][dept] = { revenue: 0, cost: 0, hours: 0 }
    monthlyMap[key][dept].revenue += r.revenue ?? 0
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
