// app/api/cron/ai-accuracy-reconciler/route.ts
//
// Daily cron — walks ai_forecast_outcomes rows whose period_year/month
// is in the past and actuals_resolved_at is null, pulls the matching
// monthly_metrics row, and fills in the actual_* + error_% fields.
//
// This is the closing half of the AI feedback loop:
//   1. Budget generator writes suggestions to ai_forecast_outcomes  (done)
//   2. Month closes, actual data lands in monthly_metrics            (existing pipeline)
//   3. THIS cron resolves the diff                                   (here)
//   4. Next generation pulls the resolved rows into its prompt as
//      "PRIOR AI ACCURACY"                                           (done)
//
// Also prunes outcomes older than 3 years via prune_ai_forecast_outcomes().
//
// 2026-05-08 (Piece 0 of prediction system v3.1) — also writes
// `forecast_calibration.accuracy_pct` + `bias_factor` so the legacy
// `/api/cron/forecast-calibration` cron (which had the Vero Sun=0.009
// dow_factors bug) can be disabled without freezing the values that
// `lib/ai/contextBuilder.ts:483-485` reads to feed /api/ask. The
// reconciler already aggregates the inputs (resolved actual vs suggested
// revenue per business per month), so one writer is cleaner than two.
// See PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md Appendix Z (Decision 1).
//
// Schedule: daily at 07:00 UTC (after master-sync at 05:00 and
// anomaly-check at 05:30). Hobby-plan-compatible.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { checkCronSecret }   from '@/lib/admin/check-secret'
import { log }               from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const preferredRegion = 'fra1'  // EU-only; Supabase is Frankfurt
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  const db = createAdminClient()
  const now = new Date()

  // ── Resolve outcomes where the period has closed ────────────────
  // A month is "closed" on the 1st of the following month (allow a
  // 24h safety margin so the master-sync aggregator has definitely
  // landed that month's last day).
  const yesterdayEndOfMonth = new Date(now.getFullYear(), now.getMonth(), 0)
  const cutoffYear  = yesterdayEndOfMonth.getFullYear()
  const cutoffMonth = yesterdayEndOfMonth.getMonth() + 1   // 1..12

  const { data: candidates, error: listErr } = await db
    .from('ai_forecast_outcomes')
    .select('id, org_id, business_id, period_year, period_month, suggested_revenue, suggested_staff_cost, suggested_net_profit, suggested_margin_pct')
    .is('actuals_resolved_at', null)
    .not('period_month', 'is', null)
    .or(`period_year.lt.${cutoffYear},and(period_year.eq.${cutoffYear},period_month.lte.${cutoffMonth})`)
    .limit(500)

  if (listErr) {
    log.error('ai-accuracy-reconciler list failed', {
      route: 'cron/ai-accuracy-reconciler',
      error: listErr.message,
      status: 'error',
    })
    return NextResponse.json({ error: listErr.message }, { status: 500 })
  }

  const rows = candidates ?? []
  let resolved = 0

  for (const outcome of rows) {
    try {
      const { data: mm } = await db
        .from('monthly_metrics')
        .select('revenue, staff_cost, food_cost, other_cost, net_profit, margin_pct')
        .eq('org_id', outcome.org_id)
        .eq('business_id', outcome.business_id)
        .eq('year', outcome.period_year)
        .eq('month', outcome.period_month)
        .maybeSingle()

      if (!mm) continue   // month still has no data, try again tomorrow

      const actualRev   = Number(mm.revenue ?? 0)
      const suggestRev  = Number(outcome.suggested_revenue ?? 0)

      // Error % = (actual - suggested) / suggested. Positive = AI
      // under-predicted (actual was higher than suggested). Classify
      // direction so the feedback block is easy to read.
      let revenueErrorPct: number | null = null
      let direction = 'no_actual'
      if (suggestRev > 0) {
        revenueErrorPct = ((actualRev - suggestRev) / suggestRev) * 100
        direction = Math.abs(revenueErrorPct) < 5 ? 'accurate'
                  : revenueErrorPct > 0          ? 'under'
                  :                                'over'
      }

      const actualStaff = Number(mm.staff_cost ?? 0)
      const suggestStaff = Number(outcome.suggested_staff_cost ?? 0)
      const staffErrorPct = suggestStaff > 0
        ? ((actualStaff - suggestStaff) / suggestStaff) * 100
        : null

      const actualMargin = Number(mm.margin_pct ?? 0)
      const suggestMargin = Number(outcome.suggested_margin_pct ?? 0)
      const marginErrorPp = actualMargin - suggestMargin

      await db.from('ai_forecast_outcomes').update({
        actual_revenue:      actualRev,
        actual_staff_cost:   actualStaff,
        actual_food_cost:    Number(mm.food_cost ?? 0),
        actual_other_cost:   Number(mm.other_cost ?? 0),
        actual_net_profit:   Number(mm.net_profit ?? 0),
        actual_margin_pct:   actualMargin,
        actuals_resolved_at: new Date().toISOString(),
        revenue_error_pct:   revenueErrorPct == null ? null : Math.round(revenueErrorPct * 10) / 10,
        revenue_direction:   direction,
        staff_cost_error_pct: staffErrorPct == null ? null : Math.round(staffErrorPct * 10) / 10,
        margin_error_pp:     Math.round(marginErrorPp * 10) / 10,
        updated_at:          new Date().toISOString(),
      }).eq('id', outcome.id)

      resolved++
    } catch (e: any) {
      log.warn('ai-accuracy-reconciler row failed', {
        route:      'cron/ai-accuracy-reconciler',
        outcome_id: outcome.id,
        error:      e?.message ?? String(e),
      })
    }
  }

  // ── Roll up per-business accuracy into forecast_calibration ──────
  // The legacy `/api/cron/forecast-calibration` cron used to write
  // `accuracy_pct` and `bias_factor` (alongside a buggy `dow_factors`).
  // That cron is being retired in this same Piece 0 commit; we move the
  // accuracy + bias writes here so the values keep updating and the
  // /api/ask context builder (lib/ai/contextBuilder.ts:483-485) doesn't
  // freeze on stale numbers.
  //
  //   accuracy_pct = mean of (1 - |revenue_error_pct| / 100), clamped 0-1
  //                  → expressed as 0-100 to match legacy semantics
  //   bias_factor  = mean of (actual / suggested) — values >1 mean AI
  //                  systematically under-predicts; <1 means over-predicts
  //
  // Window: last 12 resolved outcomes per business (≈ a year of monthly
  // forecasts). Skip businesses with <3 resolved rows — too few samples
  // to be honest about accuracy.
  const calibrationWritten = await rollupForecastCalibration(db)

  // GDPR retention — prune anything >3 years old.
  const { data: pruned } = await db.rpc('prune_ai_forecast_outcomes')

  log.info('ai-accuracy-reconciler complete', {
    route:               'cron/ai-accuracy-reconciler',
    duration_ms:         Date.now() - started,
    candidates:          rows.length,
    resolved,
    calibration_written: calibrationWritten,
    pruned:              pruned ?? 0,
    status:              'success',
  })

  return NextResponse.json({
    ok:                  true,
    candidates:          rows.length,
    resolved,
    calibration_written: calibrationWritten,
    pruned:              pruned ?? 0,
  })
}

