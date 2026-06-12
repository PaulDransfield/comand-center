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

  // ── Closed-month principle: the official Fortnox P&L wins ─────────
  // A calendar month that is CLOSED in Fortnox (a NON-provisional tracker_data
  // P&L exists) has been officially reported with corrected numbers. Those
  // figures are authoritative and SUPERSEDE the real-time daily POS sum (which
  // can be provisional / pre-correction) for the headline totals — for every
  // business, not just POS-less ones. The current/open month (no closed P&L
  // yet) keeps the live daily figures. Caspeco-only businesses get their
  // dashboard populated from this for every closed month.
  // rows stay as the daily POS shape; summary.source flags the origin.
  ;(summary as any).source = 'daily'
  if (/^\d{4}-\d{2}-01$/.test(from)) {
    const y  = Number(from.slice(0, 4))
    const mo = Number(from.slice(5, 7))
    const { data: td } = await db
      .from('tracker_data')
      .select('revenue, staff_cost')
      .eq('business_id', businessId)
      .eq('period_year', y)
      .eq('period_month', mo)
      .or('is_provisional.is.null,is_provisional.eq.false')   // closed/official only
      .maybeSingle()
    if (td && (Number(td.revenue) > 0 || Number(td.staff_cost) > 0)) {
      summary.total_revenue    = Number(td.revenue)    || 0
      summary.total_staff_cost = Number(td.staff_cost) || 0
      summary.avg_labour_pct   = summary.total_revenue > 0
        ? Math.round((summary.total_staff_cost / summary.total_revenue) * 1000) / 10
        : null
      // covers stay from POS — the Fortnox P&L doesn't carry a cover count.
      ;(summary as any).source = 'fortnox_closed'
    }
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
