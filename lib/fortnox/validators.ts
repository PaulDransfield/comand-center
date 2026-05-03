// lib/fortnox/validators.ts
//
// Single chokepoint for "is this Fortnox extraction safe to apply?"
// Used by /api/fortnox/apply BEFORE any tracker_data write. Every check
// is pure — given an extraction + business context, returns a list of
// findings classified by severity.
//
// Severity model:
//   error   — block apply unless the caller explicitly passes force=true
//   warning — allow apply but caller MUST acknowledge the warning code
//   info    — informational, no acknowledgement needed
//
// Each finding carries a stable `code` so the UI / alert systems can
// pattern-match without parsing English.
//
// Why one module: pre-2026-05-04 the validation logic was scattered
// across the parser (math reconciliation), the apply route (period
// checks), and post-apply CRONs. Centralising it makes new checks
// trivial to add (one function, append to validateExtraction()) and
// makes the report shape something the UI can render uniformly.
//
// Source-of-truth checks live here. AI-based "second opinion" lives in
// lib/fortnox/ai-auditor.ts (called separately and merged into the same
// report shape on the apply route).

import { normaliseOrgNr } from '@/lib/sweden/orgnr'

export type Severity = 'error' | 'warning' | 'info'

export interface ValidationFinding {
  code:              string         // stable identifier, e.g. 'org_nr_mismatch'
  severity:          Severity
  message:           string         // human-readable
  detail?:           Record<string, any>
  override_allowed?: boolean        // false = HARD block even with force=true
}

export interface ValidationReport {
  ok:        boolean                // true if no errors (warnings are OK)
  findings:  ValidationFinding[]
  /** Convenience counters. */
  counts:    { error: number; warning: number; info: number }
}

export interface ValidationContext {
  /** organisation row — { org_number?: string | null, name?: string | null } */
  org:               { org_number?: string | null; name?: string | null }
  /** business row  — { name?: string | null, org_number?: string | null } */
  business:          { name?: string | null; org_number?: string | null }
  /** What the user / extractor SAID the period was — { year, month? }.
   *  Compared against extracted periods. */
  claimedPeriod?:    { year?: number | null; month?: number | null }
  /** Prior 6 months of revenue / staff / food for sanity ranges (oldest
   *  first). Pass empty array if business is brand-new. */
  history?: Array<{
    year:       number
    month:      number
    revenue:    number
    staff_cost: number
    food_cost:  number
  }>
  /** Existing tracker_data periods (for gap detection) — set of
   *  "YYYY-MM" strings already populated for this business. */
  existingPeriods?:  Set<string>
  /** Today's date (passed in for testability). Defaults to new Date(). */
  now?:              Date
}

// Extraction shape the validators read. Matches what the parser +
// extract-worker produce. Tolerant on missing fields — each check
// declines politely when its inputs aren't present.
export interface ExtractionForValidation {
  doc_type?:         'pnl_monthly' | 'pnl_annual' | 'pnl_multi_month'
  organisation_number?: string | null
  company_name?:     string | null
  scale_detected?:   'sek' | 'ksek' | 'msek'
  periods: Array<{
    year:   number
    month:  number      // 0 for annual rollup
    rollup: {
      revenue?:       number
      food_cost?:     number
      alcohol_cost?:  number
      staff_cost?:    number
      other_cost?:    number
      depreciation?:  number
      financial?:     number
      net_profit?:    number
    }
    lines?: Array<{ amount?: number; account?: number }>
  }>
}

/** Run every validator. Order doesn't matter — each is independent. */
export function validateExtraction(
  extraction: ExtractionForValidation,
  ctx:        ValidationContext,
): ValidationReport {
  const findings: ValidationFinding[] = []
  for (const check of CHECKS) {
    try {
      const out = check(extraction, ctx)
      if (out) findings.push(...(Array.isArray(out) ? out : [out]))
    } catch (e: any) {
      findings.push({
        code:     'validator_threw',
        severity: 'warning',
        message:  `Validator failed: ${e?.message ?? 'unknown'} — review manually before applying.`,
      })
    }
  }
  const counts = findings.reduce(
    (acc, f) => { acc[f.severity]++; return acc },
    { error: 0, warning: 0, info: 0 } as ValidationReport['counts'],
  )
  return { ok: counts.error === 0, findings, counts }
}

// ── Individual checks ─────────────────────────────────────────────────
type CheckFn = (e: ExtractionForValidation, ctx: ValidationContext) => ValidationFinding | ValidationFinding[] | null

