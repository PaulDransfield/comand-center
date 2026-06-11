// app/api/forecast/by-period/route.ts
//
// GET /api/forecast/by-period?business_id=…&from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Per-day PREDICTED revenue across an arbitrary date range — the data the
// dashboard chart tooltip needs so you can hover any day (including past
// months) and see what the AI forecast for it. Reads daily_forecast_outcomes
// (surface=consolidated_daily) regardless of resolution status, so it covers
// future days in the current period (pending) AND historical days (resolved).
//
// One prediction per date (closest-horizon kept). Returns a date->predicted
// map.

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

  const u = new URL(req.url)
  const businessId = u.searchParams.get('business_id')
  const from = u.searchParams.get('from')
  const to   = u.searchParams.get('to')
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!from || !to) return NextResponse.json({ error: 'from and to required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  // Defensive: filter the upper bound in JS rather than chaining .lte() on a
  // date column (CLAUDE.md §10b footgun — keep belt-and-braces).
  const { data, error } = await db
    .from('daily_forecast_outcomes')
    .select('forecast_date, predicted_revenue, prediction_horizon_days')
    .eq('business_id', businessId)
    .eq('surface', 'consolidated_daily')
    .not('predicted_revenue', 'is', null)
    .gte('forecast_date', from)
    .order('forecast_date', { ascending: true })
    .limit(2000)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const inRange = (data ?? []).filter((r: any) => r.forecast_date <= to)

  // One prediction per date — keep the closest-in (smallest horizon) one.
  const byDate = new Map<string, any>()
  for (const r of inRange) {
    const cur = byDate.get(r.forecast_date)
    if (!cur || Number(r.prediction_horizon_days ?? 999) < Number(cur.prediction_horizon_days ?? 999)) {
      byDate.set(r.forecast_date, r)
    }
  }

  const days: Record<string, number> = {}
  for (const [date, r] of byDate) {
    const p = Math.round(Number(r.predicted_revenue) || 0)
    if (p > 0) days[date] = p
  }

  return NextResponse.json(
    { business_id: businessId, from, to, days },
    { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } },
  )
}
