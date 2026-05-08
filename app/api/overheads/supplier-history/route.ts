// app/api/overheads/supplier-history/route.ts
//
// 12-month price history for one supplier × category. Powers the
// SupplierPriceChart in the redesigned overhead-review page.
//
// Inputs (query params):
//   business_id              required
//   supplier_name_normalised required — already-normalised lookup key
//   category                 required — 'other_cost' | 'food_cost'
//   months                   optional — default 12
//
// Output: { history: [{ year, month, amount }], months }
// Rows are sorted ascending (oldest first) so the chart renders left → right.
//
// Implementation: pulls every tracker_line_items row in the rolling window
// for the business+category, normalises the display label client-side
// (matching the same algorithm the worker uses), and sums per (year, month)
// for rows whose normalised name matches. Postgres has no equivalent of
// our JS normaliser, so we do the match in Node — same approach as
// review-worker.ts and backfill.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { requireFinanceAccess, requireBusinessAccess } from '@/lib/auth/require-role'
import { normaliseSupplier, pickDisplayLabel } from '@/lib/overheads/normalise'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const u            = new URL(req.url)
  const businessId   = u.searchParams.get('business_id')
  const targetKey    = u.searchParams.get('supplier_name_normalised')
  const category     = u.searchParams.get('category')
  const monthsParam  = Number(u.searchParams.get('months') ?? 12)
  const months       = Number.isFinite(monthsParam) && monthsParam > 0 && monthsParam <= 36
    ? Math.floor(monthsParam) : 12

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!targetKey)  return NextResponse.json({ error: 'supplier_name_normalised required' }, { status: 400 })
  if (category !== 'other_cost' && category !== 'food_cost') {
    return NextResponse.json({ error: 'category must be other_cost or food_cost' }, { status: 400 })
  }

  const finForbidden = requireFinanceAccess(auth); if (finForbidden) return finForbidden
  const bizForbidden = requireBusinessAccess(auth, businessId); if (bizForbidden) return bizForbidden

  // Rolling N-month window ending in current month.
  const now    = new Date()
  const endY   = now.getUTCFullYear()
  const endM   = now.getUTCMonth() + 1
  let   startY = endY
  let   startM = endM - months + 1
  while (startM < 1) { startM += 12; startY -= 1 }

  const db = createAdminClient()
  const { data: lines, error } = await db
    .from('tracker_line_items')
    .select('label_sv, label_en, amount, period_year, period_month, fortnox_account')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .eq('category', category)
    .gte('period_year', startY)
    .lte('period_year', endY)
    .limit(50_000)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Aggregate by (year, month) for rows whose normalised label matches.
  const buckets = new Map<string, { year: number; month: number; amount: number }>()
  for (const ln of (lines ?? []) as any[]) {
    // Window edges — same trim the backfill route uses.
    if (ln.period_year === startY && ln.period_month < startM) continue
    if (ln.period_year === endY   && ln.period_month > endM)   continue

    const key = normaliseSupplier(pickDisplayLabel(ln))
    if (key !== targetKey) continue

    const bk = `${ln.period_year}-${ln.period_month}`
    const cur = buckets.get(bk) ?? { year: ln.period_year, month: ln.period_month, amount: 0 }
    cur.amount += Number(ln.amount ?? 0)
    buckets.set(bk, cur)
  }

  // Emit one row for every month in the window — chart shouldn't gap on
  // months where the supplier had zero spend.
  const history: { year: number; month: number; amount: number }[] = []
  let y = startY, m = startM
  for (let i = 0; i < months; i++) {
    const bk = `${y}-${m}`
    history.push(buckets.get(bk) ?? { year: y, month: m, amount: 0 })
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }

  return NextResponse.json(
    { history, months },
    { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } },
  )
}
