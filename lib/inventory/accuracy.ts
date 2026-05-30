// lib/inventory/accuracy.ts
//
// Pure computation helpers for the D3 accuracy snapshot
// (LEARNING-LOOP-PHASE1-PLAN.md §4). No DB calls — takes raw counts
// and returns rates. Easy to unit-test; the daily cron at
// /api/cron/inventory-accuracy-snapshot fetches the counts and calls
// these.
//
// The functions intentionally return NULL when the input is below the
// MIN_SAMPLE_FOR_RATE threshold — surfaces "we don't have enough data
// to say" as a real result rather than a misleading 0% or 100%.

/**
 * Minimum sample size for an agreement-rate computation to be considered
 * meaningful. Set to match the §7.1 MIN_OUTCOMES_FOR_ALERT guard so the
 * snapshot's stored value is consistent with what the floor-check uses.
 */
export const MIN_SAMPLE_FOR_RATE = 50

/**
 * Round to 1 decimal place (e.g. 61.3) — matches the existing data
 * cadence used elsewhere in the repo (cf. diag-phase1-prereq.mjs B4).
 */
function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * Agreement rate as a percentage (0-100). Returns NULL when the
 * denominator is below MIN_SAMPLE_FOR_RATE so the floor doesn't act
 * on noise.
 *
 * @param agreed   number of outcomes with agreed=true in the window
 * @param total    total outcomes in the window (same context family)
 */
export function agreementPct(agreed: number, total: number): number | null {
  if (total < MIN_SAMPLE_FOR_RATE) return null
  return round1((agreed / total) * 100)
}

/**
 * Audit-sample precision: confirmations / (confirmations + corrections).
 * Skip decisions are excluded from the denominator (auditor deferred
 * without a signal).
 *
 * Returns NULL when the denominator is below MIN_SAMPLE_FOR_RATE.
 */
export function precisionPct(confirms: number, corrections: number): number | null {
  const denom = confirms + corrections
  if (denom < MIN_SAMPLE_FOR_RATE) return null
  return round1((confirms / denom) * 100)
}

/**
 * Bare percentage (0-100) — used for needs_review rate, demotion rate.
 * No min-sample guard here because these are absolute structural counts,
 * not signals subject to noise interpretation. NULL on zero denominator.
 */
export function pct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return round1((numerator / denominator) * 100)
}

/**
 * create_new divergence: how much more often the AI suggests `create_new`
 * vs the owner actually choosing `create_new` in the window. Positive
 * means the AI over-suggests (catalog-duplication risk).
 *
 * Formula: (ai_count - owner_count) / max(ai_count, 1)
 * Returns NULL when the AI count is below a small floor (5) — too small
 * to read.
 */
export function createNewDivergencePct(aiCount: number, ownerCount: number): number | null {
  if (aiCount < 5) return null
  return round1(((aiCount - ownerCount) / aiCount) * 100)
}

/**
 * Pattern for detecting non-product lines that Gate-0 let through —
 * Swedish bookkeeping noise that should be classified non-inventory but
 * sometimes ends up tagged as a product alias.
 *
 * Examples (real Carlsberg data from D2 sampling):
 *   "Avtalsrabatt JAMESON 40%"
 *   "Avtalsrabatt BIRRA PORETTI 5,0%"
 *   "Avtalsrabatt SE-EKO-01 CB AFB ORG 0,5%"
 *   "Pant Coca-Cola 33cl"
 *   "Öresavrundning"
 *   "Faktureringsavgift"
 *
 * Conservative — matches only the clearest non-product patterns. False
 * positives here are worse than false negatives (we don't want to flag
 * a real product as noise).
 */
// Note: NO leading \b. ECMAScript \b uses ASCII word characters only
// (without /u flag), so it doesn't fire before Swedish ö/å/ä/Ö/Å/Ä —
// "Öresavrundning" would never match with a \b prefix. The patterns
// are distinctive enough (no risk of "Xavtalsrabatt"-style false hits)
// to anchor by their own content.
export const REBATE_NOISE_PATTERN =
  /(avtalsrabatt|^rabatt|\bpant\b|pantersättning|öresavrundning|faktureringsavg|inkassoarvode|påminnelseavg)/i

/**
 * Counts how many of the given raw_description strings match the
 * rebate-noise pattern. Pure function; the cron passes in the rows it
 * pulled from product_aliases / supplier_invoice_lines.
 */
export function countRebateNoise(rawDescriptions: Array<string | null | undefined>): number {
  let n = 0
  for (const s of rawDescriptions) {
    if (s && REBATE_NOISE_PATTERN.test(s)) n++
  }
  return n
}

