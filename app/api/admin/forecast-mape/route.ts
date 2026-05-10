// app/api/admin/forecast-mape/route.ts
//
// Admin diagnostic — returns MAPE-by-horizon comparison across all three
// forecaster surfaces (consolidated_daily / scheduling_ai_revenue /
// weather_demand). Powers the Phase A acceptance gate for Piece 2.
//
// GET ?business_id=<uuid>
//
// Returns: array of { business_id, surface, horizon, mape_pct, bias_pct,
//                     resolved_rows, earliest_forecast, latest_forecast }
//
// The view (M065 v_forecast_mape_by_surface) is the single source of
// truth; this endpoint just adds auth + business-scope filtering.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(req: NextRequest) {
  noStore()

  const u = new URL(req.url)
  const businessId = u.searchParams.get('business_id')?.trim() ?? null

  // Admin gate. business_id is optional — admin can request all
  // businesses' MAPE in one call (handy for cross-customer comparison
  // once we have several customers).
  const guard = await requireAdmin(req)
  if (!('ok' in guard)) return guard

  const db = createAdminClient()

  let q = db
    .from('v_forecast_mape_by_surface')
    .select('business_id, surface, prediction_horizon_days, resolved_rows, mape_pct, error_stddev_pct, bias_pct, earliest_forecast, latest_forecast')
    .order('business_id', { ascending: true })
    .order('surface',     { ascending: true })
    .order('prediction_horizon_days', { ascending: true })

  if (businessId) q = q.eq('business_id', businessId)

  const { data, error } = await q
  if (error) {
    return NextResponse.json({
      error:   `MAPE view query failed: ${error.message}`,
      hint:    error.message.includes('does not exist') ? 'Apply M065 in Supabase SQL Editor.' : null,
    }, { status: 500 })
  }

  return NextResponse.json({
    rows:        data ?? [],
    count:       (data ?? []).length,
    fetched_at:  new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
