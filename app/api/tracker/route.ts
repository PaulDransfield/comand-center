// @ts-nocheck
// app/api/tracker/route.ts
// GET  — fetch P&L data for a business/year
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
  const { data, error } = await db
    .from('tracker_data')
    .select('*')
    .eq('business_id', businessId)
    .eq('period_year', year)
    .order('period_month')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
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

  // Check if exists
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
