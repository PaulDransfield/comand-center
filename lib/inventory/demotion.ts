// lib/inventory/demotion.ts
//
// Constants + helpers for the M105 demotion mechanism. The threshold and
// decay window are intentionally named constants rather than magic numbers
// so the values are grep-able + change-controlled.
//
// Source decisions: LEARNING-LOOP-PHASE1-PLAN.md §0.4 + §7.
// Origin diagnostic: scripts/diag-phase1-prereq.mjs B6 — 0 flip-flops
// observed across 224 group revisits, so threshold = 2 is safe.

/**
 * Number of distinct corrections an alias must accumulate before it is
 * automatically deactivated. Set to 2 on the basis that the production
 * audit found zero owner flip-flops across 224 group revisits — so two
 * accidental clicks demoting a legit alias is effectively impossible at
 * current scale. Re-evaluate if real correction patterns ever show
 * meaningful flip-flop rates.
 */
export const DEMOTION_THRESHOLD = 2

/**
 * D2 (audit queue) overrides the default threshold when surfacing
 * corrections from an explicit audit-sample review. One audit-time
 * correction is sufficient to deactivate because the auditor is
 * explicitly reviewing the alias (not browsing past it).
 */
export const DEMOTION_THRESHOLD_AUDIT = 1

/**
 * Number of days an active cross-supplier (Step 4 fuzzy) alias may go
 * unused before D2's decay sweep flags it as "needs re-confirm". NOT a
 * deactivation trigger — flag-only. The owner re-confirms or the audit
 * queue presents it as a needs-attention item. Re-evaluable.
 */
export const DECAY_DAYS_CROSS_SUPPLIER = 90

/**
 * Forward-compat: usage-based weight in the audit-sampler's risk score is
 * disabled today because no alias has accumulated meaningful usage yet
 * (Step 0 diagnostic: 0 aliases with >=21 line-item references). Re-enable
 * usage-weighting when the matcher's auto-rate climbs and any alias
 * crosses this threshold — at that point a wrong alias applied N times
 * is genuinely high-impact and should be prioritised for audit.
 *
 * Owner decision 2026-05-30 §7.3.
 */
export const USAGE_WEIGHT_ACTIVATION_THRESHOLD = 20
