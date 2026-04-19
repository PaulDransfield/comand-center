// @ts-nocheck
// /api/metrics/monthly — read pre-computed monthly metrics
// Returns monthly P&L rows for a year. Used by tracker, forecast, dashboard month view.
// Single source of truth — merges synced POS + PK + Fortnox + manual data.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const businessId = searchParams.get('business_id')
  const year       = parseInt(searchParams.get('year') ?? String(new Date().getFullYear()))

  if (!businessId) {
    return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  }

  const db = createAdminClient()

  const { data: rows, error } = await db
    .from('monthly_metrics')
    .select('*')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .eq('year', year)
    .order('month', { ascending: true })

  if (error) {
    console.warn('monthly_metrics query failed:', error.message)
    return NextResponse.json({ rows: [], summary: null, _fallback: true })
  }

  // YTD summary
  const totalRev    = rows.reduce((s, r) => s + r.revenue, 0)
  const totalCost   = rows.reduce((s, r) => s + r.total_cost, 0)
  const totalProfit = rows.reduce((s, r) => s + r.net_profit, 0)
  const totalHours  = rows.reduce((s, r) => s + Number(r.hours_worked), 0)

  const summary = {
    ytd_revenue:    totalRev,
    ytd_staff_cost: rows.reduce((s, r) => s + r.staff_cost, 0),
    ytd_food_cost:  rows.reduce((s, r) => s + r.food_cost, 0),
    ytd_total_cost: totalCost,
    ytd_net_profit: totalProfit,
    ytd_margin_pct: totalRev > 0 ? Math.round((totalProfit / totalRev) * 1000) / 10 : 0,
    ytd_labour_pct: totalRev > 0 ? Math.round((rows.reduce((s, r) => s + r.staff_cost, 0) / totalRev) * 1000) / 10 : null,
    ytd_hours:      Math.round(totalHours * 10) / 10,
    months_with_data: rows.length,
  }

  return NextResponse.json({ rows, summary, year }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}
