// app/api/admin/v2/forecasting/route.ts
//
// Phase 0 measurement endpoint for the prediction-improvement plan.
// Surfaces three things in one round-trip:
//
//   1. MAPE-by-horizon-bucket (all-time)   → "how accurate is each surface?"
//   2. MAPE rolling 28-day                 → "is it getting better recently?"
//   3. Confidence calibration              → "do high-confidence days actually run lower MAPE?"
//
// All three are SELECTs against M070 views, joined with the businesses
// table for human-readable names. Service-role read so we bypass RLS;
// admin guard at the route level.
//
// Lightweight 60s in-process cache. The underlying ledger only updates
// once a day (10:00 UTC reconciler run); a tighter TTL is pointless.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

let cached: { at: number; payload: any } | null = null
const TTL_MS = 60_000

interface MapeRow {
  business_id:          string
  surface:              string
  horizon_bucket_days:  number
  resolved_rows:        number
  mape_pct:             number
  bias_pct:             number
  error_stddev_pct?:    number
  earliest_forecast:    string
  latest_forecast:      string
}

interface ConfidenceRow {
  business_id:        string
  surface:            string
  confidence:         'high' | 'medium' | 'low'
  resolved_rows:      number
  mape_pct:           number
  bias_pct:           number
  earliest_forecast:  string
  latest_forecast:    string
}

interface BusinessLite {
  id:   string
  name: string
  org_id: string
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req)
  if ('ok' in guard === false) return guard as NextResponse

  if (cached && Date.now() - cached.at < TTL_MS) {
    return NextResponse.json({ ...cached.payload, cached: true, age_ms: Date.now() - cached.at }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  const db = createAdminClient()

  // All three view reads + the business-name lookup, in parallel.
  const [allTimeRes, rolling28Res, confidenceRes] = await Promise.all([
    db.from('v_forecast_mape_by_horizon_bucket').select('*'),
    db.from('v_forecast_mape_rolling_28d').select('*'),
    db.from('v_forecast_confidence_calibration').select('*'),
  ])

  // Pull the businesses we have data for, batch-resolved to names.
  const businessIds = new Set<string>()
  for (const row of [...(allTimeRes.data ?? []), ...(rolling28Res.data ?? []), ...(confidenceRes.data ?? [])]) {
    if (row?.business_id) businessIds.add(row.business_id)
  }

  let businessMap: Record<string, BusinessLite> = {}
  if (businessIds.size > 0) {
    const { data: bizRows } = await db
      .from('businesses')
      .select('id, name, org_id')
      .in('id', Array.from(businessIds))
    for (const b of bizRows ?? []) {
      businessMap[b.id] = b as BusinessLite
    }
  }

  const errors: string[] = []
  if (allTimeRes.error)    errors.push(`mape_by_horizon: ${allTimeRes.error.message}`)
  if (rolling28Res.error)  errors.push(`rolling_28d: ${rolling28Res.error.message}`)
  if (confidenceRes.error) errors.push(`confidence_calibration: ${confidenceRes.error.message}`)

  const payload = {
    all_time:    (allTimeRes.data    ?? []) as MapeRow[],
    rolling_28d: (rolling28Res.data  ?? []) as MapeRow[],
    confidence:  (confidenceRes.data ?? []) as ConfidenceRow[],
    businesses:  businessMap,
    errors,
    generated_at: new Date().toISOString(),
  }

  cached = { at: Date.now(), payload }

  return NextResponse.json({ ...payload, cached: false }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
