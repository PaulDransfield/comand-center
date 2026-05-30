// lib/inventory/audit-sampler.ts
//
// Pure logic for the M106 audit-queue sampler. Splits cleanly into:
//   - `targetSampleRate` — adaptive sampling formula (owner-locked, §7.3)
//   - `scoreCandidate`   — risk-score per the §2b.3 ordering
//   - `pickSampleSet`    — risk-weighted sampling: take the top-N by score,
//                          where N = round(candidates × targetSampleRate)
//
// No DB calls; all inputs are plain objects. Easy to unit-test (mirror
// fixtures in scripts/test-audit-sampler.mjs) and easy to evolve as the
// risk model matures.

import { USAGE_WEIGHT_ACTIVATION_THRESHOLD } from './demotion'

// ── Adaptive sample rate ───────────────────────────────────────────────
//
// At ~89 total auto-matches with a 7-day window of maybe 5-15 items, a
// flat 5% sample = 0 items in the queue (useless). The adaptive rate
// audits ALMOST EVERYTHING while volume is tiny, tapering to the
// steady-state 5% as the matcher's auto-link share grows.
//
// Locked 2026-05-30 per owner reply.

export function targetSampleRate(autoLinksInWindow: number): number {
  if (autoLinksInWindow <= 20)  return 1.00   // audit everything
  if (autoLinksInWindow <= 50)  return 0.50
  if (autoLinksInWindow <= 200) return 0.20
  return 0.05                                  // steady-state target
}

// ── Risk score ─────────────────────────────────────────────────────────
//
// Higher = more important to review. The ordering is set per §2b.3 of
// LEARNING-LOOP-PHASE1-PLAN.md (owner-locked 2026-05-30):
//
//   1. cross-supplier        (Step 4 trigram — most speculative)
//   2. previously-demoted    (times_demoted > 0 — known-flip risk)
//   3. same-supplier         (Step 3 trigram — high volume, long tail)
//   4. recent                (newer aliases — less real-world validation)
//   5. high-line-value       (a wrong alias on a 50k SEK line vs 14 kr)
//   6. high-usage            DISABLED today — re-enabled when an alias
//                            crosses USAGE_WEIGHT_ACTIVATION_THRESHOLD (20)
//
// Weights are TIER-GAP, not additive at peer scale. The owner's locked
// order is "cross > previously-demoted > same > recent > value": an
// alias with only cross outranks ANY combination that doesn't include
// cross. This means the gap between tier weights must be LARGER than
// the sum of all lower-tier weights + tiebreakers, so combinations
// within a tier still rise but never bleed up into the next tier.
//
// Example check:
//   cross alone (no tiebreakers):        10000  (tier 1 floor)
//   same+prev+all tiebreakers:           1000 + 100 + 50 + 25 + 40 = 1215  (still in tier 2/3)
//   cross + prev + all tiebreakers:      10000 + 1000 + 50 + 25 + 40 = 11115
//
// So cross+combos always rank above all non-cross combos, and prev
// outranks every same-only combo. Within each tier, additive secondary
// signals act as tiebreakers without crossing the tier boundary.

export interface AliasCandidate {
  alias_id:         string
  business_id:      string
  org_id:           string
  match_method:     'article_number' | 'description_exact' | 'fuzzy_same_supplier' | 'fuzzy_cross_supplier' | 'owner_confirmed'
  match_confidence: number | null
  times_demoted:    number
  first_seen_at:    string    // ISO
  // Line context (for high-value tie-breaker)
  highest_line_total_excl_vat: number   // 0 when no line refs
  highest_value_line_id:       string | null
  // Usage count — only used today when crossed the activation threshold
  line_refs_count: number
}

export interface ScoredCandidate extends AliasCandidate {
  risk_score: number
  reason:     'confident_auto_match' | 'previously_demoted' | 'decay_stale' | 'manual_review'
  /** Diagnostic — which factor pushed this into the queue */
  primary_factor: string
}

