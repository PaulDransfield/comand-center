// app/api/weather/demand-forecast/route.ts
//
// Owner-facing demand forecast for the next 7 days. Combines live SMHI/Open-
// Meteo forecast with this business's historical weather × revenue correlation
// to produce per-day predictions: weather summary + predicted revenue + delta
// vs typical + confidence + optional one-line recommendation.
//
// GET /api/weather/demand-forecast?business_id=<uuid>[&days=7]
//
// Response: see DemandForecast in lib/weather/demand.ts.
//
// Used by the dashboard widget and the Monday Memo agent (which calls into
// computeDemandForecast() directly rather than via HTTP).

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { computeDemandForecast } from '@/lib/weather/demand'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const businessId = req.nextUrl.searchParams.get('business_id')
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const daysRaw = parseInt(req.nextUrl.searchParams.get('days') ?? '7', 10)
  const days    = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 14) : 7

  const db = createAdminClient()

  try {
    const forecast = await computeDemandForecast({
      db,
      orgId:      auth.orgId,
      businessId,
      days,
    })

    if (!forecast) {
      return NextResponse.json({ error: 'Business not found in your org' }, { status: 404 })
    }

    return NextResponse.json(forecast, {
      headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
    })
  } catch (e: any) {
    return NextResponse.json({
      error:    'demand_forecast_failed',
      message:  e?.message ?? 'unknown error',
    }, { status: 500 })
  }
}
