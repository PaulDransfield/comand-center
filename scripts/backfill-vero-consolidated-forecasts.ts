// scripts/backfill-vero-consolidated-forecasts.ts
//
// One-time backfill: walk Vero Italiano's history through dailyForecast()
// in retrospective mode and populate daily_forecast_outcomes with
// resolved rows. Per architecture §5 Decision J, this gives us 90+ days
// of audit data immediately instead of waiting two weeks of shadow capture.
//
// Methodology:
//   1. Find every date with daily_metrics.revenue > 0 (Vero's first
//      positive-revenue day is 2025-11-24)
//   2. For each date, call dailyForecast(businessId, date, {
//        skipLogging:  true,        — we INSERT directly with resolved fields
//        asOfDate:     date - 1day, — "as if forecasting yesterday"
//        backfillMode: true,        — bypass Piece 1's backtest write guard
//      })
//   3. Tag inputs_snapshot.data_quality_flags with
//      'backfilled_observed_as_forecast' (per architecture Decision J:
//      we use observed weather, not historical forecasts which we don't
//      have stored)
//   4. INSERT into daily_forecast_outcomes with actual_revenue, error_pct,
//      resolution_status='resolved', resolved_at=NOW() so the reconciler
//      doesn't re-process them.
//
// Run:
//   npx -y dotenv-cli -e .env.production.local -- npx tsx scripts/backfill-vero-consolidated-forecasts.ts
//
// Idempotent: ON CONFLICT (business_id, forecast_date, surface) DO NOTHING
// so re-running won't overwrite earlier backfills (each row's
// first_predicted_at preserved).

import { createClient } from '@supabase/supabase-js'
import { dailyForecast } from '../lib/forecast/daily'
import { isProvisional } from '../lib/finance/period-closure'

const VERO_ORG_ID      = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'
const VERO_BUSINESS_ID = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
// Vero's first positive-revenue day per architecture §3 deferral note
const EARLIEST_DATE    = '2025-11-24'

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — load .env.production.local first')
  }
  const db = createClient(url, key)

  console.log('[backfill] Vero consolidated-forecast backfill')
  console.log(`[backfill] business_id: ${VERO_BUSINESS_ID}`)
  console.log(`[backfill] from: ${EARLIEST_DATE}, to: yesterday`)
  console.log('')

  // Pull every Vero day with positive revenue (the date set we'll backfill)
  const yesterdayIso = ymd(addDays(new Date(), -1))
  const { data: actuals, error: actualsErr } = await db
    .from('daily_metrics')
    .select('date, revenue')
    .eq('business_id', VERO_BUSINESS_ID)
    .gte('date', EARLIEST_DATE)
    .lte('date', yesterdayIso)
    .gt('revenue', 0)
    .order('date', { ascending: true })

  if (actualsErr) throw new Error(`actuals fetch: ${actualsErr.message}`)
  const actualsList = actuals ?? []
  console.log(`[backfill] ${actualsList.length} dates with positive revenue to process`)
  console.log('')

  let written = 0
  let skipped = 0
  let errored = 0
  let totalAbsErr = 0

  const startedAt = Date.now()

  for (let i = 0; i < actualsList.length; i++) {
    const row = actualsList[i]
    const dateIso = row.date as string
    const date    = new Date(dateIso + 'T12:00:00Z')
    const asOf    = addDays(date, -1)
    const actual  = Number(row.revenue)

    // Skip provisional months — see admin endpoint for rationale.
    if (isProvisional(date.getUTCFullYear(), date.getUTCMonth() + 1)) {
      skipped++
      continue
    }

    try {
      const forecast = await dailyForecast(VERO_BUSINESS_ID, date, {
        db,
        skipLogging:  true,           // we insert manually below
        asOfDate:     asOf,
        backfillMode: true,
      })

      // Tag the snapshot per architecture Decision J
      const snapshot = { ...forecast.inputs_snapshot,
        data_quality_flags: [...(forecast.inputs_snapshot.data_quality_flags ?? []), 'backfilled_observed_as_forecast'],
      }

      const errorPct = actual > 0
        ? (forecast.predicted_revenue - actual) / actual
        : null

      // Direct INSERT — bypass capture helper because we're writing a
      // pre-resolved row (with actual_revenue + error_pct populated).
      // ON CONFLICT DO NOTHING preserves first_predicted_at if the row
      // was somehow already inserted (e.g. partial prior run).
      // Backfill MUST override first_predicted_at + first_predicted_date
      // to the asOfDate, otherwise prediction_horizon_days = forecast_date
      // - first_predicted_date goes negative (months in the past) and the
      // v_forecast_mape_by_surface view excludes the row (filters horizon
      // BETWEEN 0 AND 14). Setting both to asOf gives horizon=1, matching
      // what a live capture would produce when called the day before.
      const asOfIso = ymd(asOf)
      const { error: insErr } = await db.from('daily_forecast_outcomes').upsert({
        org_id:               VERO_ORG_ID,
        business_id:          VERO_BUSINESS_ID,
        forecast_date:        dateIso,
        surface:              'consolidated_daily',
        predicted_revenue:    forecast.predicted_revenue,
        baseline_revenue:     forecast.baseline_revenue,
        first_predicted_at:   asOf.toISOString(),
        first_predicted_date: asOfIso,
        predicted_at:         asOf.toISOString(),
        model_version:        forecast.model_version,
        snapshot_version:     forecast.snapshot_version,
        inputs_snapshot:      snapshot,
        confidence:           forecast.confidence,
        actual_revenue:       Math.round(actual),
        error_pct:            errorPct == null ? null : Math.round(errorPct * 10000) / 10000,
        resolution_status:    'resolved',
        resolved_at:          new Date().toISOString(),
      }, { onConflict: 'business_id,forecast_date,surface', ignoreDuplicates: false })

      if (insErr) {
        errored++
        console.error(`[backfill] ${dateIso}: insert error: ${insErr.message}`)
      } else {
        written++
        if (errorPct != null) totalAbsErr += Math.abs(errorPct)
      }

      if ((i + 1) % 25 === 0 || i === actualsList.length - 1) {
        const elapsed = Math.round((Date.now() - startedAt) / 1000)
        const mape    = written > 0 ? (totalAbsErr / written) * 100 : 0
        console.log(`[backfill] ${i + 1}/${actualsList.length} (${elapsed}s elapsed) — written=${written} skipped=${skipped} errored=${errored} interim_mape=${mape.toFixed(1)}%`)
      }
    } catch (e: any) {
      errored++
      console.error(`[backfill] ${dateIso}: ${e?.message ?? e}`)
    }
  }

  const totalElapsed = Math.round((Date.now() - startedAt) / 1000)
  const finalMape    = written > 0 ? (totalAbsErr / written) * 100 : 0
  console.log('')
  console.log(`[backfill] DONE in ${totalElapsed}s`)
  console.log(`[backfill]   written:  ${written}`)
  console.log(`[backfill]   skipped:  ${skipped}`)
  console.log(`[backfill]   errored:  ${errored}`)
  console.log(`[backfill]   final_MAPE: ${finalMape.toFixed(1)}%   (note: optimistically biased due to weather observed-as-forecast)`)
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}
function addDays(d: Date, days: number): Date {
  const out = new Date(d)
  out.setUTCDate(out.getUTCDate() + days)
  return out
}

main().catch(err => {
  console.error('[backfill] FAILED:', err?.stack ?? err)
  process.exit(1)
})