/**
 * Aggregate the last N resolved outcomes per business into
 * `forecast_calibration.accuracy_pct` + `bias_factor`. Returns the count
 * of business rows upserted. Soft-fails on errors — the parent flow
 * shouldn't crash if forecast_calibration drifts schema-wise.
 */
async function rollupForecastCalibration(db: any): Promise<number> {
  try {
    const { data: resolved, error } = await db
      .from('ai_forecast_outcomes')
      .select('org_id, business_id, suggested_revenue, actual_revenue, revenue_error_pct, actuals_resolved_at')
      .not('actuals_resolved_at', 'is', null)
      .gt('suggested_revenue', 0)
      .gt('actual_revenue', 0)
      .order('actuals_resolved_at', { ascending: false })
      .limit(5000)
    if (error) throw error

    // Bucket by business, keep the freshest 12 per business.
    const byBiz: Record<string, { org_id: string; business_id: string; rows: any[] }> = {}
    for (const r of resolved ?? []) {
      const key = r.business_id as string
      if (!byBiz[key]) byBiz[key] = { org_id: r.org_id, business_id: key, rows: [] }
      if (byBiz[key].rows.length < 12) byBiz[key].rows.push(r)
    }

    let written = 0
    const nowIso = new Date().toISOString()
    for (const { org_id, business_id, rows } of Object.values(byBiz)) {
      if (rows.length < 3) continue  // too few samples; skip

      // accuracy_pct: 0-100, "of recent forecasts how close were we to actual"
      // Clamp the per-row residual at 100% so a single 1000% bust doesn't
      // tank a year's average. (One catastrophic miss should drop the score,
      // not destroy it.)
      const accuracyMean =
        rows.reduce((sum: number, r: any) => {
          const errPct = Number(r.revenue_error_pct ?? 0)
          const closeness = Math.max(0, 1 - Math.min(Math.abs(errPct), 100) / 100)
          return sum + closeness
        }, 0) / rows.length

      // bias_factor: actual / suggested geometric mean. >1 = AI under-predicts,
      // <1 = AI over-predicts. Skip rows where suggested is missing/zero.
      const ratios = rows
        .map((r: any) => Number(r.actual_revenue) / Number(r.suggested_revenue))
        .filter((x: number) => Number.isFinite(x) && x > 0)
      const geomMean = ratios.length
        ? Math.exp(ratios.reduce((s: number, x: number) => s + Math.log(x), 0) / ratios.length)
        : 1

      const { error: upsertErr } = await db
        .from('forecast_calibration')
        .upsert({
          org_id,
          business_id,
          accuracy_pct:  Math.round(accuracyMean * 1000) / 10,  // 0-100, one decimal
          bias_factor:   Math.round(geomMean   * 1000) / 1000,
          calibrated_at: nowIso,
          // dow_factors intentionally NOT touched — the legacy column had
          // the Sun=0.009 bug and is retired. The consolidated forecaster
          // (Piece 2) will replace it with sample-size-guarded baselines.
        }, { onConflict: 'business_id' })

      if (!upsertErr) written++
    }
    return written
  } catch (e: any) {
    log.warn('ai-accuracy-reconciler: forecast_calibration rollup soft-failed', {
      route: 'cron/ai-accuracy-reconciler',
      error: e?.message ?? String(e),
    })
    return 0
  }
}
