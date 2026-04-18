// @ts-nocheck
// app/api/tracker/route.ts
// GET  — fetch P&L data for a business/year
//        Merges manual tracker_data with real synced data from revenue_logs + staff_logs
// POST — save or update a month's P&L data

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

const getAuth = getRequestAuth

export async function GET(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const businessId = searchParams.get('business_id')
  const year       = parseInt(searchParams.get('year') ?? String(new Date().getFullYear()))

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()
  const dateFrom = `${year}-01-01`
  const dateTo   = `${year}-12-31`

  // Fetch all three sources in parallel
  const [trackerRes, revRes, staffRes] = await Promise.all([
    // Manual P&L entries — ALWAYS filter by org_id first (tenant isolation; service role bypasses RLS)
    db.from('tracker_data').select('*').eq('org_id', auth.orgId).eq('business_id', businessId).eq('period_year', year).order('period_month'),
    // Real revenue from POS sync (revenue_logs) — include provider for dedup
    // .lte() on date columns silently drops top-boundary rows in Supabase — use .gte only, filter year in aggregation.
    db.from('revenue_logs').select('revenue_date, revenue, provider').eq('org_id', auth.orgId).eq('business_id', businessId).gte('revenue_date', dateFrom).gt('revenue', 0).limit(50000),
    // Real staff cost from Personalkollen sync (staff_logs)
    db.from('staff_logs').select('shift_date, cost_actual, estimated_salary').eq('org_id', auth.orgId).eq('business_id', businessId).gte('shift_date', dateFrom).or('cost_actual.gt.0,estimated_salary.gt.0').not('pk_log_url', 'like', '%_scheduled').limit(50000),
  ])

  const manualRows = trackerRes.data ?? []

  // Deduplicate: skip aggregate 'personalkollen' rows when per-dept pk_* rows exist.
  // Also filter to the requested year — we had to drop .lte() on the DB query
  // because Supabase silently excludes top-boundary dates in chained gte/lte.
  const yearPrefix = String(year)
  const rawRevRows = (revRes.data ?? []).filter((r: any) => r.revenue_date?.startsWith(yearPrefix))
  const hasDeptRevRows = rawRevRows.some((r: any) => (r.provider ?? '').startsWith('pk_') || (r.provider ?? '').startsWith('inzii_'))
  const dedupedRev = hasDeptRevRows ? rawRevRows.filter((r: any) => (r.provider ?? '') !== 'personalkollen') : rawRevRows

  // Aggregate synced revenue by month
  const syncedRev: Record<number, number> = {}
  for (const r of dedupedRev) {
    const m = parseInt(r.revenue_date.slice(5, 7))
    syncedRev[m] = (syncedRev[m] ?? 0) + (r.revenue ?? 0)
  }

  // Aggregate synced staff cost by month — same year filter as revenue.
  const staffRows = (staffRes.data ?? []).filter((s: any) => s.shift_date?.startsWith(yearPrefix))
  const syncedStaff: Record<number, number> = {}
  for (const s of staffRows) {
    const m    = parseInt(s.shift_date.slice(5, 7))
    const cost = Number(s.cost_actual ?? 0) > 0 ? Number(s.cost_actual) : Number(s.estimated_salary ?? 0)
    syncedStaff[m] = (syncedStaff[m] ?? 0) + cost
  }

  // Merge: use synced data when available, fall back to manual entries
  const manualByMonth: Record<number, any> = {}
  for (const r of manualRows) manualByMonth[r.period_month] = r

  const merged = []
  for (let m = 1; m <= 12; m++) {
    const manual   = manualByMonth[m]
    const realRev  = Math.round(syncedRev[m] ?? 0)
    const realCost = Math.round(syncedStaff[m] ?? 0)

    // Use synced data if it exists, otherwise use manual
    const revenue    = realRev > 0 ? realRev : Number(manual?.revenue ?? 0)
    const staff_cost = realCost > 0 ? realCost : Number(manual?.staff_cost ?? 0)
    const food_cost  = Number(manual?.food_cost ?? 0) // only from manual/Fortnox — no POS source yet

    if (revenue === 0 && staff_cost === 0 && food_cost === 0) continue // skip empty months

    const net_profit = revenue - food_cost - staff_cost
    const margin_pct = revenue > 0 ? Math.round((net_profit / revenue) * 1000) / 10 : 0
    const food_pct   = revenue > 0 ? Math.round((food_cost / revenue) * 1000) / 10 : 0
    const staff_pct  = revenue > 0 ? Math.round((staff_cost / revenue) * 1000) / 10 : 0

    merged.push({
      id:           manual?.id ?? null,
      org_id:       auth.orgId,
      business_id:  businessId,
      period_year:  year,
      period_month: m,
      revenue,
      food_cost,
      staff_cost,
      net_profit:   Math.round(net_profit),
      margin_pct,
      food_pct,
      staff_pct,
      source:       realRev > 0 || realCost > 0 ? 'synced' : 'manual',
      // Flag which values are from synced vs manual
      _synced_revenue:    realRev > 0,
      _synced_staff_cost: realCost > 0,
    })
  }

  return NextResponse.json(merged)
}

export async function POST(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json()
  const { business_id, period_year, period_month, revenue, food_cost, staff_cost } = body

  if (!business_id || !period_year || !period_month) {
    return NextResponse.json({ error: 'business_id, period_year, period_month required' }, { status: 400 })
  }

  const db         = createAdminClient()
  const rev        = Number(revenue ?? 0)
  const food       = Number(food_cost ?? 0)
  const staff      = Number(staff_cost ?? 0)
  const net        = rev - food - staff
  const marginPct  = rev > 0 ? (net / rev) * 100 : 0
  const foodPct    = rev > 0 ? (food / rev) * 100 : 0
  const staffPct   = rev > 0 ? (staff / rev) * 100 : 0

  const { data: existing } = await db
    .from('tracker_data')
    .select('id')
    .eq('business_id', business_id)
    .eq('period_year',  period_year)
    .eq('period_month', period_month)
    .maybeSingle()

  let result
  if (existing) {
    result = await db.from('tracker_data').update({
      revenue, food_cost, staff_cost,
      net_profit: Math.round(net),
      margin_pct: Math.round(marginPct * 10) / 10,
      food_pct:   Math.round(foodPct   * 10) / 10,
      staff_pct:  Math.round(staffPct  * 10) / 10,
    }).eq('id', existing.id).select().single()
  } else {
    result = await db.from('tracker_data').insert({
      org_id: auth.orgId, business_id,
      period_year, period_month,
      revenue, food_cost, staff_cost,
      net_profit: Math.round(net),
      margin_pct: Math.round(marginPct * 10) / 10,
      food_pct:   Math.round(foodPct   * 10) / 10,
      staff_pct:  Math.round(staffPct  * 10) / 10,
    }).select().single()
  }

  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 })
  return NextResponse.json(result.data)
}
