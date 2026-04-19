// @ts-nocheck
// app/api/scheduling/route.ts
// GET scheduling efficiency: revenue per labor hour by weekday + daily trend
// Joins staff_logs + revenue_logs by date — no new tables needed

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const getAuth = getRequestAuth

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const businessId = searchParams.get('business_id')
  const ninetyDaysAgo = new Date(); ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
  const from = searchParams.get('from') ?? ninetyDaysAgo.toISOString().slice(0, 10)
  const to   = searchParams.get('to')   ?? new Date().toISOString().slice(0, 10)

  const db = createAdminClient()

  // Read from daily_metrics (aggregator already joined revenue + staff by date
  // and coerced numeric-as-string into JS numbers). Used to re-aggregate raw
  // staff_logs + revenue_logs here with `.limit(50000)` — hit Supabase's silent
  // 1000-row cap and under-counted.
  // .lte dropped on date column (§0 boundary bug); filter upper bound in memory.
  let metricsQuery = db.from('daily_metrics')
    .select('date, revenue, staff_cost, hours_worked')
    .eq('org_id', auth.orgId)
    .gte('date', from)
    .order('date', { ascending: true })
  if (businessId) metricsQuery = metricsQuery.eq('business_id', businessId)
  const { data: metrics, error: metricsErr } = await metricsQuery
  if (metricsErr) return NextResponse.json({ error: metricsErr.message }, { status: 500 })

  const daily = (metrics ?? [])
    .filter((m: any) => !m.date || m.date <= to)
    .filter((m: any) => Number(m.revenue ?? 0) > 0 && Number(m.hours_worked ?? 0) > 0)
    .map((m: any) => {
      const revenue = Number(m.revenue ?? 0)
      const hours   = Number(m.hours_worked ?? 0)
      const cost    = Number(m.staff_cost ?? 0)
      return {
        date:         m.date,
        revenue:      Math.round(revenue),
        hours:        Math.round(hours * 10) / 10,
        cost:         Math.round(cost),
        rev_per_hour: hours > 0 ? Math.round(revenue / hours) : null,
        staff_pct:    revenue > 0 ? Math.round((cost / revenue) * 1000) / 10 : null,
      }
    })

  // Summary stats
  const daysWithRevPAH = daily.filter(d => d.rev_per_hour !== null)
  const avgRevPerHour  = daysWithRevPAH.length > 0
    ? Math.round(daysWithRevPAH.reduce((s, d) => s + (d.rev_per_hour ?? 0), 0) / daysWithRevPAH.length)
    : null

  // Weekday aggregation — 0=Mon … 6=Sun
  type WdAcc = { revenue: number[]; hours: number[]; cost: number[]; rev_per_hour: number[] }
  const wdAcc: Record<number, WdAcc> = {}
  for (let i = 0; i < 7; i++) wdAcc[i] = { revenue: [], hours: [], cost: [], rev_per_hour: [] }

  for (const d of daily) {
    const dow = (new Date(d.date).getUTCDay() + 6) % 7
    wdAcc[dow].revenue.push(d.revenue)
    wdAcc[dow].hours.push(d.hours)
    wdAcc[dow].cost.push(d.cost)
    if (d.rev_per_hour !== null) wdAcc[dow].rev_per_hour.push(d.rev_per_hour)
  }

  const avg = (arr: number[]) => arr.length > 0 ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null

  const weekday_efficiency = DAYS.map((label, i) => {
    const acc        = wdAcc[i]
    const avg_revenue    = avg(acc.revenue)
    const avg_hours      = acc.hours.length > 0 ? Math.round(avg(acc.hours)! * 10) / 10 : null
    const avg_cost       = avg(acc.cost)
    const avg_rev_per_hour = avg(acc.rev_per_hour)
    const days_with_data = acc.revenue.length

    // Status: compare each day's rev/hour to overall average
    let status: 'efficient' | 'understaffed' | 'overstaffed' | 'no_data' = 'no_data'
    if (avg_rev_per_hour !== null && avgRevPerHour !== null && days_with_data >= 2) {
      const ratio = avg_rev_per_hour / avgRevPerHour
      if (ratio > 1.20)      status = 'understaffed'   // high revenue per hour = labour is scarce vs demand
      else if (ratio < 0.80) status = 'overstaffed'    // low revenue per hour = too many hours for the demand
      else                   status = 'efficient'
    }

    return { weekday: i, label, days_with_data, avg_revenue, avg_hours, avg_cost, avg_rev_per_hour, status }
  })

  const withData = weekday_efficiency.filter(w => w.avg_rev_per_hour !== null)
  const bestDay  = withData.length > 0 ? withData.reduce((b, w) => (w.avg_rev_per_hour ?? 0) > (b.avg_rev_per_hour ?? 0) ? w : b) : null
  const worstDay = withData.length > 0 ? withData.reduce((b, w) => (w.avg_rev_per_hour ?? 0) < (b.avg_rev_per_hour ?? 0) ? w : b) : null

  const summary = {
    avg_rev_per_hour: avgRevPerHour,
    days_analyzed:    daily.length,
    total_hours:      Math.round(daily.reduce((s, d) => s + d.hours, 0) * 10) / 10,
    total_revenue:    Math.round(daily.reduce((s, d) => s + d.revenue, 0)),
    best_weekday:     bestDay,
    worst_weekday:    worstDay,
    understaffed_days: weekday_efficiency.filter(w => w.status === 'understaffed').map(w => w.label),
    overstaffed_days:  weekday_efficiency.filter(w => w.status === 'overstaffed').map(w => w.label),
  }

  // Latest AI scheduling recommendation — may not exist if table hasn't been created yet
  let latest_recommendation = null
  try {
    const { data: rec } = await db
      .from('scheduling_recommendations')
      .select('generated_at, recommendations, analysis_period, metadata')
      .eq('org_id', auth.orgId)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (rec) latest_recommendation = rec
  } catch { /* table may not exist yet — ignore */ }

  return NextResponse.json({
    weekday_efficiency,
    daily_revpah: daily,
    summary,
    latest_recommendation,
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}
