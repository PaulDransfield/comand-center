// lib/forecast/accuracy.ts
//
// A2.9 — Forecast accuracy engine. Reads resolved rows from
// daily_forecast_outcomes (M059) and returns a summary owners can
// trust: "Last N months: X% accurate" + per-surface and per-horizon
// breakdown for the drilldown.
//
// Single number on the badge = (100 - MAPE), clamped to [0, 100].
// MAPE = mean(|predicted - actual| / actual × 100) across resolved rows.
//
// Surfaces included by default: consolidated_daily, llm_adjusted,
// scheduling_ai_revenue, weather_demand. The badge headline value is
// computed across ALL surfaces (owners care about overall accuracy).
// Drilldown splits by surface so the team can see which layer is
// pulling the average down.
//
// Honest-incomplete: when n_observations < 7 (less than a week of
// resolved predictions) the engine returns null for the accuracy score
// — too noisy to publish a "trust me" number off of.

import type { SupabaseClient } from '@supabase/supabase-js'

const MIN_OBSERVATIONS_FOR_SCORE = 7
const SURFACES_INCLUDED = [
  'consolidated_daily',
  'llm_adjusted',
  'scheduling_ai_revenue',
  'weather_demand',
] as const
type Surface = typeof SURFACES_INCLUDED[number]

export interface AccuracyByGroup {
  n:             number          // resolved rows in the group
  mape:          number          // mean absolute percentage error %
  accuracy_pct:  number          // 100 - mape (floor 0)
  bias_pct:      number          // mean signed error % (over = +, under = -)
}

export interface ForecastAccuracy {
  business_id:    string
  months:         number              // window in months
  from:           string              // ISO date
  to:             string              // ISO date
  n_observations: number              // total resolved rows
  overall:        AccuracyByGroup | null    // null when n_observations < threshold
  by_surface:     Record<string, AccuracyByGroup>
  by_horizon:     Record<string, AccuracyByGroup>   // bucket labels: '0' (same-day), '1-3', '4-7', '8+'
  computed_at:    string
}

export async function computeForecastAccuracy(
  db:         SupabaseClient,
  businessId: string,
  months:     number = 6,
): Promise<ForecastAccuracy> {
  const to = new Date()
  const from = new Date(to.getFullYear(), to.getMonth() - months, to.getDate())
  const fromIso = from.toISOString().slice(0, 10)
  const toIso   = to.toISOString().slice(0, 10)

  // Resolved rows only — pending / unresolvable rows can't be scored.
  const { data, error } = await db
    .from('daily_forecast_outcomes')
    .select('surface, predicted_revenue, actual_revenue, error_pct, prediction_horizon_days, forecast_date, resolution_status')
    .eq('business_id', businessId)
    .eq('resolution_status', 'resolved')
    .gte('forecast_date', fromIso)
    .lte('forecast_date', toIso)
    .in('surface', SURFACES_INCLUDED as any)
    .not('actual_revenue', 'is', null)
    .limit(20_000)

  if (error) throw new Error(`daily_forecast_outcomes read failed: ${error.message}`)

  // Compute MAPE per row inline — error_pct on the row IS already the
  // signed error %, but its definition has varied across pieces 1-4
  // (some store predicted/actual ratios). Recompute from raw integers
  // for consistency.
  interface Entry {
    surface: Surface
    abs_pct: number      // |predicted - actual| / actual × 100
    signed_pct: number   // (predicted - actual) / actual × 100
    horizon: number
  }
  const entries: Entry[] = []
  for (const r of data ?? []) {
    const predicted = Number((r as any).predicted_revenue ?? 0)
    const actual    = Number((r as any).actual_revenue    ?? 0)
    if (actual <= 0 || !Number.isFinite(predicted) || !Number.isFinite(actual)) continue
    const signed = ((predicted - actual) / actual) * 100
    const abs    = Math.abs(signed)
    if (!Number.isFinite(signed) || !Number.isFinite(abs)) continue
    entries.push({
      surface: (r as any).surface,
      abs_pct: abs,
      signed_pct: signed,
      horizon: Number((r as any).prediction_horizon_days ?? 0),
    })
  }

  const n_observations = entries.length

  // Helpers — aggregate a slice into AccuracyByGroup
  const summarise = (slice: Entry[]): AccuracyByGroup | null => {
    if (slice.length === 0) return null
    const mape = slice.reduce((s, e) => s + e.abs_pct,    0) / slice.length
    const bias = slice.reduce((s, e) => s + e.signed_pct, 0) / slice.length
    return {
      n:            slice.length,
      mape:         Math.round(mape * 10) / 10,
      accuracy_pct: Math.max(0, Math.round((100 - mape) * 10) / 10),
      bias_pct:     Math.round(bias * 10) / 10,
    }
  }

  const overall = n_observations >= MIN_OBSERVATIONS_FOR_SCORE
    ? summarise(entries)
    : null

  // Per-surface
  const by_surface: Record<string, AccuracyByGroup> = {}
  for (const surf of SURFACES_INCLUDED) {
    const slice = entries.filter(e => e.surface === surf)
    const s = summarise(slice)
    if (s) by_surface[surf] = s
  }

  // Per-horizon buckets — same-day, near-term, week, longer
  const horizonBucket = (h: number) =>
      h === 0 ? '0'
    : h <= 3  ? '1-3'
    : h <= 7  ? '4-7'
    :           '8+'
  const by_horizon: Record<string, AccuracyByGroup> = {}
  for (const bucket of ['0', '1-3', '4-7', '8+']) {
    const slice = entries.filter(e => horizonBucket(e.horizon) === bucket)
    const s = summarise(slice)
    if (s) by_horizon[bucket] = s
  }

  return {
    business_id:    businessId,
    months,
    from:           fromIso,
    to:             toIso,
    n_observations,
    overall,
    by_surface,
    by_horizon,
    computed_at:    new Date().toISOString(),
  }
}
