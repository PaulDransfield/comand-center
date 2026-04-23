// lib/ai/outcomes.ts
//
// Writes to `ai_forecast_outcomes` (M020). Call from any AI surface that
// emits a dated prediction, then the daily `ai-accuracy-reconciler` cron
// fills in the actual_* columns once the period closes, and the next
// generation of that surface's prompt can cite its own track record.
//
// Design goals:
//   - One-line to call: captureOutcome(db, { surface, org_id, ... }).
//   - Non-fatal: never blocks or errors the parent flow on insert failure.
//   - Idempotent per (surface, org, business, period): re-insert-and-delete
//     pattern so if a surface regenerates, the previous unresolved row gets
//     replaced instead of accumulating duplicates.

type Db = any

export type ForecastSurface =
  | 'budget_generate'
  | 'budget_coach'
  | 'budget_analyse'
  | 'weekly_memo'
  | 'tracker_narrative'

export interface CapturedOutcome {
  surface:      ForecastSurface
  org_id:       string
  business_id:  string
  period_year:  number
  period_month?: number | null
  model?:       string

  suggested_revenue?:    number | null
  suggested_staff_cost?: number | null
  suggested_food_cost?:  number | null
  suggested_other_cost?: number | null
  suggested_net_profit?: number | null
  suggested_margin_pct?: number | null

  /** Small JSON snapshot of the input context so diff-analysis can reason
   *  about what the AI was given. No PII, no staff/customer names. */
  context?: Record<string, unknown>
}

/**
 * Insert one prediction into ai_forecast_outcomes. Never throws — a failure
 * here must not cascade into the parent AI generation flow (the prediction
 * is already out the door by the time we record it).
 *
 * Caller is responsible for only calling this for SURFACES that make
 * dated predictions we can later reconcile against monthly_metrics.
 */
export async function captureOutcome(db: Db, o: CapturedOutcome): Promise<void> {
  try {
    // Clear any prior unresolved row for the same scope — a regen should
    // replace, not duplicate. Resolved rows stay (they're the historical
    // accuracy record).
    if (o.period_month != null) {
      await db
        .from('ai_forecast_outcomes')
        .delete()
        .eq('surface',     o.surface)
        .eq('org_id',      o.org_id)
        .eq('business_id', o.business_id)
        .eq('period_year', o.period_year)
        .eq('period_month', o.period_month)
        .is('actuals_resolved_at', null)
    }

    await db.from('ai_forecast_outcomes').insert({
      surface:              o.surface,
      org_id:               o.org_id,
      business_id:          o.business_id,
      period_year:          o.period_year,
      period_month:         o.period_month ?? null,
      model:                o.model ?? null,
      suggested_revenue:    o.suggested_revenue    ?? null,
      suggested_staff_cost: o.suggested_staff_cost ?? null,
      suggested_food_cost:  o.suggested_food_cost  ?? null,
      suggested_other_cost: o.suggested_other_cost ?? null,
      suggested_net_profit: o.suggested_net_profit ?? null,
      suggested_margin_pct: o.suggested_margin_pct ?? null,
      suggested_context:    o.context ?? {},
    })
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn(`[ai-outcomes] capture failed for ${o.surface}:`, e?.message)
  }
}
