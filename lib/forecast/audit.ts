// lib/forecast/audit.ts
//
// Capture helper for daily_forecast_outcomes (M059). Idempotent UPSERT
// via (business_id, forecast_date, surface) so re-firing the dashboard 5x
// in a minute produces exactly one row per (business, date, surface) —
// the latest prediction wins.
//
// Phase A "shadow mode" usage: the two legacy forecasters call this
// after they've computed their prediction. The capture is observability,
// not load-bearing — soft-fail on errors so a misbehaving INSERT cannot
// break the parent forecast response.
//
// Backtest write guard: refuses to log rows for forecast_date < today
// unless options.backfillMode is true. This keeps dashboard back-test
// calls (where the operator looks at "what did we predict yesterday with
// today's data") from polluting MAPE-by-horizon with negative
// prediction_horizon_days.
//
// See PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md Sections 2 + 5.

import { createAdminClient } from '@/lib/supabase/server'

export type ForecastSurface =
  | 'consolidated_daily'
  | 'scheduling_ai_revenue'
  | 'weather_demand'
  | 'llm_adjusted'

export type SnapshotVersion = 'consolidated_v1' | 'legacy_v1'

export interface CaptureForecastOutcome {
  org_id:           string
  business_id:      string
  forecast_date:    string             // YYYY-MM-DD
  surface:          ForecastSurface
  predicted_revenue: number
  baseline_revenue?: number | null
  model_version:    string
  snapshot_version: SnapshotVersion
  inputs_snapshot:  Record<string, unknown>
  llm_reasoning?:   string | null
  confidence?:      'high' | 'medium' | 'low' | null
}

export interface CaptureOptions {
  /** Bypass the backtest write guard — only set true for the one-time backfill script. */
  backfillMode?: boolean
  /** Optional admin client; otherwise a fresh one is created (writes need RLS bypass). */
  db?: any
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** YYYY-MM-DD in Stockholm time — matches today-data-sentinel boundary. */
function todayStockholm(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm' }).format(new Date())
}

/**
 * Capture a daily forecast prediction. Idempotent: re-firing on the same
 * (business_id, forecast_date, surface) UPDATEs the existing row. Soft-fails
 * on errors — the forecaster's primary job is to emit a prediction; the
 * audit log is observability and must not break the response.
 *
 * Skips silently when:
 *   - forecast_date isn't a valid YYYY-MM-DD
 *   - forecast_date < today (Stockholm) and backfillMode is not set
 *   - predicted_revenue isn't a finite positive number
 */
export async function captureForecastOutcome(
  outcome: CaptureForecastOutcome,
  options: CaptureOptions = {},
): Promise<void> {
  try {
    if (!ISO_DATE_RE.test(outcome.forecast_date)) {
      console.warn('[forecast-audit] invalid forecast_date, skipping:', outcome.forecast_date)
      return
    }
    if (!Number.isFinite(outcome.predicted_revenue) || outcome.predicted_revenue <= 0) {
      // Zero / negative predictions carry no signal; skip to keep MAPE clean.
      return
    }

    // Backtest write guard. Stockholm-local boundary so the cutover lines
    // up with today-data-sentinel and the operator's mental model.
    if (!options.backfillMode && outcome.forecast_date < todayStockholm()) {
      return
    }

    const db = options.db ?? createAdminClient()

    const row = {
      org_id:            outcome.org_id,
      business_id:       outcome.business_id,
      forecast_date:     outcome.forecast_date,
      surface:           outcome.surface,
      predicted_revenue: Math.round(outcome.predicted_revenue),
      baseline_revenue:  outcome.baseline_revenue == null
                          ? null
                          : Math.round(outcome.baseline_revenue),
      // first_predicted_at + first_predicted_date intentionally omitted —
      // column defaults fire on INSERT and neither is in the payload so
      // ON CONFLICT DO UPDATE doesn't touch them (preserves true lead time).
      predicted_at:      new Date().toISOString(),
      model_version:    outcome.model_version,
      snapshot_version: outcome.snapshot_version,
      inputs_snapshot:  outcome.inputs_snapshot,
      llm_reasoning:    outcome.llm_reasoning ?? null,
      confidence:       outcome.confidence ?? null,
    }

    // PostgREST upsert respects the column UNIQUE (business_id, forecast_date, surface).
    // ignoreDuplicates: false → DO UPDATE, latest prediction wins.
    const { error } = await db
      .from('daily_forecast_outcomes')
      .upsert(row, { onConflict: 'business_id,forecast_date,surface', ignoreDuplicates: false })

    if (error) {
      console.warn('[forecast-audit] upsert failed:', error.message, {
        business_id:   outcome.business_id,
        forecast_date: outcome.forecast_date,
        surface:       outcome.surface,
      })
    }
  } catch (err: any) {
    // Soft-fail: audit logging must NEVER break the parent forecast response.
    console.warn('[forecast-audit] capture failed:', err?.message ?? String(err))
  }
}

/**
 * Bulk variant for forecasters that emit N days at a time. Runs each capture
 * via Promise.allSettled() so a single-row failure doesn't poison the batch.
 */
export async function captureForecastOutcomes(
  outcomes: CaptureForecastOutcome[],
  options: CaptureOptions = {},
): Promise<void> {
  if (outcomes.length === 0) return
  // Reuse the same admin client across the batch instead of recreating
  // one per row — saves a few ms when capturing 7-14 days at once.
  const db = options.db ?? createAdminClient()
  await Promise.allSettled(
    outcomes.map(o => captureForecastOutcome(o, { ...options, db })),
  )
}
