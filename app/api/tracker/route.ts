// @ts-nocheck
// app/api/tracker/route.ts
// GET  — fetch P&L data for a business/year
//        Merges manual tracker_data with real synced data from revenue_logs + staff_logs
// POST — save or update a month's P&L data

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const getAuth = getRequestAuth

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const businessId = searchParams.get('business_id')
  const year       = parseInt(searchParams.get('year') ?? String(new Date().getFullYear()))

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()

  // Read from the summary table the aggregator writes after every sync.
  // Previously re-aggregated raw revenue_logs + staff_logs here with
  // `.limit(50000)` which silently hit Supabase's 1000-row cap on staff
  // and under-counted cost for any business with >1000 shifts a year.
  // The summary tables already dedupe providers + coerce numeric strings.
  const [trackerRes, monthlyRes] = await Promise.all([
    db.from('tracker_data').select('*').eq('org_id', auth.orgId).eq('business_id', businessId).eq('period_year', year).order('period_month'),
    db.from('monthly_metrics').select('month, revenue, staff_cost, food_cost').eq('org_id', auth.orgId).eq('business_id', businessId).eq('year', year),
  ])

  const manualRows = trackerRes.data ?? []

  const syncedRev:   Record<number, number> = {}
  const syncedStaff: Record<number, number> = {}
  const syncedFood:  Record<number, number> = {}
  for (const m of monthlyRes.data ?? []) {
    syncedRev[m.month]   = Number(m.revenue ?? 0)
    syncedStaff[m.month] = Number(m.staff_cost ?? 0)
    syncedFood[m.month]  = Number(m.food_cost ?? 0)
  }

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
    const syncedFc   = Math.round(syncedFood[m] ?? 0)
    const food_cost  = syncedFc > 0 ? syncedFc : Number(manual?.food_cost ?? 0)

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

  return NextResponse.json(merged, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
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
