// app/api/cron/weather-sync/route.ts
//
// Daily weather sync. Pulls a 16-day forecast from Open-Meteo for every
// active business and upserts it into weather_daily. Also re-pulls the
// last 5 days of observed weather so any rows previously flagged
// is_forecast=true get flipped to is_forecast=false as the day passes.
//
// Without this cron, weather_daily fills via the admin backfill only
// (manual). The model's weather_lift_pct then defaults to 1.0 (neutral)
// for every forecast beyond ~tomorrow — the strongest deterministic
// signal silently disabled.
//
// Runs daily at 03:30 UTC (after master-sync but before forecast
// callers wake up).
//
// Safe to re-run. Upserts on (business_id, date).

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { checkCronSecret } from '@/lib/admin/check-secret'
import { getForecast, getHistoricalWeather, coordsFor } from '@/lib/weather/forecast'

export const runtime         = 'nodejs'
export const dynamic         = 'force-dynamic'
export const preferredRegion = 'fra1'
export const maxDuration     = 120

export async function GET(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { withCronLog } = await import('@/lib/cron/log')
  return withCronLog('weather-sync', async (meta) => {
    const db = createAdminClient()

    const { data: businesses, error: bizErr } = await db
      .from('businesses')
      .select('id, name, city')
      .eq('is_active', true)

    if (bizErr) throw new Error(`businesses fetch: ${bizErr.message}`)

    const today = new Date().toISOString().slice(0, 10)
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
    // Open-Meteo archive lags ~48h, so re-pulling the last 3 days as
    // observed gives values for what was previously flagged is_forecast=true.
    const observedEnd = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)

    let totalForecastRows = 0
    let totalObservedRows = 0
    let errors = 0
    const perBusiness: any[] = []

    for (const biz of businesses ?? []) {
      try {
        const { lat, lon } = coordsFor(biz.city)

        // 1. Forecast (today → today + 16d)
        const fcast = await getForecast(lat, lon)
        let forecastRows = 0
        if (fcast.length) {
          const rows = fcast
            .filter(w => w.date >= today)
            .map(w => ({
              business_id: biz.id, date: w.date,
              temp_min: w.temp_min, temp_max: w.temp_max, temp_avg: w.temp_avg,
              precip_mm: w.precip_mm, wind_max: w.wind_max,
              weather_code: w.weather_code, summary: w.summary,
              source: 'open-meteo', is_forecast: true,
            }))
          if (rows.length > 0) {
            const { error: e } = await db.from('weather_daily').upsert(rows, { onConflict: 'business_id,date' })
            if (e) throw new Error(`forecast upsert: ${e.message}`)
            forecastRows = rows.length
            totalForecastRows += rows.length
          }
        }

        // 2. Observed: re-pull last 5 days so forecast→observed transition
        // happens without manual backfill. The archive endpoint covers up
        // to ~2 days ago; older lookbacks are no-ops if already observed.
        let observedRows = 0
        if (fiveDaysAgo <= observedEnd) {
          try {
            const hist = await getHistoricalWeather(lat, lon, fiveDaysAgo, observedEnd)
            if (hist.length) {
              const rows = hist.map(w => ({
                business_id: biz.id, date: w.date,
                temp_min: w.temp_min, temp_max: w.temp_max, temp_avg: w.temp_avg,
                precip_mm: w.precip_mm, wind_max: w.wind_max,
                weather_code: w.weather_code, summary: w.summary,
                source: 'open-meteo', is_forecast: false,
              }))
              const { error: e } = await db.from('weather_daily').upsert(rows, { onConflict: 'business_id,date' })
              if (e) throw new Error(`observed upsert: ${e.message}`)
              observedRows = rows.length
              totalObservedRows += rows.length
            }
          } catch {
            // Archive API failures shouldn't block the forecast write;
            // a future tick will retry.
          }
        }

        perBusiness.push({ business: biz.name, forecast: forecastRows, observed: observedRows })
      } catch (e: any) {
        errors++
        perBusiness.push({ business: biz.name, error: String(e?.message ?? e) })
      }
    }

    meta.businesses_processed = businesses?.length ?? 0
    meta.forecast_rows = totalForecastRows
    meta.observed_rows = totalObservedRows
    meta.errors = errors
    meta.per_business = perBusiness

    return NextResponse.json({
      ok: errors === 0,
      businesses_processed: businesses?.length ?? 0,
      forecast_rows: totalForecastRows,
      observed_rows: totalObservedRows,
      errors,
      per_business: perBusiness,
    })
  })
}
