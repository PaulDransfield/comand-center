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

  // ── Fortnox overhead enrichment ────────────────────────────────────────
  // Pull other_cost from tracker_data (the aggregator doesn't surface it yet)
  // and the top-3 line-item subcategories per month so the AI context
  // builder can answer questions like "what's driving margin down in June?"
  const { data: tdRows } = await db
    .from('tracker_data')
    .select('period_month, other_cost, fortnox_upload_id, source')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .eq('period_year', year)

  const { data: liRows } = await db
    .from('tracker_line_items')
    .select('period_month, category, subcategory, amount, label_sv')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .eq('period_year', year)

  const otherByMonth       = new Map<number, number>()
  const sourceByMonth      = new Map<number, string>()
  const hasFortnoxByMonth  = new Map<number, boolean>()
  for (const r of (tdRows ?? [])) {
    otherByMonth.set(r.period_month,     Number(r.other_cost ?? 0))
    sourceByMonth.set(r.period_month,    r.source ?? 'manual')
    hasFortnoxByMonth.set(r.period_month, r.source === 'fortnox_pdf' || r.source === 'fortnox_api')
  }

  const otherTop3ByMonth = new Map<number, Array<{ label: string; sub: string | null; kr: number }>>()
  const byMonthOther: Record<number, Record<string, { kr: number; label: string }>> = {}
  for (const l of (liRows ?? [])) {
    if (l.category !== 'other_cost') continue
    const m = l.period_month
    if (!byMonthOther[m]) byMonthOther[m] = {}
    const key = (l.subcategory ?? l.label_sv ?? 'other')
    if (!byMonthOther[m][key]) byMonthOther[m][key] = { kr: 0, label: l.label_sv ?? key }
    byMonthOther[m][key].kr += Number(l.amount ?? 0)
  }
  for (const [m, buckets] of Object.entries(byMonthOther)) {
    const sorted = Object.entries(buckets)
      .map(([sub, v]) => ({ sub: sub === 'other' ? null : sub, label: v.label, kr: Math.round(v.kr) }))
      .sort((a, b) => b.kr - a.kr)
      .slice(0, 3)
    otherTop3ByMonth.set(Number(m), sorted)
  }

  // Attach to each month row
  const enriched = (rows ?? []).map(r => {
    const other = otherByMonth.get(r.month) ?? 0
    return {
      ...r,
      other_cost:        other,
      source:            sourceByMonth.get(r.month) ?? 'manual',
      has_fortnox_pdf:   hasFortnoxByMonth.get(r.month) ?? false,
      other_cost_top3:   otherTop3ByMonth.get(r.month) ?? [],
    }
  })

  // YTD summary
  const totalRev       = enriched.reduce((s, r) => s + r.revenue, 0)
  const totalCost      = enriched.reduce((s, r) => s + r.total_cost, 0)
  const totalProfit    = enriched.reduce((s, r) => s + r.net_profit, 0)
  const totalHours     = enriched.reduce((s, r) => s + Number(r.hours_worked), 0)
  const totalOtherCost = enriched.reduce((s, r) => s + Number(r.other_cost ?? 0), 0)

  const summary = {
    ytd_revenue:    totalRev,
    ytd_staff_cost: enriched.reduce((s, r) => s + r.staff_cost, 0),
    ytd_food_cost:  enriched.reduce((s, r) => s + r.food_cost, 0),
    ytd_other_cost: totalOtherCost,
    ytd_total_cost: totalCost,
    ytd_net_profit: totalProfit,
    ytd_margin_pct: totalRev > 0 ? Math.round((totalProfit / totalRev) * 1000) / 10 : 0,
    ytd_labour_pct: totalRev > 0 ? Math.round((enriched.reduce((s, r) => s + r.staff_cost, 0) / totalRev) * 1000) / 10 : null,
    ytd_hours:      Math.round(totalHours * 10) / 10,
    months_with_data: enriched.length,
    months_with_fortnox_pdf: enriched.filter(r => r.has_fortnox_pdf).length,
  }

  return NextResponse.json({ rows: enriched, summary, year }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}
