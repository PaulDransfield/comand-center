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
//   /api/admin/weather/backfill?secret=...&business_id=...&start_date=YYYY-MM-DD
//
// Parameters:
//   secret      — required, must match ADMIN_SECRET
//   business_id — optional, scopes the backfill to one business
//   start_date  — optional override for the lower bound. When omitted, we
//                 use each business's earliest daily_metrics date (the
//                 historical default — no point fetching weather pre-trading).
//                 With start_date set, we extend BEFORE earliest sales — used
//                 by Piece 0 of the prediction-system architecture which needs
//                 ≥3 years of weather history to compute weather_change_vs_seasonal
//                 lift factors that pre-date Vero's first sales day.
//                 Format: YYYY-MM-DD. Invalid values fall back to the default.
// See PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md Appendix Z (Stream A).

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
  // Parse the optional start_date override. Validate strict YYYY-MM-DD shape;
  // anything else silently falls back to the default-from-firstRev so a typo
  // in the URL doesn't accidentally fetch 50 years of weather.
  const startDateRaw = req.nextUrl.searchParams.get('start_date')
  const startDateOverride = startDateRaw && /^\d{4}-\d{2}-\d{2}$/.test(startDateRaw) ? startDateRaw : null
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

      // start_date override extends BEFORE earliest sales (e.g. 2023-05-01
      // for the prediction system's seasonal-lift lookups that need ~3 years
      // of weather history regardless of when the business started trading).
      // Skip-on-no-metrics is preserved for the no-override case so businesses
      // that never traded don't have weather backfilled pointlessly.
      const baseStartDate = startDateOverride
        ?? firstRev?.date
        ?? null
      if (!baseStartDate) {
        results.push({ business: biz.name, skipped: 'no daily_metrics and no start_date override' })
        continue
      }

      const { lat, lon } = coordsFor(biz.city)

      // Historical: baseStartDate → 2 days ago (archive API lags by 48h-ish)
      const archiveEnd = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10)
      let archiveRows = 0
      if (baseStartDate <= archiveEnd) {
        const hist = await getHistoricalWeather(lat, lon, baseStartDate, archiveEnd)
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
        from: baseStartDate, to: archiveEnd,
        archive_rows: archiveRows, forecast_rows: forecastRows,
        start_date_override: startDateOverride,
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
