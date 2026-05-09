// lib/featureFlags/prediction-v2.ts
//
// Per-business feature-flag wrapper for the prediction-system v2 build.
// Reads from `business_feature_flags` (M057) which is parallel to the
// existing `feature_flags` (M012). The two tables have intentionally
// different defaults:
//
//   feature_flags        — per-org,      defaults ENABLED  (no row ⇒ run the agent)
//   business_feature_flags — per-business, defaults DISABLED (no row ⇒ feature OFF)
//
// The "build on the side" launch model in the architecture's Section 11
// requires every prediction-system feature to default OFF until validation
// passes. Vero's anomaly-confirm UI flips ON at the end of Week 3 (after
// the operator triage call) by inserting a single row into
// business_feature_flags with `enabled = true`. Everything else stays
// false until cutover.
//
// See PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md Appendix Z (Decision 2).

import { createAdminClient } from '@/lib/supabase/server'

// All v2 flags. Adding one: append here, document in the architecture's
// Section 11, set enabled=true via admin UI when ready to flip.
export const PREDICTION_V2_FLAGS = [
  'PREDICTION_V2_ANOMALY_CONFIRM_UI',
  'PREDICTION_V2_OWNER_EVENTS_UI',
  'PREDICTION_V2_DASHBOARD_CHART',
  'PREDICTION_V2_SCHEDULING_PAGE',
  'PREDICTION_V2_MONDAY_MEMO',
  'PREDICTION_V2_EXPORTS',
  'PREDICTION_V2_LLM_ADJUSTMENT',
  'PREDICTION_V2_ACCURACY_VIEW',
] as const

export type PredictionV2Flag = typeof PREDICTION_V2_FLAGS[number]

/**
 * Returns true iff there's an explicit `business_feature_flags` row for
 * (businessId, flag) with `enabled = true`. Default OFF.
 *
 * Soft-fails closed on errors — if the lookup throws (table missing,
 * RLS denial, network blip) we treat the flag as OFF rather than
 * exposing a partially-built feature to the operator. This is the
 * inverse of `isAgentEnabled`'s fail-open posture, intentionally:
 * the agent flag protects an existing capability; the v2 flag gates
 * an unfinished one.
 *
 * Caller can pass an existing admin db client to avoid creating a new
 * connection per call (useful inside crons that already hold one).
 */
export async function isPredictionV2FlagEnabled(
  businessId: string,
  flag: PredictionV2Flag,
  db?: any,
): Promise<boolean> {
  if (!businessId) return false
  try {
    const client = db ?? createAdminClient()
    const { data, error } = await client
      .from('business_feature_flags')
      .select('enabled')
      .eq('business_id', businessId)
      .eq('flag', flag)
      .maybeSingle()
    if (error) return false  // schema drift / table missing → fail closed
    return data?.enabled === true
  } catch {
    return false
  }
}

/**
 * Bulk lookup — returns the set of flags currently ON for a business.
 * Use this in route handlers that need to thread several flags into the
 * UI shell with one round-trip rather than N independent queries.
 */
export async function getPredictionV2FlagsEnabledForBusiness(
  businessId: string,
  db?: any,
): Promise<Set<PredictionV2Flag>> {
  if (!businessId) return new Set()
  try {
    const client = db ?? createAdminClient()
    const { data, error } = await client
      .from('business_feature_flags')
      .select('flag, enabled')
      .eq('business_id', businessId)
      .eq('enabled', true)
    if (error) return new Set()
    const enabled = new Set<PredictionV2Flag>()
    for (const row of data ?? []) {
      if ((PREDICTION_V2_FLAGS as readonly string[]).includes(row.flag)) {
        enabled.add(row.flag as PredictionV2Flag)
      }
    }
    return enabled
  } catch {
    return new Set()
  }
}
