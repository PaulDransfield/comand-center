// lib/inventory/accuracy-floor.ts
//
// The §7.1 floor-check. Pure function. Compares today's
// needs_review_agreement_pct against the trailing-30-day baseline
// (built from snapshots ON OR AFTER the BASELINE_ANCHOR_DATE) and
// emits an alert level.
//
// OWNER-LOCKED RULES (LEARNING-LOOP-PHASE1-PLAN.md §7.1 + §3b.1 + §3b.2):
//
//   1. PRIMARY signal is RELATIVE — drop from trailing baseline:
//      - drop ≥ 5pp below baseline → 'soft'
//      - drop ≥ 10pp below baseline → 'hard'
//
//   2. BACKSTOP absolute floors (in case baseline drifts low):
//      - today < 55% → at least 'soft'
//      - today < 50% → at least 'hard'
//
//   3. MIN-SAMPLE guard:
//      - today's outcomes < MIN_OUTCOMES_FOR_ALERT → quiet (NULL)
//      - Noise filter; aligns with accuracy.ts MIN_SAMPLE_FOR_RATE.
//
//   4. WARM-UP (§3b.2):
//      - snapshot_date < BASELINE_ANCHOR_DATE + WARMUP_DAYS → emit level
//        but tag as 'informational' (logged, not actioned).
//
//   5. SEGMENTED — only watches needs_review_agreement_pct, not blended
//      or audit_sample. Audit-sample has its own (looser, informational)
//      monitor not implemented here in v1.

import { MIN_SAMPLE_FOR_RATE } from './accuracy'

/** Date D2 merged. Anchors the post-D1/D2-regime baseline window. */
export const BASELINE_ANCHOR_DATE = '2026-05-30'

/** Days after anchor during which floor alerts are 'informational' only. */
export const WARMUP_DAYS = 30

/** Minimum outcomes in today's window before the floor can fire. */
export const MIN_OUTCOMES_FOR_ALERT = MIN_SAMPLE_FOR_RATE   // = 50

/** Relative drop thresholds (percentage points below baseline). */
export const SOFT_RELATIVE_DROP_PP = 5
export const HARD_RELATIVE_DROP_PP = 10

/** Absolute backstop floors (percentage points). */
export const SOFT_ABSOLUTE_FLOOR_PCT = 55
export const HARD_ABSOLUTE_FLOOR_PCT = 50

export type AlertLevel = 'hard' | 'soft' | 'informational' | null

export interface FloorCheckInput {
  /** Today's snapshot date (YYYY-MM-DD). */
  snapshot_date:                string
  /** Today's needs_review agreement, %. NULL = below MIN_SAMPLE_FOR_RATE. */
  needs_review_agreement_pct:   number | null
  /** Total needs_review outcomes in today's window. */
  needs_review_outcomes_total:  number
  /**
   * Rolling-30-day baseline agreement pct from prior snapshots ON OR
   * AFTER the anchor date. NULL = no baseline yet (e.g. first day).
   */
  baseline_pct:                 number | null
}

export interface FloorCheckResult {
  alert_level:               AlertLevel
  alert_reason:              string | null
  baseline_needs_review_pct: number | null
  delta_vs_baseline_pp:      number | null
}

/**
 * Determine whether today's snapshot is in the warm-up window.
 * Exposed so the daily cron can also log the warm-up state for telemetry.
 */
export function isInWarmup(snapshotDate: string, anchor: string = BASELINE_ANCHOR_DATE, warmupDays: number = WARMUP_DAYS): boolean {
  const today = new Date(snapshotDate + 'T00:00:00Z').getTime()
  const start = new Date(anchor + 'T00:00:00Z').getTime()
  const warmupEnd = start + warmupDays * 86_400_000
  return today >= start && today < warmupEnd
}

/**
 * Main floor check. See LEARNING-LOOP-PHASE1-PLAN.md §7.1 for the
 * locked decision matrix.
 */
export function checkAgreementFloor(input: FloorCheckInput): FloorCheckResult {
  const { snapshot_date, needs_review_agreement_pct, needs_review_outcomes_total, baseline_pct } = input

  // ── 1. MIN-SAMPLE guard — always wins ────────────────────────────────
  if (needs_review_agreement_pct == null || needs_review_outcomes_total < MIN_OUTCOMES_FOR_ALERT) {
    return {
      alert_level:               null,
      alert_reason:              `insufficient sample (${needs_review_outcomes_total} outcomes, need ≥${MIN_OUTCOMES_FOR_ALERT})`,
      baseline_needs_review_pct: baseline_pct,
      delta_vs_baseline_pp:      null,
    }
  }

  // ── 2. Compute the raw alert level (ignoring warm-up) ────────────────
  let level: AlertLevel = null
  let reason: string | null = null
  const delta = baseline_pct == null ? null : Math.round((needs_review_agreement_pct - baseline_pct) * 10) / 10

  // Relative drop check (only when baseline exists).
  if (delta != null) {
    if (delta <= -HARD_RELATIVE_DROP_PP) {
      level  = 'hard'
      reason = `agreement dropped ${(-delta).toFixed(1)}pp vs baseline (${baseline_pct!.toFixed(1)}% → ${needs_review_agreement_pct.toFixed(1)}%); threshold ${HARD_RELATIVE_DROP_PP}pp`
    } else if (delta <= -SOFT_RELATIVE_DROP_PP) {
      level  = 'soft'
      reason = `agreement dropped ${(-delta).toFixed(1)}pp vs baseline (${baseline_pct!.toFixed(1)}% → ${needs_review_agreement_pct.toFixed(1)}%); threshold ${SOFT_RELATIVE_DROP_PP}pp`
    }
  }

  // Absolute backstop check — escalates regardless of relative delta.
  if (needs_review_agreement_pct < HARD_ABSOLUTE_FLOOR_PCT && level !== 'hard') {
    level  = 'hard'
    reason = `agreement ${needs_review_agreement_pct.toFixed(1)}% below absolute floor ${HARD_ABSOLUTE_FLOOR_PCT}%`
  } else if (needs_review_agreement_pct < SOFT_ABSOLUTE_FLOOR_PCT && level == null) {
    level  = 'soft'
    reason = `agreement ${needs_review_agreement_pct.toFixed(1)}% below absolute floor ${SOFT_ABSOLUTE_FLOOR_PCT}%`
  }

  // ── 3. Warm-up override — downgrade real alerts to 'informational' ───
  if (level != null && isInWarmup(snapshot_date)) {
    return {
      alert_level:               'informational',
      alert_reason:              `[WARMUP] ${reason}`,
      baseline_needs_review_pct: baseline_pct,
      delta_vs_baseline_pp:      delta,
    }
  }

  return {
    alert_level:               level,
    alert_reason:              reason,
    baseline_needs_review_pct: baseline_pct,
    delta_vs_baseline_pp:      delta,
  }
}
