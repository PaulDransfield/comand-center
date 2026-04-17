// @ts-nocheck
// app/api/scheduling/route.ts
// GET scheduling efficiency: revenue per labor hour by weekday + daily trend
// Joins staff_logs + revenue_logs by date — no new tables needed

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const getAuth = getRequestAuth

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export async function GET(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const businessId = searchParams.get('business_id')
  const ninetyDaysAgo = new Date(); ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
  const from = searchParams.get('from') ?? ninetyDaysAgo.toISOString().slice(0, 10)
  const to   = searchParams.get('to')   ?? new Date().toISOString().slice(0, 10)

  const db = createAdminClient()

  // Fetch staff logs — one row per shift per staff member
  let staffQuery = db
    .from('staff_logs')
    .select('shift_date, hours_worked, cost_actual, estimated_salary')
    .eq('org_id', auth.orgId)
    .gte('shift_date', from)
    .lte('shift_date', to)
    .or('hours_worked.gt.0,cost_actual.gt.0,estimated_salary.gt.0')
    .not('pk_log_url', 'like', '%_scheduled')

  if (businessId) staffQuery = staffQuery.eq('business_id', businessId)
  staffQuery = staffQuery.limit(50000)

  // Fetch revenue logs
  let revQuery = db
    .from('revenue_logs')
    .select('revenue_date, revenue')
    .eq('org_id', auth.orgId)
    .gte('revenue_date', from)
    .lte('revenue_date', to)
    .gt('revenue', 0)

  if (businessId) revQuery = revQuery.eq('business_id', businessId)
  revQuery = revQuery.limit(50000)

  const [{ data: staffLogs, error: staffErr }, { data: revLogs, error: revErr }] = await Promise.all([
    staffQuery, revQuery,
  ])

  if (staffErr) return NextResponse.json({ error: staffErr.message }, { status: 500 })
  if (revErr)   return NextResponse.json({ error: revErr.message  }, { status: 500 })

  // Aggregate staff totals by date
  const staffByDate: Record<string, { hours: number; cost: number }> = {}
  for (const log of staffLogs ?? []) {
    const d = log.shift_date
    if (!staffByDate[d]) staffByDate[d] = { hours: 0, cost: 0 }
    staffByDate[d].hours += Number(log.hours_worked  ?? 0)
    // Use actual cost when approved; fall back to estimated for pending payroll
    const cost = Number(log.cost_actual ?? 0) > 0 ? Number(log.cost_actual) : Number(log.estimated_salary ?? 0)
    staffByDate[d].cost += cost
  }

  // Aggregate revenue by date
  const revByDate: Record<string, number> = {}
  for (const r of revLogs ?? []) {
    revByDate[r.revenue_date] = (revByDate[r.revenue_date] ?? 0) + Number(r.revenue ?? 0)
  }

  // Build joined daily rows — only days where both revenue AND hours exist
  const joinedDates = Object.keys(staffByDate).filter(d => (revByDate[d] ?? 0) > 0 && staffByDate[d].hours > 0)
  const daily = joinedDates.map(date => {
    const hours     = staffByDate[date].hours
    const cost      = staffByDate[date].cost
    const revenue   = revByDate[date]
    const rev_per_hour  = hours > 0 ? Math.round(revenue / hours) : null
    const staff_pct     = revenue > 0 ? Math.round((cost / revenue) * 1000) / 10 : null
    return { date, revenue: Math.round(revenue), hours: Math.round(hours * 10) / 10, cost: Math.round(cost), rev_per_hour, staff_pct }
  }).sort((a, b) => a.date.localeCompare(b.date))

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
  })
}
