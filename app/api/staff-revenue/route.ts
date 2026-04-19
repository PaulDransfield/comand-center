// @ts-nocheck
// app/api/staff-revenue/route.ts
// GET daily staff cost % by joining staff_logs with revenue_logs by date
// Returns per-day rows + period summary for tracking vs target

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
  const businessId  = searchParams.get('business_id')
  const from        = searchParams.get('from') ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10)
  const to          = searchParams.get('to')   ?? new Date().toISOString().slice(0, 10)
  const targetPct   = parseFloat(searchParams.get('target_pct') ?? '40')

  const db = createAdminClient()

  // Read from daily_metrics — aggregator has already joined staff cost + revenue
  // by date. Used to re-aggregate raw staff_logs + revenue_logs here with
  // `.limit(50000)` that silently hit Supabase's 1000-row cap.
  // .lte dropped on date column (§0); filter upper bound in memory.
  let metricsQuery = db.from('daily_metrics')
    .select('date, revenue, staff_cost')
    .eq('org_id', auth.orgId)
    .gte('date', from)
    .order('date', { ascending: true })
  if (businessId) metricsQuery = metricsQuery.eq('business_id', businessId)
  const { data: metrics, error: metricsErr } = await metricsQuery
  if (metricsErr) return NextResponse.json({ error: metricsErr.message }, { status: 500 })

  const rows = (metrics ?? [])
    .filter((m: any) => !m.date || m.date <= to)
    .map((m: any) => {
      const staff_cost = Math.round(Number(m.staff_cost ?? 0))
      const revenue    = Math.round(Number(m.revenue ?? 0))
      const staff_pct  = revenue > 0 && staff_cost > 0
        ? Math.round((staff_cost / revenue) * 1000) / 10
        : null
      const vs_target  = staff_pct !== null ? Math.round((staff_pct - targetPct) * 10) / 10 : null
      return { date: m.date, staff_cost, revenue, staff_pct, vs_target, has_both: staff_cost > 0 && revenue > 0 }
    })

  const joinedRows = rows.filter(r => r.has_both)

  // Summary
  const pctsWithData  = joinedRows.filter(r => r.staff_pct !== null).map(r => r.staff_pct as number)
  const avgStaffPct   = pctsWithData.length > 0
    ? Math.round(pctsWithData.reduce((s, p) => s + p, 0) / pctsWithData.length * 10) / 10
    : null
  const daysOverTarget  = joinedRows.filter(r => r.staff_pct !== null && r.staff_pct > targetPct).length
  const daysUnderTarget = joinedRows.filter(r => r.staff_pct !== null && r.staff_pct <= targetPct).length
  const bestDay  = joinedRows.reduce((b, r) => r.staff_pct !== null && (b === null || r.staff_pct < b.staff_pct!) ? r : b, null as any)
  const worstDay = joinedRows.reduce((w, r) => r.staff_pct !== null && (w === null || r.staff_pct > w.staff_pct!) ? r : w, null as any)

  const summary = {
    avg_staff_pct:     avgStaffPct,
    target_pct:        targetPct,
    days_over_target:  daysOverTarget,
    days_under_target: daysUnderTarget,
    days_joined:       joinedRows.length,
    days_staff_only:   rows.filter(r => r.staff_cost > 0 && r.revenue === 0).length,
    days_revenue_only: rows.filter(r => r.revenue > 0 && r.staff_cost === 0).length,
    best_day:          bestDay  ? { date: bestDay.date,  pct: bestDay.staff_pct,  staff_cost: bestDay.staff_cost,  revenue: bestDay.revenue  } : null,
    worst_day:         worstDay ? { date: worstDay.date, pct: worstDay.staff_pct, staff_cost: worstDay.staff_cost, revenue: worstDay.revenue } : null,
    total_staff_cost:  Math.round(joinedRows.reduce((s, r) => s + r.staff_cost, 0)),
    total_revenue:     Math.round(joinedRows.reduce((s, r) => s + r.revenue,    0)),
  }

  return NextResponse.json({ rows: joinedRows, summary }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}
