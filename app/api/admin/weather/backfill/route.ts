// @ts-nocheck
// app/api/admin/weather/backfill/route.ts
//
// One-time backfill: for every business, fetch historical weather from
// Open-Meteo's archive API for every date we have daily_metrics, and write
// to weather_daily. Safe to re-run — upserts on (business_id, date).
//
// Also populates the next 10 days of forecast. Those rows are marked
// is_forecast=true and will be overwritten by the daily sync once the day
// passes (forecast → observed).
//
// Protected by ADMIN_SECRET. POST:
//   /api/admin/weather/backfill?secret=...&business_id=...  (optional, scopes to one)

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getForecast, getHistoricalWeather, coordsFor } from '@/lib/weather/forecast'

export const dynamic     = 'force-dynamic'
export const maxDuration = 120

export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret') ?? req.headers.get('x-admin-secret')
  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  }

  const onlyBizId = req.nextUrl.searchParams.get('business_id')
  const db = createAdminClient()

  let businessesQuery = db.from('businesses').select('id, name, city, org_id').eq('is_active', true)
  if (onlyBizId) businessesQuery = businessesQuery.eq('id', onlyBizId)
  const { data: businesses } = await businessesQuery
  if (!businesses?.length) return NextResponse.json({ ok: true, message: 'No businesses' })

  const today = new Date().toISOString().slice(0, 10)
  const results: any[] = []

  for (const biz of businesses) {
    try {
      // Earliest date we have sales data for — no point fetching weather pre-trading.
      const { data: firstRev } = await db
        .from('daily_metrics')
        .select('date')
        .eq('business_id', biz.id)
        .order('date', { ascending: true })
        .limit(1)
        .maybeSingle()

      if (!firstRev?.date) {
        results.push({ business: biz.name, skipped: 'no daily_metrics' })
        continue
      }

      const { lat, lon } = coordsFor(biz.city)

      // Historical: firstRev.date → 2 days ago (archive API lags by 48h-ish)
      const archiveEnd = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10)
      let archiveRows = 0
      if (firstRev.date <= archiveEnd) {
        const hist = await getHistoricalWeather(lat, lon, firstRev.date, archiveEnd)
        if (hist.length) {
          const rows = hist.map(w => ({
            business_id: biz.id, date: w.date,
            temp_min: w.temp_min, temp_max: w.temp_max, temp_avg: w.temp_avg,
            precip_mm: w.precip_mm, wind_max: w.wind_max,
            weather_code: w.weather_code, summary: w.summary,
            source: 'open-meteo', is_forecast: false,
          }))
          const { error } = await db.from('weather_daily').upsert(rows, { onConflict: 'business_id,date' })
          if (error) throw new Error(`archive upsert: ${error.message}`)
          archiveRows = rows.length
        }
      }

      // Forecast: today → today+10 (overwrites once day passes via daily sync)
      const fcast = await getForecast(lat, lon)
      let forecastRows = 0
      if (fcast.length) {
        const rows = fcast.filter(w => w.date >= today).map(w => ({
          business_id: biz.id, date: w.date,
          temp_min: w.temp_min, temp_max: w.temp_max, temp_avg: w.temp_avg,
          precip_mm: w.precip_mm, wind_max: w.wind_max,
          weather_code: w.weather_code, summary: w.summary,
          source: 'open-meteo', is_forecast: true,
        }))
        const { error } = await db.from('weather_daily').upsert(rows, { onConflict: 'business_id,date' })
        if (error) throw new Error(`forecast upsert: ${error.message}`)
        forecastRows = rows.length
      }

      results.push({
        business: biz.name, city: biz.city ?? 'Stockholm (default)',
        from: firstRev.date, to: archiveEnd,
        archive_rows: archiveRows, forecast_rows: forecastRows,
      })
    } catch (e: any) {
      results.push({ business: biz.name, error: e.message })
    }
  }

  return NextResponse.json({
    ok:      results.every(r => !r.error),
    results,
  })
}

export const GET = POST  // Vercel Cron fires GET
