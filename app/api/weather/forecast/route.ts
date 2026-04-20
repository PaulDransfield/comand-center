// @ts-nocheck
// app/api/weather/forecast/route.ts
// Thin wrapper exposing the Open-Meteo forecast for the selected business.
// Separate from /api/weather/correlation so the dashboard widget can render
// without hitting daily_metrics.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { getForecast, coordsFor } from '@/lib/weather/forecast'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const bizId = req.nextUrl.searchParams.get('business_id')
  if (!bizId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('id, org_id, city').eq('id', bizId).maybeSingle()
  if (!biz || biz.org_id !== auth.orgId) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  try {
    const { lat, lon } = coordsFor(biz.city)
    const forecast = await getForecast(lat, lon)
    const todayIso = new Date().toISOString().slice(0, 10)
    return NextResponse.json({
      city:     biz.city ?? 'Stockholm (default)',
      forecast: forecast.filter(d => d.date >= todayIso).slice(0, 7),
    }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
  } catch (e: any) {
    return NextResponse.json({ error: e.message, forecast: [] }, { status: 502 })
  }
}
