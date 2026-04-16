// @ts-nocheck
// app/api/staff-revenue/route.ts
// GET daily staff cost % by joining staff_logs with revenue_logs by date
// Returns per-day rows + period summary for tracking vs target

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const getAuth = getRequestAuth

export async function GET(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const businessId  = searchParams.get('business_id')
  const from        = searchParams.get('from') ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10)
  const to          = searchParams.get('to')   ?? new Date().toISOString().slice(0, 10)
  const targetPct   = parseFloat(searchParams.get('target_pct') ?? '40')

  const db = createAdminClient()

  // Fetch staff costs grouped by date
  let staffQuery = db
    .from('staff_logs')
    .select('shift_date, cost_actual, estimated_salary')
    .eq('org_id', auth.orgId)
    .gte('shift_date', from)
    .lte('shift_date', to)
    .or('cost_actual.gt.0,estimated_salary.gt.0')

  if (businessId) staffQuery = staffQuery.eq('business_id', businessId)

  // Fetch revenue grouped by date
  let revQuery = db
    .from('revenue_logs')
    .select('revenue_date, revenue')
    .eq('org_id', auth.orgId)
    .gte('revenue_date', from)
    .lte('revenue_date', to)
    .gt('revenue', 0)

  if (businessId) revQuery = revQuery.eq('business_id', businessId)

  const [{ data: staffLogs, error: staffErr }, { data: revLogs, error: revErr }] = await Promise.all([
    staffQuery, revQuery,
  ])

  if (staffErr) return NextResponse.json({ error: staffErr.message }, { status: 500 })
  if (revErr)   return NextResponse.json({ error: revErr.message  }, { status: 500 })

  // Aggregate staff cost by date
  // Use cost_actual when available; fall back to estimated_salary for unapproved shifts
  const staffByDate: Record<string, number> = {}
  for (const log of staffLogs ?? []) {
    const d    = log.shift_date
    const cost = Number(log.cost_actual ?? 0) > 0 ? Number(log.cost_actual) : Number(log.estimated_salary ?? 0)
    staffByDate[d] = (staffByDate[d] ?? 0) + cost
  }

  // Aggregate revenue by date
  const revByDate: Record<string, number> = {}
  for (const row of revLogs ?? []) {
    const d = row.revenue_date
    revByDate[d] = (revByDate[d] ?? 0) + Number(row.revenue ?? 0)
  }

  // Build joined daily rows — only days where both staff cost AND revenue exist
  const allDates = new Set([...Object.keys(staffByDate), ...Object.keys(revByDate)])
  const rows = Array.from(allDates)
    .map(date => {
      const staff_cost = Math.round(staffByDate[date] ?? 0)
      const revenue    = Math.round(revByDate[date]   ?? 0)
      const staff_pct  = revenue > 0 && staff_cost > 0
        ? Math.round((staff_cost / revenue) * 1000) / 10  // one decimal place
        : null
      const vs_target  = staff_pct !== null ? Math.round((staff_pct - targetPct) * 10) / 10 : null
      return { date, staff_cost, revenue, staff_pct, vs_target, has_both: staff_cost > 0 && revenue > 0 }
    })
    .sort((a, b) => a.date.localeCompare(b.date))

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

  return NextResponse.json({ rows: joinedRows, summary })
}
