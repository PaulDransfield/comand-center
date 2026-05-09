// lib/fortnox/api/validate-backfill.ts
//
// Phase A of the API-priority strategy (memory: project_api_priority_strategy):
// run the same data-integrity validators that PDF apply uses BEFORE writing
// API-derived tracker_data rows. Otherwise API data is "trusted" but never
// audited — the same trap that produced Vero's bad pre-Session-13 PDF rows.
//
// We use the SAME `validators.ts` module the PDF chokepoint uses, but only
// the subset that applies to API extractions (most checks are universal;
// the PDF-specific ones — org_nr match, claimed-period match, doc_type
// reconciliation — don't have direct equivalents on the API path).
//
// Per-period validation: each (year, month) is validated independently.
// A backfill run can have some periods pass and others fail. The worker
// uses the result to decide which to write and which to skip+log.

import {
  validateExtraction,
  type ValidationFinding,
  type ValidationContext,
  type ExtractionForValidation,
} from '@/lib/fortnox/validators'
import type { PeriodInput } from './voucher-to-aggregator'
import type { ProjectedRollup } from '@/lib/finance/projectRollup'

export interface ApiPeriodValidation {
  /** {year, month} for the period this result describes. */
  year:        number
  month:       number
  /** True only if no `error` severity findings — write is safe. */
  ok:          boolean
  /** All findings (errors + warnings + info) — surfaced to backfill_progress. */
  findings:    ValidationFinding[]
  /** Convenience counts. */
  counts:      { error: number; warning: number; info: number }
}

export interface ApiBackfillValidationContext {
  /** Org row — needed for the (rare) case where API extraction surfaces a
   *  company name that should match. Most API checks don't need this. */
  org:        { org_number?: string | null; name?: string | null }
  business:   { name?: string | null; org_number?: string | null }
  /** Six-month history for scale-anomaly comparisons. Pull from
   *  tracker_data BEFORE the backfill writes its new rows. */
  history?:   ValidationContext['history']
  /** Existing tracker_data periods (any source), so the gap check can fire. */
  existingPeriods?: Set<string>
  /** Today (testability). */
  now?:       Date
}

/**
 * Validate ONE period's translated rollup + its projected counterpart.
 * Returns a per-period report. The caller decides what to do with errors
 * (write-and-warn, skip, retry).
 */
export function validateApiBackfillPeriod(
  period:    PeriodInput,
  projected: ProjectedRollup,
  ctx:       ApiBackfillValidationContext,
): ApiPeriodValidation {
  // Adapter: the validators consume an ExtractionForValidation shape
  // identical to what the PDF parser produces. Build that from our period.
  const extraction: ExtractionForValidation = {
    // Heuristic doc_type: API backfill always processes one period at a
    // time from the worker's POV, so this is monthly. Validators tolerate
    // missing doc_type so this is best-effort labelling.
    doc_type: 'pnl_monthly',
    organisation_number: ctx.business.org_number ?? ctx.org.org_number ?? null,
    company_name:        ctx.business.name ?? null,
    scale_detected:      'sek',
    periods: [
      {
        year:  period.year,
        month: period.month,
        rollup: {
          revenue:      Number(projected.revenue      ?? 0),
          food_cost:    Number(projected.food_cost    ?? 0),
          alcohol_cost: Number(projected.alcohol_cost ?? 0),
          staff_cost:   Number(projected.staff_cost   ?? 0),
          other_cost:   Number(projected.other_cost   ?? 0),
          depreciation: Number(projected.depreciation ?? 0),
          financial:    Number(projected.financial    ?? 0),
          net_profit:   Number(projected.net_profit   ?? 0),
        },
        // We could pass period.lines here if validators ever inspected
        // them; current checks don't. Skip to keep the payload small.
        lines: [],
      },
    ],
  }

  const valCtx: ValidationContext = {
    org:             ctx.org,
    business:        ctx.business,
    // For API backfill, "claimed" period IS the period — no user input
    // to mismatch against. Filling it lets checkPeriodMatch confirm
    // (always passes). Could pass null and the check politely declines.
    claimedPeriod:   { year: period.year, month: period.month },
    history:         ctx.history,
    existingPeriods: ctx.existingPeriods,
    now:             ctx.now,
  }

  const report = validateExtraction(extraction, valCtx)

  // Filter out findings that don't apply to API path. These checks key off
  // PDF-specific extraction artefacts (org_nr_in_pdf, doc_type) that the
  // API path doesn't produce, and they fire as `info` level which would
  // pointlessly clutter backfill_progress.
  const ignoredCodesForApi = new Set([
    'org_nr_missing_in_pdf',           // API doesn't extract org-nr from a PDF
    'org_nr_not_set_locally',          // re-fires per-period; once is enough
    'multi_month_but_claimed_single',  // API processes one period at a time
  ])
  const filtered = report.findings.filter(f => !ignoredCodesForApi.has(f.code))

  const counts = filtered.reduce(
    (acc, f) => { acc[f.severity]++; return acc },
    { error: 0, warning: 0, info: 0 } as ApiPeriodValidation['counts'],
  )

  return {
    year:     period.year,
    month:    period.month,
    ok:       counts.error === 0,
    findings: filtered,
    counts,
  }
}

/**
 * Convenience: validate every translated period in one call. Returns the
 * per-period results PLUS a summary so the worker can log a single line.
 */
export function validateApiBackfillBatch(
  periodProjections: Array<{ period: PeriodInput; projected: ProjectedRollup }>,
  ctx:               ApiBackfillValidationContext,
): {
  results:  ApiPeriodValidation[]
  summary: { passed: number; failed: number; total_warnings: number; total_errors: number }
} {
  const results = periodProjections.map(({ period, projected }) =>
    validateApiBackfillPeriod(period, projected, ctx),
  )
  const summary = results.reduce(
    (acc, r) => {
      if (r.ok) acc.passed++
      else      acc.failed++
      acc.total_warnings += r.counts.warning
      acc.total_errors   += r.counts.error
      return acc
    },
    { passed: 0, failed: 0, total_warnings: 0, total_errors: 0 },
  )
  return { results, summary }
}
