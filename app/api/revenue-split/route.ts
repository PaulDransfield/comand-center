// @ts-nocheck
// app/api/revenue-split/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'

async function getAuth(req: NextRequest) {
  const cookieName  = 'sb-llzmixkrysduztsvmfzi-auth-token'
  const cookieValue = req.cookies.get(cookieName)?.value
  if (!cookieValue) return null
  try {
    let accessToken = cookieValue
    if (cookieValue.startsWith('[') || cookieValue.startsWith('{')) {
      const parsed = JSON.parse(cookieValue)
      accessToken  = Array.isArray(parsed) ? parsed[0] : parsed.access_token
    }
    const db = createAdminClient()
    const { data: { user } } = await db.auth.getUser(accessToken)
    if (!user) return null
    const { data: m } = await db.from('organisation_members').select('org_id').eq('user_id', user.id).single()
    if (!m) return null
    return { userId: user.id, orgId: m.org_id }
  } catch { return null }
}

export async function GET(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const businessId = searchParams.get('business_id')
  const year       = parseInt(searchParams.get('year') ?? String(new Date().getFullYear()))

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()

  const { data: tracker } = await db
    .from('tracker_data')
    .select('period_month, revenue, food_cost')
    .eq('business_id', businessId)
    .eq('period_year', year)
    .order('period_month')

  if (!tracker?.length) return NextResponse.json({ year, months: [] })

  const { data: vatData } = await db
    .from('vat_breakdown')
    .select('period_month, revenue_25_net, revenue_12_net')
    .eq('business_id', businessId)
    .eq('period_year', year)

  const vatMap: Record<number, { rev25: number; rev12: number }> = {}
  for (const v of vatData ?? []) {
    vatMap[v.period_month] = { rev25: Number(v.revenue_25_net ?? 0), rev12: Number(v.revenue_12_net ?? 0) }
  }

  // Also get food/bev split from revenue_logs (Ancon/Swess POS)
  const { data: revLogs } = await db
    .from('revenue_logs')
    .select('period_month, food_revenue, bev_revenue, revenue')
    .eq('business_id', businessId)
    .eq('period_year', year)

  const revLogMap: Record<number, { food: number; bev: number; total: number }> = {}
  for (const r of revLogs ?? []) {
    const m = r.period_month
    if (!revLogMap[m]) revLogMap[m] = { food: 0, bev: 0, total: 0 }
    revLogMap[m].food  += Number(r.food_revenue ?? 0)
    revLogMap[m].bev   += Number(r.bev_revenue  ?? 0)
    revLogMap[m].total += Number(r.revenue      ?? 0)
  }

  const months = tracker.map(row => {
    const revenue = Number(row.revenue ?? 0)
    const month   = row.period_month
    const vat     = vatMap[month]
    const posData = revLogMap[month]

    let foodRevenue: number, bevRevenue: number, source: string

    if (posData && (posData.food + posData.bev) > 0) {
      // Best: actual food/bev split from POS system
      foodRevenue = posData.food
      bevRevenue  = posData.bev
      source      = 'pos_data'
    } else if (vat && (vat.rev25 + vat.rev12) > 0) {
      // Good: derive from VAT rates (12% = food, 25% = alcohol)
      foodRevenue = vat.rev12 * 1.12
      bevRevenue  = vat.rev25 * 1.25
      source      = 'vat_breakdown'
    } else {
      // Fallback: Swedish industry average estimate
      foodRevenue = revenue * 0.55
      bevRevenue  = revenue * 0.45
      source      = 'estimated'
    }

    const foodCost = Number(row.food_cost ?? 0)

    return {
      month,
      revenue,
      food_revenue:      Math.round(foodRevenue),
      bev_revenue:       Math.round(bevRevenue),
      food_pct:          revenue > 0 ? Math.round((foodRevenue / revenue) * 1000) / 10 : 0,
      bev_pct:           revenue > 0 ? Math.round((bevRevenue  / revenue) * 1000) / 10 : 0,
      food_cost:         Math.round(foodCost),
      food_cost_on_food: foodRevenue > 0 ? Math.round((foodCost / foodRevenue) * 1000) / 10 : 0,
      source,
    }
  })

  return NextResponse.json({ year, months })
}
