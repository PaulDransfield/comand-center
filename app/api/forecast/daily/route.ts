// app/api/forecast/daily/route.ts
//
// Public endpoint for the consolidated daily forecaster (Piece 2). Thin
// wrapper around `dailyForecast()`:
//   - Authenticates the caller
//   - Verifies the business is in their org
//   - Per-business flag gate (PREDICTION_V2_FORECAST_API)
//   - Calls the function
//   - Returns the full DailyForecast JSON
//
// Capture into daily_forecast_outcomes happens INSIDE dailyForecast() via
// Piece 1's helper. The endpoint is just an auth + flag gate.
//
// Body: { business_id, date }   (date as YYYY-MM-DD)

import { NextRequest, NextResponse }    from 'next/server'
import { unstable_noStore as noStore }  from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { dailyForecast }                from '@/lib/forecast/daily'
import { isPredictionV2FlagEnabled }    from '@/lib/featureFlags/prediction-v2'

export const runtime         = 'nodejs'
export const preferredRegion = 'fra1'
export const dynamic         = 'force-dynamic'
export const maxDuration     = 30

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({} as any))
  const businessId = String(body?.business_id ?? '').trim()
  const dateStr    = String(body?.date ?? '').trim()

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!ISO_DATE_RE.test(dateStr)) return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 })

  const db = createAdminClient()

  // Verify the business is in the caller's org
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id')
    .eq('id', businessId)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'Business not found in your org' }, { status: 404 })

  // Per-business flag gate. The function is callable from anywhere
  // (other server-side code, future Pieces, scripts) — but the public
  // endpoint is gated for safe rollout. Cutover plan in architecture §11.
  const flagOn = await isPredictionV2FlagEnabled(businessId, 'PREDICTION_V2_FORECAST_API', db)
  if (!flagOn) {
    return NextResponse.json({
      error:   'flag_disabled',
      message: 'PREDICTION_V2_FORECAST_API is not enabled for this business yet (Phase A capture-only mode).',
    }, { status: 403 })
  }

  try {
    const date = new Date(dateStr + 'T12:00:00Z')
    const forecast = await dailyForecast(businessId, date, { db })
    return NextResponse.json(forecast, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err: any) {
    return NextResponse.json({
      error:  'forecast_failed',
      detail: err?.message ?? String(err),
    }, { status: 500 })
  }
}
