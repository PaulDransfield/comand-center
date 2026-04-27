// @ts-nocheck
// /api/metrics/daily — read pre-computed daily metrics
// Returns daily rows for a date range. Used by dashboard, staff, revenue pages.
// Falls back to real-time aggregation if summary tables aren't populated yet.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { unstable_noStore as noStore } from 'next/cache'

export const dynamic  = 'force-dynamic'
export const revalidate = 0

export async function GET(req: NextRequest) {
  // Escape Next.js 14's internal fetch cache — Supabase calls inside this
  // handler would otherwise be served from cache even on a dynamic route.
  noStore()

  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const businessId = searchParams.get('business_id')
  const from       = searchParams.get('from')
  const to         = searchParams.get('to')

  if (!businessId || !from || !to) {
    return NextResponse.json({ error: 'business_id, from, to required' }, { status: 400 })
  }

  const db = createAdminClient()

  // Same .gte().lte() Supabase/PostgREST bug as in lib/sync/aggregate.ts — the
  // chained upper bound silently drops rows at the top of the range. Fetch with
  // .gte() only, then filter in memory so the response still honours the `to`
  // parameter.
  const { data: allRows, error } = await db
    .from('daily_metrics')
    .select('*')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .gte('date', from)
    .order('date', { ascending: true })

  const rows = (allRows ?? []).filter((r: any) => r.date <= to)

  if (error) {
    // Table might not exist yet — return empty so pages still work
    console.warn('daily_metrics query failed:', error.message)
    return NextResponse.json({ rows: [], summary: null, _fallback: true })
  }

  // Build summary from the rows
  const totalRev    = rows.reduce((s, r) => s + r.revenue, 0)
  const totalCost   = rows.reduce((s, r) => s + r.staff_cost, 0)
  const totalCovers = rows.reduce((s, r) => s + r.covers, 0)
  const totalTips   = rows.reduce((s, r) => s + r.tips, 0)
  const totalHours  = rows.reduce((s, r) => s + Number(r.hours_worked), 0)
  const totalShifts = rows.reduce((s, r) => s + r.shifts, 0)
  const totalLate   = rows.reduce((s, r) => s + r.late_shifts, 0)
  const totalOb     = rows.reduce((s, r) => s + r.ob_supplement, 0)

  const daysWithBoth = rows.filter(r => r.revenue > 0 && r.staff_cost > 0)
  const avgLabourPct = daysWithBoth.length > 0
    ? Math.round(daysWithBoth.reduce((s, r) => s + (r.labour_pct ?? 0), 0) / daysWithBoth.length * 10) / 10
    : null

  const bestDay  = daysWithBoth.reduce((b, r) => (!b || (r.labour_pct ?? 100) < (b.labour_pct ?? 100)) ? r : b, null)
  const worstDay = daysWithBoth.reduce((w, r) => (!w || (r.labour_pct ?? 0) > (w.labour_pct ?? 0)) ? r : w, null)

  const summary = {
    total_revenue:     totalRev,
    total_staff_cost:  totalCost,
    total_covers:      totalCovers,
    total_tips:        totalTips,
    total_hours:       Math.round(totalHours * 10) / 10,
    total_shifts:      totalShifts,
    total_late_shifts: totalLate,
    total_ob:          totalOb,
    avg_labour_pct:    avgLabourPct,
    rev_per_hour:      totalHours > 0 ? Math.round(totalRev / totalHours) : 0,
    days_with_data:    rows.filter(r => r.revenue > 0 || r.staff_cost > 0).length,
    best_day:  bestDay  ? { date: bestDay.date, pct: bestDay.labour_pct, staff_cost: bestDay.staff_cost, revenue: bestDay.revenue } : null,
    worst_day: worstDay ? { date: worstDay.date, pct: worstDay.labour_pct, staff_cost: worstDay.staff_cost, revenue: worstDay.revenue } : null,
  }

  // FIXES §0bb (Sprint 1.5): swapped no-store for bounded SWR. private =
  // browser cache only (per-user data, never CDN); 15s max-age makes
  // back-button + tab-switch instant; SWR=60s serves cached while
  // background-revalidating. Worst-case staleness window is 15s, which
  // is shorter than any aggregator-run cycle. If a "stale after sync"
  // bug recurs, fix from the writer side (cache-busting query param) —
  // do NOT revert to no-store globally.
  return NextResponse.json({ rows, summary }, {
    headers: { 'Cache-Control': 'private, max-age=15, stale-while-revalidate=60' },
  })
}
