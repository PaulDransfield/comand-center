// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { colourForIndex }            from '@/context/BizContext'

// Force dynamic - never cache this route
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(req: NextRequest) {
  const cookieName  = `sb-llzmixkrysduztsvmfzi-auth-token`
  const cookieValue = req.cookies.get(cookieName)?.value

  if (!cookieValue) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  let userId: string
  try {
    let accessToken = cookieValue
    if (cookieValue.startsWith('[') || cookieValue.startsWith('{')) {
      const parsed = JSON.parse(cookieValue)
      accessToken  = Array.isArray(parsed) ? parsed[0] : parsed.access_token
    }
    const adminDb     = createAdminClient()
    const { data: { user } } = await adminDb.auth.getUser(accessToken)
    if (!user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 })
    userId = user.id
  } catch (e: any) {
    return NextResponse.json({ error: 'Auth failed', detail: e.message }, { status: 401 })
  }

  const adminDb = createAdminClient()

  const { data: membership } = await adminDb
    .from('organisation_members')
    .select('org_id')
    .eq('user_id', userId)
    .single()

  if (!membership) return NextResponse.json({ error: 'No org' }, { status: 404 })

  const orgId = membership.org_id
  const now   = new Date()
  const year  = now.getFullYear()
  const month = now.getMonth() + 1

  const { data: businesses } = await adminDb
    .from('businesses')
    .select('id, name, type, city, org_number, colour, target_staff_pct, target_food_pct, target_rent_pct, target_margin_pct')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('name')

  if (!businesses?.length) return NextResponse.json([])

  const { data: trackerRows } = await adminDb
    .from('tracker_data')
    .select('business_id, revenue, staff_cost, food_cost, rent_cost, other_cost, net_profit, margin_pct')
    .eq('org_id', orgId)
    .eq('period_year', year)
    .eq('period_month', month)

  const trackerMap: Record<string, any> = {}
  for (const row of trackerRows ?? []) {
    trackerMap[row.business_id] = row
  }

  const shaped = businesses.map((biz, i) => {
    const t          = trackerMap[biz.id] ?? {}
    const revenue    = Number(t.revenue    ?? 0)
    const staff_cost = Number(t.staff_cost ?? 0)
    const food_cost  = Number(t.food_cost  ?? 0)
    const rent_cost  = Number(t.rent_cost  ?? 0)
    const other_cost = Number(t.other_cost ?? 0)
    const net_profit = Number(t.net_profit ?? 0)
    const margin     = Number(t.margin_pct ?? 0)
    const staffPct   = revenue > 0 ? Math.round(staff_cost / revenue * 100) : 0
    const foodPct    = revenue > 0 ? Math.round(food_cost  / revenue * 100) : 0
    const rentPct    = revenue > 0 ? Math.round(rent_cost  / revenue * 100) : 0

    return {
      id: biz.id, name: biz.name, type: biz.type,
      city: biz.city, org_number: biz.org_number,
      colour: biz.colour ?? colourForIndex(i),
      target_staff_pct:  Number(biz.target_staff_pct  ?? 40),
      target_food_pct:   Number(biz.target_food_pct   ?? 31),
      target_rent_pct:   Number(biz.target_rent_pct   ?? 13),
      target_margin_pct: Number(biz.target_margin_pct ?? 12),
      revenue, staff_cost, food_cost, rent_cost,
      other_cost, net_profit, margin,
      staffPct, foodPct, rentPct,
    }
  })

  // No-cache headers so browser always gets fresh data
  return NextResponse.json(shaped, {
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    }
  })
}
