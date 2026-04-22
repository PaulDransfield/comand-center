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

  // GDPR retention — prune anything >3 years old.
  const { data: pruned } = await db.rpc('prune_ai_forecast_outcomes')

  log.info('ai-accuracy-reconciler complete', {
    route:       'cron/ai-accuracy-reconciler',
    duration_ms: Date.now() - started,
    candidates:  rows.length,
    resolved,
    pruned:      pruned ?? 0,
    status:      'success',
  })

  return NextResponse.json({
    ok:           true,
    candidates:   rows.length,
    resolved,
    pruned:       pruned ?? 0,
  })
}
