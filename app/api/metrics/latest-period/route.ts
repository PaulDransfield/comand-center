// /api/metrics/latest-period — the most recent month that actually has data
// for a business (a closed Fortnox P&L, or any daily POS revenue). The
// dashboard uses this to LAND on the latest populated month instead of an
// empty current month — important for Fortnox-only (Caspeco) businesses whose
// current month is always blank until it closes.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const businessId = new URL(req.url).searchParams.get('business_id')
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // Latest CLOSED Fortnox month (non-provisional P&L with real figures).
  const { data: td } = await db
    .from('tracker_data')
    .select('period_year, period_month')
    .eq('business_id', businessId)
    .or('is_provisional.is.null,is_provisional.eq.false')
    .or('revenue.gt.0,staff_cost.gt.0')
    .order('period_year', { ascending: false })
    .order('period_month', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Latest day with POS revenue.
  const { data: dm } = await db
    .from('daily_metrics')
    .select('date')
    .eq('business_id', businessId)
    .gt('revenue', 0)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle()

  const candidates: { year: number; month: number }[] = []
  if (td) candidates.push({ year: Number(td.period_year), month: Number(td.period_month) })
  if (dm?.date) candidates.push({ year: Number(String(dm.date).slice(0, 4)), month: Number(String(dm.date).slice(5, 7)) })

  if (candidates.length === 0) {
    return NextResponse.json({ latest: null }, { headers: { 'Cache-Control': 'no-store' } })
  }
  // Pick the most recent (year, then month).
  const latest = candidates.sort((a, b) => (b.year - a.year) || (b.month - a.month))[0]
  return NextResponse.json({ latest }, { headers: { 'Cache-Control': 'no-store' } })
}
