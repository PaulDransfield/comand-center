// @ts-nocheck
// app/api/revenue-detail/route.ts
// GET daily revenue breakdown — dine-in, takeaway, tips from revenue_logs

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const getAuth = getRequestAuth

export async function GET(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const businessId = searchParams.get('business_id')
  const from       = searchParams.get('from') ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10)
  const to         = searchParams.get('to')   ?? new Date().toISOString().slice(0,10)

  const db = createAdminClient()

  const query = db
    .from('revenue_logs')
    .select('revenue_date, revenue, covers, tip_revenue, takeaway_revenue, dine_in_revenue, food_revenue, bev_revenue, revenue_per_cover, transactions, provider')
    .eq('org_id', auth.orgId)
    .gte('revenue_date', from)
    .lte('revenue_date', to)
    .order('revenue_date', { ascending: false })

  if (businessId) query.eq('business_id', businessId)

  const { data, error } = await query

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Aggregate by date (may have multiple providers per day)
  const byDate: Record<string, any> = {}
  for (const row of data ?? []) {
    const d = row.revenue_date
    if (!byDate[d]) byDate[d] = {
      date: d, revenue: 0, covers: 0,
      tip_revenue: 0, takeaway_revenue: 0, dine_in_revenue: 0,
      food_revenue: 0, bev_revenue: 0,
      transactions: 0, providers: []
    }
    byDate[d].revenue          += Number(row.revenue          ?? 0)
    byDate[d].covers           += Number(row.covers           ?? 0)
    byDate[d].tip_revenue      += Number(row.tip_revenue      ?? 0)
    byDate[d].takeaway_revenue += Number(row.takeaway_revenue ?? 0)
    byDate[d].dine_in_revenue  += Number(row.dine_in_revenue  ?? 0)
    byDate[d].food_revenue     += Number(row.food_revenue     ?? 0)
    byDate[d].bev_revenue      += Number(row.bev_revenue      ?? 0)
    byDate[d].transactions     += Number(row.transactions     ?? 0)
    if (!byDate[d].providers.includes(row.provider)) byDate[d].providers.push(row.provider)
  }

  // Fill ALL days in range — even closed days with no revenue
  const allDays: any[] = []
  const startDate = new Date(from)
  const endDate   = new Date(to)
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().slice(0,10)
    const existing = byDate[dateStr]
    const row = existing ?? {
      date: dateStr, revenue: 0, covers: 0,
      tip_revenue: 0, takeaway_revenue: 0, dine_in_revenue: 0,
      food_revenue: 0, bev_revenue: 0,
      transactions: 0, providers: []
    }
    allDays.push({
      ...row,
      revenue_per_cover: row.covers > 0 ? Math.round(row.revenue / row.covers) : 0,
      takeaway_pct:      row.revenue > 0 ? Math.round((row.takeaway_revenue / row.revenue) * 100) : 0,
      tip_pct:           row.revenue > 0 ? Math.round((row.tip_revenue / row.revenue) * 100) : 0,
      is_closed:         !existing || row.revenue === 0,
    })
  }
  const rows = allDays.sort((a, b) => b.date.localeCompare(a.date))

  // Summary totals
  const summary = {
    total_revenue:      rows.reduce((s, r) => s + r.revenue, 0),
    total_covers:       rows.reduce((s, r) => s + r.covers, 0),
    total_tips:         rows.reduce((s, r) => s + r.tip_revenue, 0),
    total_takeaway:     rows.reduce((s, r) => s + r.takeaway_revenue, 0),
    total_dine_in:      rows.reduce((s, r) => s + r.dine_in_revenue, 0),
    total_food_revenue: rows.reduce((s, r) => s + (r.food_revenue ?? 0), 0),
    total_bev_revenue:  rows.reduce((s, r) => s + (r.bev_revenue  ?? 0), 0),
    days_with_data:     rows.length,
    avg_daily_rev:      rows.length > 0 ? Math.round(rows.reduce((s,r) => s+r.revenue, 0) / rows.length) : 0,
    avg_rpc:            rows.filter(r => r.covers > 0).length > 0
      ? Math.round(rows.filter(r => r.covers > 0).reduce((s,r) => s + r.revenue_per_cover, 0) / rows.filter(r => r.covers > 0).length)
      : 0,
  }

  return NextResponse.json({ rows, summary })
}