const CHECKS: CheckFn[] = [
  checkOrgNumberMatch,
  checkCompanyNameMatch,
  checkPeriodMatch,
  checkPeriodInReasonableRange,
  checkDocTypeVsClaimedPeriod,
  checkSignConvention,
  checkMathConsistency,
  checkScaleAnomaly,
  checkPeriodGap,
  checkSubsetCaps,
]

/** Critical: PDF org-nr must match the org we're applying to. */
function checkOrgNumberMatch(e: ExtractionForValidation, ctx: ValidationContext): ValidationFinding | null {
  const pdfOrgNr = normaliseOrgNr(e.organisation_number ?? null)
  if (!pdfOrgNr) {
    // Parser couldn't read it — info, not an error. The extractor falls
    // back to the org we picked.
    return {
      code:     'org_nr_missing_in_pdf',
      severity: 'info',
      message:  "Organisationsnummer not detected in the PDF. Confirm this is the right business's report before applying.",
    }
  }
  // Prefer business-level org-nr (multi-entity groups), fall back to org-level.
  const expectedOrgNr =
    normaliseOrgNr(ctx.business.org_number ?? null) ||
    normaliseOrgNr(ctx.org.org_number ?? null)
  if (!expectedOrgNr) {
    return {
      code:     'org_nr_not_set_locally',
      severity: 'warning',
      message:  "We don't have an organisationsnummer on file for this business — can't verify the PDF matches.",
    }
  }
  if (pdfOrgNr !== expectedOrgNr) {
    return {
      code:     'org_nr_mismatch',
      severity: 'error',
      message:  `This PDF is for organisationsnummer ${formatOrgNr(pdfOrgNr)}, but you're applying it to "${ctx.business.name ?? 'this business'}" (${formatOrgNr(expectedOrgNr)}). Did you upload to the wrong business?`,
      detail:   { pdf_org_nr: pdfOrgNr, expected_org_nr: expectedOrgNr },
      override_allowed: false,                                      // never override — too high blast radius
    }
  }
  return null
}

/** Soft check: company name in PDF should fuzzy-match the business name. */
function checkCompanyNameMatch(e: ExtractionForValidation, ctx: ValidationContext): ValidationFinding | null {
  const pdfName = (e.company_name ?? '').trim()
  const ourName = (ctx.business.name ?? '').trim()
  if (!pdfName || !ourName) return null
  const a = normaliseName(pdfName)
  const b = normaliseName(ourName)
  if (a === b || a.includes(b) || b.includes(a)) return null
  // Token overlap — at least one shared substantial word
  const tokensA = new Set(a.split(/\s+/).filter(t => t.length >= 4))
  const tokensB = new Set(b.split(/\s+/).filter(t => t.length >= 4))
  const overlap = [...tokensA].filter(t => tokensB.has(t)).length
  if (overlap > 0) return null
  return {
    code:     'company_name_mismatch',
    severity: 'warning',
    message:  `PDF says "${pdfName}" but you're applying to "${ourName}". Confirm this is the right business.`,
    detail:   { pdf_name: pdfName, business_name: ourName },
  }
}

/** Critical: extracted periods must include the period the user claimed. */
function checkPeriodMatch(e: ExtractionForValidation, ctx: ValidationContext): ValidationFinding | null {
  const claimed = ctx.claimedPeriod
  if (!claimed?.year || claimed.month == null) return null
  const matched = e.periods.some(p => p.year === claimed.year && p.month === claimed.month)
  if (matched) return null
  // The PDF may legitimately cover other periods (multi-month). Differentiate.
  const periodsLabel = e.periods.map(p => `${p.year}-${String(p.month).padStart(2, '0')}`).join(', ') || '(none)'
  const claimedLabel = `${claimed.year}-${String(claimed.month).padStart(2, '0')}`
  return {
    code:     'period_mismatch',
    severity: 'error',
    message:  `You selected ${claimedLabel} but this PDF covers ${periodsLabel}. Pick the correct period or re-upload the right file.`,
    detail:   { claimed: claimedLabel, extracted: e.periods.map(p => ({ year: p.year, month: p.month })) },
    override_allowed: false,
  }
}

/** Sanity: period years within the last 10 / next 1 year. Anything else is almost certainly wrong. */
function checkPeriodInReasonableRange(e: ExtractionForValidation, ctx: ValidationContext): ValidationFinding[] {
  const now = ctx.now ?? new Date()
  const thisYear = now.getUTCFullYear()
  const out: ValidationFinding[] = []
  for (const p of e.periods) {
    if (p.year < thisYear - 10 || p.year > thisYear + 1) {
      out.push({
        code:     'period_year_out_of_range',
        severity: 'error',
        message:  `Period year ${p.year} is outside the reasonable range (${thisYear - 10}–${thisYear + 1}). Probably a parser or PDF error.`,
        detail:   { year: p.year, this_year: thisYear },
      })
    }
    if (p.month < 0 || p.month > 12) {
      out.push({
        code:     'period_month_out_of_range',
        severity: 'error',
        message:  `Period month ${p.month} is invalid (must be 0–12).`,
        detail:   { month: p.month },
      })
    }
  }
  return out
}

