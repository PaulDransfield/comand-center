// app/api/forecast/recent/route.ts
//
// GET /api/forecast/recent?business_id=…&days=14
//
// Recent PREDICTED-vs-ACTUAL revenue, day by day — the data behind the
// dashboard "Forecast check" tile. Reads resolved rows from
// daily_forecast_outcomes (surface=consolidated_daily, the headline daily
// revenue forecast), one row per date (closest-horizon prediction kept),
// and returns the day-level comparison plus a window accuracy summary.
//
// The reconciler (cron/daily-forecast-reconciler, 10:00 UTC) fills in
// actual_revenue the morning after, so "yesterday" is available by mid-
// morning each day.

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
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const daysRaw = Number(u.searchParams.get('days') ?? 14)
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(60, Math.round(daysRaw))) : 14

  const db = createAdminClient()
  const { data, error } = await db
    .from('daily_forecast_outcomes')
    .select('forecast_date, predicted_revenue, actual_revenue, prediction_horizon_days')
    .eq('business_id', businessId)
    .eq('surface', 'consolidated_daily')
    .eq('resolution_status', 'resolved')
    .not('actual_revenue', 'is', null)
    .order('forecast_date', { ascending: false })
    .limit(days * 4)   // headroom for multiple horizons per date
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // One row per date — keep the closest-in (smallest horizon) prediction,
  // i.e. our best estimate of what that day would do.
  const byDate = new Map<string, any>()
  for (const r of data ?? []) {
    const cur = byDate.get(r.forecast_date)
    if (!cur || Number(r.prediction_horizon_days ?? 999) < Number(cur.prediction_horizon_days ?? 999)) {
      byDate.set(r.forecast_date, r)
    }
  }

  const rows = Array.from(byDate.values())
    .sort((a, b) => String(b.forecast_date).localeCompare(String(a.forecast_date)))
    .slice(0, days)
    .map(r => {
      const predicted = Math.round(Number(r.predicted_revenue) || 0)
      const actual    = Math.round(Number(r.actual_revenue) || 0)
      const errPct    = actual > 0 ? ((predicted - actual) / actual) * 100 : null
      return {
        date:         r.forecast_date,
        predicted,
        actual,
        error_pct:    errPct == null ? null : Math.round(errPct * 10) / 10,         // signed: + over, - under
        accuracy_pct: errPct == null ? null : Math.max(0, Math.round((100 - Math.abs(errPct)) * 10) / 10),
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date))   // ascending for display

  const scored = rows.filter(r => r.accuracy_pct != null)
  const windowAccuracy = scored.length
    ? Math.round((scored.reduce((s, r) => s + (r.accuracy_pct as number), 0) / scored.length) * 10) / 10
    : null

  return NextResponse.json({
    business_id:         businessId,
    rows,
    latest:              rows.length ? rows[rows.length - 1] : null,
    window_accuracy_pct: windowAccuracy,
    n:                   rows.length,
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}
