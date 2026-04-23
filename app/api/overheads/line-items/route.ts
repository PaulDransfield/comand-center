// app/api/overheads/line-items/route.ts
//
// Returns tracker_line_items for a business, filtered by year / month /
// category.  Used by:
//   - the /overheads presentation (subcategory stacked bar + full table)
//   - the /api/ask AI assistant when the question mentions costs
//   - the cost-intel agent when it builds its context window
//
// Rows are ordered by period then by amount desc so consumers can render
// them without re-sorting.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const u          = new URL(req.url)
  const businessId = u.searchParams.get('business_id')
  const yearFrom   = Number(u.searchParams.get('year_from') ?? (new Date().getFullYear() - 1))
  const yearTo     = Number(u.searchParams.get('year_to')   ?? new Date().getFullYear())
  const category   = u.searchParams.get('category')
  const month      = u.searchParams.get('month')

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()
  let q = db
    .from('tracker_line_items')
    .select('id, period_year, period_month, category, subcategory, label_sv, label_en, amount, fortnox_account, source_upload_id, created_at')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .gte('period_year', yearFrom)
    .lte('period_year', yearTo)
    .order('period_year', { ascending: false })
    .order('period_month', { ascending: false })
    .order('amount', { ascending: false })
    .limit(2000)

  if (category) q = q.eq('category', category)
  if (month)    q = q.eq('period_month', Number(month))

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const rawRows = data ?? []

  // Defensive filter: when the caller asked for 'other_cost' line items,
  // exclude anything on a Swedish BAS 4000-series account (food cost),
  // even if the `category` column was populated as 'other_cost' by an
  // older mis-classification. Also exclude 3000-series (revenue) and
  // 7000-series (staff cost) for the same reason. See FIXES.md §0k.
  const rows = category === 'other_cost'
    ? rawRows.filter((r: any) => {
        const acct = Number(r.fortnox_account ?? 0)
        if (!acct) return true                       // no account info — trust category column
        return !(acct >= 3000 && acct <= 4999) && !(acct >= 7000 && acct <= 7999)
      })
    : rawRows

  // ── Subcategory rollup for bar charts ────────────────────────────────
  const bySub: Record<string, { label: string; subcategory: string | null; total: number; months: Set<number> }> = {}
  for (const r of rows) {
    if (r.category !== 'other_cost') continue
    const key = r.subcategory ?? r.label_sv ?? 'other'
    if (!bySub[key]) bySub[key] = { label: r.label_sv ?? key, subcategory: r.subcategory, total: 0, months: new Set() }
    bySub[key].total += Number(r.amount ?? 0)
    bySub[key].months.add(Number(r.period_month ?? 0))
  }
  const subcategories = Object.entries(bySub)
    .map(([key, v]) => ({
      key,
      subcategory: v.subcategory,
      label: v.label,
      total_kr: Math.round(v.total),
      months_seen: v.months.size,
    }))
    .sort((a, b) => b.total_kr - a.total_kr)

  return NextResponse.json({
    rows,
    subcategories,
    count: rows.length,
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}