/**
 * Aggregate-snapshot shape that the cron writes per (org, business, day).
 * Matches the M107 schema column-for-column so we can pass it straight
 * to a PostgREST upsert.
 */
export interface AccuracySnapshot {
  org_id:                       string
  business_id:                  string | null   // NULL = global rollup
  snapshot_date:                string          // YYYY-MM-DD
  window_days:                  number

  needs_review_outcomes_total:  number
  needs_review_outcomes_agreed: number
  needs_review_agreement_pct:   number | null

  audit_sample_outcomes_total:  number
  audit_sample_outcomes_agreed: number
  audit_sample_agreement_pct:   number | null

  audit_sample_confirmations:   number
  audit_sample_corrections:     number
  audit_sample_precision_pct:   number | null

  needs_review_lines_count:     number
  total_lines_in_window:        number
  needs_review_rate_pct:        number | null

  demotions_in_window:          number
  active_aliases_window_start:  number
  demotion_rate_pct:            number | null

  ai_create_new_count:          number
  owner_create_new_count:       number
  create_new_divergence_pct:    number | null

  rebate_noise_count:           number

  alert_level:                  'hard' | 'soft' | 'informational' | null
  alert_reason:                 string | null
  baseline_needs_review_pct:    number | null
  delta_vs_baseline_pp:         number | null
}

/**
 * Helper: given the raw count inputs for a (business or global) row,
 * compute the rate fields. Returns a partial snapshot without the
 * alert_level / baseline fields — those are filled by accuracy-floor.ts
 * after this returns.
 */
export interface RawCounts {
  needs_review_outcomes_total:  number
  needs_review_outcomes_agreed: number
  audit_sample_outcomes_total:  number
  audit_sample_outcomes_agreed: number
  audit_sample_confirmations:   number
  audit_sample_corrections:     number
  needs_review_lines_count:     number
  total_lines_in_window:        number
  demotions_in_window:          number
  active_aliases_window_start:  number
  ai_create_new_count:          number
  owner_create_new_count:       number
  rebate_noise_count:           number
}

export function computeRates(c: RawCounts): Pick<AccuracySnapshot,
  | 'needs_review_outcomes_total' | 'needs_review_outcomes_agreed' | 'needs_review_agreement_pct'
  | 'audit_sample_outcomes_total' | 'audit_sample_outcomes_agreed' | 'audit_sample_agreement_pct'
  | 'audit_sample_confirmations'  | 'audit_sample_corrections'     | 'audit_sample_precision_pct'
  | 'needs_review_lines_count'    | 'total_lines_in_window'        | 'needs_review_rate_pct'
  | 'demotions_in_window'         | 'active_aliases_window_start'  | 'demotion_rate_pct'
  | 'ai_create_new_count'         | 'owner_create_new_count'       | 'create_new_divergence_pct'
  | 'rebate_noise_count'
> {
  return {
    needs_review_outcomes_total:  c.needs_review_outcomes_total,
    needs_review_outcomes_agreed: c.needs_review_outcomes_agreed,
    needs_review_agreement_pct:   agreementPct(c.needs_review_outcomes_agreed, c.needs_review_outcomes_total),

    audit_sample_outcomes_total:  c.audit_sample_outcomes_total,
    audit_sample_outcomes_agreed: c.audit_sample_outcomes_agreed,
    audit_sample_agreement_pct:   agreementPct(c.audit_sample_outcomes_agreed, c.audit_sample_outcomes_total),

    audit_sample_confirmations:   c.audit_sample_confirmations,
    audit_sample_corrections:     c.audit_sample_corrections,
    audit_sample_precision_pct:   precisionPct(c.audit_sample_confirmations, c.audit_sample_corrections),

    needs_review_lines_count:     c.needs_review_lines_count,
    total_lines_in_window:        c.total_lines_in_window,
    needs_review_rate_pct:        pct(c.needs_review_lines_count, c.total_lines_in_window),

    demotions_in_window:          c.demotions_in_window,
    active_aliases_window_start:  c.active_aliases_window_start,
    demotion_rate_pct:            pct(c.demotions_in_window, c.active_aliases_window_start),

    ai_create_new_count:          c.ai_create_new_count,
    owner_create_new_count:       c.owner_create_new_count,
    create_new_divergence_pct:    createNewDivergencePct(c.ai_create_new_count, c.owner_create_new_count),

    rebate_noise_count:           c.rebate_noise_count,
  }
}