/** If the extraction is multi-month but the user claimed a single month,
 *  surface that explicitly so they don't accidentally apply 12 months
 *  of data thinking it's one. */
function checkDocTypeVsClaimedPeriod(e: ExtractionForValidation, ctx: ValidationContext): ValidationFinding | null {
  if (!ctx.claimedPeriod?.month) return null
  if (e.doc_type === 'pnl_monthly') return null
  if (e.periods.length > 1) {
    return {
      code:     'multi_month_but_claimed_single',
      severity: 'warning',
      message:  `This is a ${e.doc_type ?? 'multi-month'} report covering ${e.periods.length} periods. Applying will write all of them — confirm that's intended.`,
      detail:   { doc_type: e.doc_type, period_count: e.periods.length },
    }
  }
  return null
}

/** Costs / revenue should be non-negative. financial is signed (interest expense = negative). */
function checkSignConvention(e: ExtractionForValidation): ValidationFinding[] {
  const out: ValidationFinding[] = []
  for (const p of e.periods) {
    const r = p.rollup ?? {}
    const period = `${p.year}-${String(p.month).padStart(2, '0')}`
    if ((r.revenue ?? 0) < 0)       out.push(sign(period, 'revenue', r.revenue!))
    if ((r.food_cost ?? 0) < 0)     out.push(sign(period, 'food_cost', r.food_cost!))
    if ((r.staff_cost ?? 0) < 0)    out.push(sign(period, 'staff_cost', r.staff_cost!))
    if ((r.alcohol_cost ?? 0) < 0)  out.push(sign(period, 'alcohol_cost', r.alcohol_cost!))
    if ((r.other_cost ?? 0) < 0)    out.push(sign(period, 'other_cost', r.other_cost!))
    if ((r.depreciation ?? 0) < 0)  out.push(sign(period, 'depreciation', r.depreciation!))
    // net_profit > revenue is impossible
    if (r.revenue != null && r.net_profit != null && r.net_profit > r.revenue) {
      out.push({
        code:     'net_profit_exceeds_revenue',
        severity: 'error',
        message:  `${period}: net_profit (${fmtKr(r.net_profit)}) exceeds revenue (${fmtKr(r.revenue)}). Sign or scale error.`,
        detail:   { period, net_profit: r.net_profit, revenue: r.revenue },
      })
    }
  }
  return out
}

function sign(period: string, field: string, value: number): ValidationFinding {
  return {
    code:     'negative_value',
    severity: 'error',
    message:  `${period}: ${field} is negative (${fmtKr(value)}). Storage convention requires positive costs/revenue.`,
    detail:   { period, field, value },
  }
}

/** rollup.net_profit ≈ revenue − food − staff − alcohol − other − depreciation + financial. */
function checkMathConsistency(e: ExtractionForValidation): ValidationFinding[] {
  const out: ValidationFinding[] = []
  const TOLERANCE = 5    // kr — round-trip rounding
  for (const p of e.periods) {
    const r = p.rollup ?? {}
    if (r.revenue == null || r.net_profit == null) continue
    const computed =
      (r.revenue ?? 0) -
      (r.food_cost ?? 0) -
      (r.staff_cost ?? 0) -
      (r.alcohol_cost ?? 0) -
      (r.other_cost ?? 0) -
      (r.depreciation ?? 0) +
      (r.financial ?? 0)
    const diff = Math.abs(computed - r.net_profit)
    if (diff > TOLERANCE) {
      out.push({
        code:     'math_inconsistency',
        severity: 'warning',
        message:  `${p.year}-${String(p.month).padStart(2, '0')}: stated net_profit ${fmtKr(r.net_profit)} but components sum to ${fmtKr(computed)} (diff ${fmtKr(diff)}). Likely a missing component or extraction error.`,
        detail:   { stated: r.net_profit, computed, diff },
      })
    }
  }
  return out
}