const WEIGHT_CROSS_SUPPLIER      = 10000   // tier 1
const WEIGHT_PREVIOUSLY_DEMOTED  = 1000    // tier 2
const WEIGHT_SAME_SUPPLIER       = 100     // tier 3
const WEIGHT_RECENT_BOOST_MAX    = 50      // tiebreaker — inverse-of-age within 7 days
const WEIGHT_HIGH_VALUE_BOOST    = 25      // tiebreaker — log scale of line total
const WEIGHT_HIGH_USAGE_BOOST    = 40      // disabled today; gated by USAGE_WEIGHT_ACTIVATION_THRESHOLD

const RECENT_WINDOW_DAYS = 7

export function scoreCandidate(c: AliasCandidate, now = new Date()): ScoredCandidate {
  let score = 0
  let primary = 'other'
  let reason: ScoredCandidate['reason'] = 'manual_review'

  // 1. cross-supplier
  if (c.match_method === 'fuzzy_cross_supplier') {
    score += WEIGHT_CROSS_SUPPLIER
    primary = 'cross_supplier'
    reason = 'confident_auto_match'
  }

  // 2. previously-demoted (additive — a cross-supplier + previously-demoted
  //    alias gets BOTH weights, ranking it higher than either alone)
  if (c.times_demoted > 0) {
    score += WEIGHT_PREVIOUSLY_DEMOTED
    if (primary === 'other') {
      primary = 'previously_demoted'
      reason = 'previously_demoted'
    } else {
      primary = `${primary}+previously_demoted`
    }
  }

  // 3. same-supplier (mutually exclusive with cross-supplier — only one
  //    fuzzy_* match_method per alias)
  if (c.match_method === 'fuzzy_same_supplier') {
    score += WEIGHT_SAME_SUPPLIER
    if (primary === 'other') {
      primary = 'same_supplier'
      reason = 'confident_auto_match'
    }
  }

  // 4. recent — linear inverse from full boost at age=0 down to 0 at
  //    RECENT_WINDOW_DAYS. Older than that → 0 boost.
  const ageMs = now.getTime() - new Date(c.first_seen_at).getTime()
  const ageDays = ageMs / (1000 * 60 * 60 * 24)
  if (ageDays >= 0 && ageDays < RECENT_WINDOW_DAYS) {
    const recencyBoost = Math.round(WEIGHT_RECENT_BOOST_MAX * (1 - ageDays / RECENT_WINDOW_DAYS))
    score += recencyBoost
  }

  // 5. high-line-value (log-scale tiebreaker). 14 kr line → ~5; 50,000 kr → ~50.
  if (c.highest_line_total_excl_vat > 0) {
    const valueBoost = Math.min(
      WEIGHT_HIGH_VALUE_BOOST,
      Math.round(Math.log10(Math.abs(c.highest_line_total_excl_vat) + 1) * 10),
    )
    score += valueBoost
  }

  // 6. high-usage — disabled today, gated by the activation threshold.
  //    The Step-0 diagnostic showed 0 aliases at ≥21 usages, so this
  //    factor adds nothing on current data. When auto-links grow and
  //    some aliases cross the threshold, re-enable.
  if (c.line_refs_count >= USAGE_WEIGHT_ACTIVATION_THRESHOLD) {
    // Linear from threshold up to 200 usages = full boost.
    const usageBoost = Math.min(
      WEIGHT_HIGH_USAGE_BOOST,
      Math.round((c.line_refs_count - USAGE_WEIGHT_ACTIVATION_THRESHOLD) * (WEIGHT_HIGH_USAGE_BOOST / (200 - USAGE_WEIGHT_ACTIVATION_THRESHOLD))),
    )
    score += usageBoost
    if (primary === 'other') primary = 'high_usage'
  }

  return { ...c, risk_score: score, reason, primary_factor: primary }
}

// ── Sample picker ──────────────────────────────────────────────────────
//
// Risk-weighted = "rank by score, take top-N". Pure deterministic; no
// randomness. The owner sees the highest-risk N items, where N is the
// adaptive rate × population.

export function pickSampleSet(
  candidates: AliasCandidate[],
  now = new Date(),
): ScoredCandidate[] {
  if (candidates.length === 0) return []
  const scored = candidates.map(c => scoreCandidate(c, now))
  const rate = targetSampleRate(candidates.length)
  const n = Math.max(1, Math.round(candidates.length * rate))
  return scored
    .sort((a, b) => b.risk_score - a.risk_score)
    .slice(0, n)
}
