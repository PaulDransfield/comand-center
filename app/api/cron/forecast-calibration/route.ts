// @ts-nocheck
// app/api/cron/forecast-calibration/route.ts
// Runs 1st of each month at 04:00 UTC — calculates forecast accuracy and bias
// No Claude needed — pure arithmetic
// Follows spec in claude_code_agents_prompt.md

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { checkCronSecret }   from '@/lib/admin/check-secret'
import { log }               from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const preferredRegion = 'fra1'  // EU-only; Supabase is Frankfurt
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { withCronLog } = await import('@/lib/cron/log')
  return withCronLog('forecast-calibration', async () => {

  const started = Date.now()
  const db = createAdminClient()
  const today = new Date()
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  const year = lastMonth.getFullYear()
  const month = lastMonth.getMonth() + 1

  console.log(`[forecast-calibration] Running for ${year}-${month}`)

  try {
    // Get all active businesses with at least 3 months of data
    const { data: businesses } = await db
      .from('businesses')
      .select('id, name, org_id')
      .eq('is_active', true)

    if (!businesses?.length) {
      return NextResponse.json({ ok: true, calibrated: 0, message: 'No active businesses' })
    }

    let calibrated = 0
    const errors: string[] = []
    const { isAgentEnabled } = await import('@/lib/ai/is-agent-enabled')

    for (const biz of businesses) {
      try {
        // Respect per-customer agent toggle set in admin panel
        const enabled = await isAgentEnabled(db, biz.org_id, 'forecast_calibration')
        if (!enabled) {
          console.log(`[forecast-calibration] Skipping ${biz.name} — disabled via feature flag`)
          continue
        }

        // Check if business has at least 2 months of revenue data in monthly_metrics
        // (source of truth). Before 2026-04-17 this read tracker_data, which counted
        // empty manual-entry rows as "history" and calibrated off the wrong baseline.
        const { data: historyCount } = await db
          .from('monthly_metrics')
          .select('year, month')
          .eq('business_id', biz.id)
          .gt('revenue', 0)
          .or(`year.lt.${year},and(year.eq.${year},month.lt.${month})`)

        if (!historyCount || historyCount.length < 2) {
          console.log(`[forecast-calibration] Skipping ${biz.name} — insufficient history (${historyCount?.length ?? 0} months)`)
          continue
        }

        // Get last month's forecast
        const { data: forecast } = await db
          .from('forecasts')
          .select('revenue_forecast, staff_cost_forecast, food_cost_forecast')
          .eq('business_id', biz.id)
          .eq('period_year', year)
          .eq('period_month', month)
          .single()

        if (!forecast) {
          console.log(`[forecast-calibration] No forecast found for ${biz.name} ${year}-${month}`)
          continue
        }

        // Get last month's actuals from monthly_metrics. Merge tracker_data food_cost
        // since monthly_metrics doesn't populate that column yet.
        const [mmActualsRes, trActualsRes] = await Promise.all([
          db.from('monthly_metrics')
            .select('revenue, staff_cost, food_cost')
            .eq('business_id', biz.id).eq('year', year).eq('month', month).maybeSingle(),
          db.from('tracker_data')
            .select('food_cost')
            .eq('business_id', biz.id).eq('period_year', year).eq('period_month', month).maybeSingle(),
        ])
        const actuals = mmActualsRes.data
          ? {
              revenue:    mmActualsRes.data.revenue,
              staff_cost: mmActualsRes.data.staff_cost,
              food_cost:  Number(mmActualsRes.data.food_cost ?? 0) > 0
                ? mmActualsRes.data.food_cost
                : (trActualsRes.data?.food_cost ?? 0),
            }
          : null

        if (!actuals) {
          console.log(`[forecast-calibration] No actuals found for ${biz.name} ${year}-${month}`)
          continue
        }

        // Calculate accuracy and bias
        const revenueForecast = Number(forecast.revenue_forecast ?? 0)
        const revenueActual = Number(actuals.revenue ?? 0)
        
        let accuracyPct = 0
        let biasFactor = 1.0
        
        if (revenueActual > 0 && revenueForecast > 0) {
          // Accuracy: how close forecast was to actual (100% = perfect)
          const error = Math.abs(revenueActual - revenueForecast)
          accuracyPct = 100 - (error / revenueActual * 100)
          
          // Bias: >1.0 = we under-forecast, <1.0 = we over-forecast
          biasFactor = revenueActual / revenueForecast
        }

        // Calculate day-of-week factors from 90 days of daily_metrics (deduped).
        // revenue_logs has both aggregate `personalkollen` rows AND per-dept `pk_*`
        // rows for the same data — summing it double-counts. daily_metrics is the
        // deduped summary table aggregated by the sync engine.
        const ninetyDaysAgo = new Date(today)
        ninetyDaysAgo.setDate(today.getDate() - 90)

        const { data: revenueLogs } = await db
          .from('daily_metrics')
          .select('date, revenue')
          .eq('business_id', biz.id)
          .gte('date', ninetyDaysAgo.toISOString().slice(0, 10))
          .lte('date', today.toISOString().slice(0, 10))

        const dowFactors: Record<number, number> = { 0: 1.0, 1: 1.0, 2: 1.0, 3: 1.0, 4: 1.0, 5: 1.0, 6: 1.0 }
        
        if (revenueLogs?.length) {
          // Group by day of week (0=Sunday, 1=Monday, etc.)
          const byDow: Record<number, { total: number; count: number }> = {}
          
          for (const log of revenueLogs) {
            const date = new Date(log.date)
            const dow = date.getDay() // 0=Sunday, 1=Monday, etc.
            const revenue = Number(log.revenue ?? 0)
            
            if (!byDow[dow]) byDow[dow] = { total: 0, count: 0 }
            byDow[dow].total += revenue
            byDow[dow].count += 1
          }
          
          // Calculate average revenue per day
          const allDays = Object.values(byDow)
          const totalRevenue = allDays.reduce((sum, day) => sum + day.total, 0)
          const totalCount = allDays.reduce((sum, day) => sum + day.count, 0)
          const avgRevenuePerDay = totalCount > 0 ? totalRevenue / totalCount : 0
          
          // Calculate factors (day revenue / average)
          for (const [dowStr, data] of Object.entries(byDow)) {
            const dow = parseInt(dowStr)
            const avgRevenueForDay = data.count > 0 ? data.total / data.count : 0
            dowFactors[dow] = avgRevenuePerDay > 0 ? avgRevenueForDay / avgRevenuePerDay : 1.0
          }
        }

        // Get existing calibration to calculate rolling bias
        const { data: existingCalibration } = await db
          .from('forecast_calibration')
          .select('bias_factor, calibrated_at')
          .eq('business_id', biz.id)
          .order('calibrated_at', { ascending: false })
          .limit(3)

        // Calculate 3-month rolling average bias
        let rollingBias = biasFactor
        if (existingCalibration?.length) {
          const recentBiases = existingCalibration.map((c: any) => Number(c.bias_factor ?? 1.0))
          recentBiases.push(biasFactor)
          const avgBias = recentBiases.reduce((sum, b) => sum + b, 0) / recentBiases.length
          rollingBias = avgBias
        }

        // Upsert calibration data
        await db.from('forecast_calibration').upsert({
          business_id: biz.id,
          org_id: biz.org_id,
          calibrated_at: new Date().toISOString(),
          accuracy_pct: Math.round(accuracyPct * 10) / 10, // 1 decimal place
          bias_factor: Math.round(rollingBias * 100) / 100, // 2 decimal places
          dow_factors: dowFactors,
        }, {
          onConflict: 'business_id'
        })

        calibrated++
        console.log(`[forecast-calibration] Calibrated ${biz.name}: accuracy=${Math.round(accuracyPct)}%, bias=${rollingBias.toFixed(2)}`)

      } catch (err: any) {
        const errorMsg = `${biz.name}: ${err.message}`
        errors.push(errorMsg)
        console.error(`[forecast-calibration] Error for ${biz.name}:`, err)
      }
    }

    log.info('forecast-calibration complete', {
      route:       'cron/forecast-calibration',
      duration_ms: Date.now() - started,
      calibrated,
      errors:      errors.length,
      month:       `${year}-${String(month).padStart(2, '0')}`,
      status:      errors.length === 0 ? 'success' : 'partial',
    })

    return NextResponse.json({
      ok: true,
      calibrated,
      errors: errors.length > 0 ? errors : undefined,
      month: `${year}-${String(month).padStart(2, '0')}`,
      timestamp: new Date().toISOString(),
    })

  } catch (error: any) {
    log.error('forecast-calibration failed', {
      route:       'cron/forecast-calibration',
      duration_ms: Date.now() - started,
      error:       error?.message ?? String(error),
      status:      'error',
    })
    return NextResponse.json({
      ok: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    }, { status: 500 })
  }
  })
}


// Vercel Cron dispatches GET — delegate to the same handler.
export const GET = POST