/** Compare new revenue / staff / food to prior 6-month median. Outside ±50 % = anomaly. */
function checkScaleAnomaly(e: ExtractionForValidation, ctx: ValidationContext): ValidationFinding[] {
  if (!ctx.history || ctx.history.length < 3) return []     // need a stable baseline
  const out: ValidationFinding[] = []
  const med = (vs: number[]) => {
    const s = vs.filter(v => v > 0).slice().sort((a, b) => a - b)
    if (!s.length) return null
    return s[Math.floor(s.length / 2)]
  }
  const medRev   = med(ctx.history.map(h => h.revenue))
  const medStaff = med(ctx.history.map(h => h.staff_cost))
  const medFood  = med(ctx.history.map(h => h.food_cost))

  for (const p of e.periods) {
    const r = p.rollup ?? {}
    const period = `${p.year}-${String(p.month).padStart(2, '0')}`
    out.push(...anomaly('revenue',    r.revenue,    medRev,   period))
    out.push(...anomaly('staff_cost', r.staff_cost, medStaff, period))
    out.push(...anomaly('food_cost',  r.food_cost,  medFood,  period))
  }
  return out
}

function anomaly(field: string, value: number | undefined, median: number | null, period: string): ValidationFinding[] {
  if (value == null || median == null || median <= 0) return []
  const ratio = value / median
  if (ratio < 0.5 || ratio > 2.0) {
    return [{
      code:     'scale_anomaly',
      severity: 'warning',
      message:  `${period}: ${field} ${fmtKr(value)} is ${formatRatio(ratio)} of the recent median (${fmtKr(median)}). Possible scale error or genuine anomaly — verify before applying.`,
      detail:   { period, field, value, median, ratio },
    }]
  }
  return []
}

/** Warn if the immediately-prior period is missing (gap in the timeline). */
function checkPeriodGap(e: ExtractionForValidation, ctx: ValidationContext): ValidationFinding[] {
  if (!ctx.existingPeriods || ctx.existingPeriods.size === 0) return []
  const out: ValidationFinding[] = []
  const seen = new Set<string>()
  for (const p of e.periods) {
    if (p.month === 0) continue
    const prior = priorMonth(p.year, p.month)
    const key   = `${prior.y}-${String(prior.m).padStart(2, '0')}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!ctx.existingPeriods.has(key)) {
      out.push({
        code:     'period_gap',
        severity: 'info',
        message:  `Heads-up: applying ${p.year}-${String(p.month).padStart(2, '0')} but ${key} has no Fortnox data. Forecasts will use partial history.`,
        detail:   { applying: `${p.year}-${String(p.month).padStart(2, '0')}`, missing_prior: key },
      })
    }
  }
  return out
}

/** dine_in + takeaway + alcohol revenue must each be ≤ total revenue.
 *  Sum of subsets MUST NOT exceed revenue (would mean double-count). */
function checkSubsetCaps(e: ExtractionForValidation): ValidationFinding[] {
  const out: ValidationFinding[] = []
  for (const p of e.periods) {
    const r: any = p.rollup ?? {}
    const total = r.revenue ?? 0
    if (total <= 0) continue
    const period = `${p.year}-${String(p.month).padStart(2, '0')}`
    for (const k of ['dine_in_revenue', 'takeaway_revenue', 'alcohol_revenue'] as const) {
      const v = r[k] ?? 0
      if (v > total + 1) {
        out.push({
          code:     'revenue_subset_exceeds_total',
          severity: 'error',
          message:  `${period}: ${k} (${fmtKr(v)}) exceeds total revenue (${fmtKr(total)}). VAT classifier must have double-counted.`,
          detail:   { period, field: k, value: v, revenue: total },
        })
      }
    }
    const subsetSum = (r.dine_in_revenue ?? 0) + (r.takeaway_revenue ?? 0) + (r.alcohol_revenue ?? 0)
    if (subsetSum > total + 5) {
      out.push({
        code:     'revenue_subsets_sum_exceeds_total',
        severity: 'warning',
        message:  `${period}: dine-in + takeaway + alcohol = ${fmtKr(subsetSum)} but total revenue = ${fmtKr(total)}. Probably a VAT-row double-count.`,
        detail:   { period, subset_sum: subsetSum, revenue: total },
      })
    }
  }
  return out
}

// ── small helpers ─────────────────────────────────────────────────────

function fmtKr(n: number): string {
  return Math.round(n).toLocaleString('en-GB').replace(/,/g, ' ') + ' kr'
}
function formatOrgNr(s: string): string {
  return s.length === 10 ? `${s.slice(0, 6)}-${s.slice(6)}` : s
}
function formatRatio(r: number): string {
  if (r >= 1) return `${r.toFixed(1)}×`
  return `${Math.round(r * 100)}%`
}
function normaliseName(s: string): string {
  return s.toLowerCase().replace(/\b(ab|aktiebolag|hb|kb|enskild firma|as)\b/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}
function priorMonth(y: number, m: number): { y: number; m: number } {
  if (m === 1) return { y: y - 1, m: 12 }
  return { y, m: m - 1 }
}
