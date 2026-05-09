// app/api/cron/daily-forecast-reconciler/route.ts
//
// Daily reconciler — walks daily_forecast_outcomes rows whose
// forecast_date is in the past and resolution_status='pending', pulls
// the matching daily_metrics revenue, and fills in actual_revenue +
// error_pct + resolution_status.
//
// This is the closing half of the prediction-system audit loop:
//   1. Forecasters write predictions to daily_forecast_outcomes (Piece 1 capture)
//   2. master-sync (04:00 UTC) lands yesterday's revenue in daily_metrics
//   3. THIS cron (10:00 UTC) reconciles predictions vs actuals (here)
//   4. Pieces 4-5 will read resolved rows for MAPE-by-horizon analysis
//      and pattern extraction
//
// Resolution paths:
//   - actual missing AND forecast_date >= today - 7d → defer (try tomorrow)
//   - actual missing AND forecast_date <  today - 7d → unresolvable_no_actual
//   - confirmed anomaly on the date                  → unresolvable_data_quality
//   - actual revenue = 0 (closed day)                → unresolvable_zero_actual
//   - normal resolution                              → resolved + error_pct
//
// Idempotent re-run via WHERE resolution_status = 'pending'.
//
// See PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md Section 5
// (Capture and reconciliation).

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { checkCronSecret }   from '@/lib/admin/check-secret'
import { log }               from '@/lib/log/structured'

export const runtime         = 'nodejs'
export const preferredRegion = 'fra1'   // EU-only; Supabase is Frankfurt
export const dynamic         = 'force-dynamic'
export const maxDuration     = 60

/** YYYY-MM-DD in Stockholm time — matches today-data-sentinel boundary. */
function todayStockholm(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm' }).format(new Date())
}

/** YYYY-MM-DD that is N days before today (Stockholm). */
function daysAgoStockholm(n: number): string {
  const today = new Date(todayStockholm() + 'T00:00:00Z')
  today.setUTCDate(today.getUTCDate() - n)
  return today.toISOString().slice(0, 10)
}

export async function GET(req: NextRequest) {
  noStore()
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  const db = createAdminClient()
  const today = todayStockholm()
  const giveUpCutoff = daysAgoStockholm(7)

  // Pull pending rows where forecast_date is strictly in the past.
  // The partial index idx_dfo_pending_resolution makes this cheap.
  const { data: candidates, error: listErr } = await db
    .from('daily_forecast_outcomes')
    .select('id, business_id, org_id, forecast_date, surface, predicted_revenue')
    .eq('resolution_status', 'pending')
    .lt('forecast_date', today)
    .order('forecast_date', { ascending: true })
    .limit(2000)

  if (listErr) {
    log.error('daily-forecast-reconciler list failed', {
      route:  'cron/daily-forecast-reconciler',
      error:  listErr.message,
      status: 'error',
    })
    return NextResponse.json({ error: listErr.message }, { status: 500 })
  }

  const rows = candidates ?? []
  let resolved = 0
  let deferred = 0
  let markedUnresolvable = 0

  for (const row of rows) {
    try {
      // Pull actual revenue from daily_metrics for this (business, date).
      const { data: actualRow } = await db
        .from('daily_metrics')
        .select('revenue')
        .eq('business_id', row.business_id)
        .eq('date', row.forecast_date)
        .maybeSingle()

      const actual = actualRow?.revenue == null ? null : Number(actualRow.revenue)

      // ── Late-arrival defer ─────────────────────────────────────────
      // No actual yet AND forecast_date is within the last 7 days →
      // master-sync may still be backfilling. Leave pending; tomorrow's
      // run picks it up.
      if (actual == null && row.forecast_date >= giveUpCutoff) {
        deferred++
        continue
      }

      // ── Give up (no actual, > 7 days old) ──────────────────────────
      if (actual == null) {
        await db.from('daily_forecast_outcomes').update({
          resolution_status: 'unresolvable_no_actual',
          resolved_at:       new Date().toISOString(),
        }).eq('id', row.id)
        markedUnresolvable++
        continue
      }

      // ── Anomaly contamination check (Piece 0 confirmation_status) ──
      // If the operator has confirmed a revenue anomaly on this date,
      // grading our prediction against an admitted outlier would be
      // unfair. Mark unresolvable_data_quality so MAPE stays honest.
      const { data: confirmedAlert } = await db
        .from('anomaly_alerts')
        .select('id')
        .eq('business_id', row.business_id)
        .eq('period_date', row.forecast_date)
        .in('alert_type', ['revenue_drop', 'revenue_spike'])
        .eq('confirmation_status', 'confirmed')
        .limit(1)
        .maybeSingle()

      if (confirmedAlert) {
        await db.from('daily_forecast_outcomes').update({
          resolution_status: 'unresolvable_data_quality',
          actual_revenue:    Math.round(actual),
          resolved_at:       new Date().toISOString(),
        }).eq('id', row.id)
        markedUnresolvable++
        continue
      }

      // ── Zero-revenue day (closed) ──────────────────────────────────
      // Closed day → record actual=0 but no MAPE (division by zero).
      if (actual === 0) {
        await db.from('daily_forecast_outcomes').update({
          resolution_status: 'unresolvable_zero_actual',
          actual_revenue:    0,
          error_pct:         null,
          resolved_at:       new Date().toISOString(),
        }).eq('id', row.id)
        markedUnresolvable++
        continue
      }

      // ── Normal resolution ──────────────────────────────────────────
      // error_pct = (predicted - actual) / actual.
      //   positive → over-predicted, negative → under-predicted.
      // error_attribution is left null in Piece 1 — Pieces 4-5 own that
      // (the LLM consumes it for explanation generation).
      const errorPct = (Number(row.predicted_revenue) - actual) / actual

      await db.from('daily_forecast_outcomes').update({
        actual_revenue:    Math.round(actual),
        error_pct:         Math.round(errorPct * 10000) / 10000, // 4 dp
        resolution_status: 'resolved',
        resolved_at:       new Date().toISOString(),
      }).eq('id', row.id)

      resolved++
    } catch (err: any) {
      log.warn('daily-forecast-reconciler row failed', {
        route:    'cron/daily-forecast-reconciler',
        row_id:   row.id,
        business: row.business_id,
        date:     row.forecast_date,
        surface:  row.surface,
        error:    err?.message ?? String(err),
      })
    }
  }

  // ── GDPR retention sweep (3-year horizon, mirrors M020) ─────────────
  let pruned = 0
  try {
    const { data: prunedCount } = await db.rpc('prune_daily_forecast_outcomes')
    pruned = Number(prunedCount ?? 0)
  } catch (err: any) {
    log.warn('daily-forecast-reconciler prune failed', {
      route: 'cron/daily-forecast-reconciler',
      error: err?.message ?? String(err),
    })
  }

  log.info('daily-forecast-reconciler complete', {
    route:               'cron/daily-forecast-reconciler',
    duration_ms:         Date.now() - started,
    candidates:          rows.length,
    resolved,
    deferred,
    marked_unresolvable: markedUnresolvable,
    pruned,
    status:              'success',
  })

  return NextResponse.json({
    ok:                  true,
    candidates:          rows.length,
    resolved,
    deferred,
    marked_unresolvable: markedUnresolvable,
    pruned,
  })
}
