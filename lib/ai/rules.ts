// lib/ai/rules.ts
//
// Shared domain rules used across every CommandCenter AI surface.
//
// Before this file, food-cost floors, staff caps, margin targets, the
// "cuts only, never adds" scheduling rule, Swedish tone, SEK formatting
// and the "no preamble" convention were copy-pasted across 5+ prompts.
// When we tightened one of them (e.g. the historical-anchor rule for the
// budget AI) the fix only landed where someone remembered to update it.
//
// Import the constant you need into your prompt. Use composeRules() when
// you want several standard blocks concatenated at the top of a prompt.
//
// Pair with lib/ai/scope.ts — SCOPE_NOTE lives there because it's a
// different concern (data-attribution correctness). This file is about
// domain heuristics and voice.

// ── Industry benchmarks for Swedish casual-dining restaurants ────────────────
// These are the guard rails every numerical AI answer should respect. If the
// app computes a number outside these bands it's either a data bug or a
// meaningful signal — either way the AI should flag it, not normalise it.
export const INDUSTRY_BENCHMARKS = `SWEDISH RESTAURANT BENCHMARKS (casual dining):
- Food cost: 28–32% of revenue (below 28% is suspicious; above 35% is a problem)
- Staff cost: 28–42% of revenue (aim for 30–35%; above 42% is unsustainable)
- Other costs (rent, utilities, software): 15–25% of revenue
- Operating margin (net profit): 8–15% of revenue is healthy; below 5% is thin
- OB supplement: typically 3–8% of staff cost (Swedish weekend/evening premium)`

// ── Scheduling rule — asymmetric by policy ───────────────────────────────────
// The AI may recommend CUTTING labour hours where history shows over-staffing.
// It must NEVER recommend ADDING hours. Why: a cut that's wrong loses coverage
// for one shift (recoverable). Add-suggestions that are wrong create fixed
// labour liability on days when demand doesn't materialise — cash burn that
// can't be recovered. Owners use this app to reduce risk, not add it.
export const SCHEDULING_ASYMMETRY = `SCHEDULING RULE — ASYMMETRIC:
- You may recommend CUTTING labour hours when history shows over-staffing.
- You must NEVER recommend adding hours. Write "no change" or note that the day looks lighter than the 12-week pattern and flag it as a judgment call for the owner.
- A wrong cut loses one shift of coverage (recoverable). A wrong add creates fixed labour liability on a slow day (cash burn, non-recoverable). Default to cuts-only.`

// ── Swedish labour compliance (statute + Visita–HRF agreement) ───────────────
// Built from the canonical ruleset in lib/scheduling/labor-rules-sweden.ts so
// the AI's suggestions and the pre-publish compliance engine can never drift.
// Two jobs in the prompt:
//   1. HARD CONSTRAINTS the AI must never propose a change that breaks.
//      (Cuts inherently only increase rest, so they're safe; but extend /
//      reassign / swap_template CAN break rest/hours — those must comply.)
//   2. OB AWARENESS — evenings/weekends/nights carry an inconvenient-hours
//      premium, so when choosing WHAT to trim, prefer those bands: same hour
//      cut saves more money there.
import {
  type LaborConfig, DEFAULT_LABOR_CONFIG, resolveLimits, OB_BANDS_DESCRIPTION,
} from '@/lib/scheduling/labor-rules-sweden'

export function swedishLabourCompliance(config: LaborConfig = DEFAULT_LABOR_CONFIG): string {
  const L = resolveLimits(config)
  const lines: string[] = [
    'SWEDISH LABOUR COMPLIANCE — non-negotiable constraints on any roster change:',
    `- Daily rest (Arbetstidslagen §13): every employee must get ≥${L.minDailyRestH}h continuous rest per 24h. Never propose a change that leaves <${L.minDailyRestH}h between an employee's consecutive shifts.`,
    `- Weekly rest (ATL §14): ≥${L.minWeeklyRestH}h continuous rest per 7-day period — keep at least one clear rest block per person per week (don't propose a 7th straight day).`,
    `- Max weekly hours (ATL §10b): ≤${L.maxWeeklyH}h/week. Ordinary full-time is ${L.ordinaryWeeklyH}h.`,
  ]
  if (L.maxHoursPer24h != null) {
    lines.push(`- Max shift length (Visita–HRF Gröna Riksavtalet): working time may not exceed ${L.maxHoursPer24h}h per 24h (excl. breaks). Don't propose extending a shift past ${L.maxHoursPer24h}h.`)
  }
  lines.push('- Rast (ATL §15): a shift longer than 6h needs a break; never remove a break to "save" cost.')
  if (config.enforce_minor_rules) {
    lines.push('- MINORS (under 18, AFS 2012:3 — a collective agreement can NOT weaken these): no work 22:00–06:00, ≤8h/day, ≤40h/week, ≥12h daily rest. Never schedule a minor into a night/closing shift.')
  }
  lines.push(
    'These limits can only ever be IMPROVED by a cut (more rest, fewer hours), so cuts are always safe. For extend / reassign / swap suggestions, verify the limits still hold for the affected person.',
    `OB COST AWARENESS: ${OB_BANDS_DESCRIPTION} When two cuts save similar coverage, prefer the one removing more OB hours — it saves more kr. Mention in your reasoning when a cut lands on OB hours.`,
  )
  return lines.join('\n')
}

/** Default block for businesses on the Visita–HRF agreement with minors off. */
export const SWEDISH_LABOUR_COMPLIANCE = swedishLabourCompliance()

// ── Voice ────────────────────────────────────────────────────────────────────
// Swedish restaurant owners reading a Monday memo don't want marketing copy
// or American-consultancy hedging. Direct, owner-to-owner, no fluff.
export const VOICE = `TONE & VOICE:
- Owner-to-owner, direct, no preamble. Skip "Here's the analysis…" and start with the finding.
- Swedish restaurant context — use SEK formatting with a thin space ("142 350 kr"), not "$142k" or "SEK 142,350".
- Weekdays in English (Mon/Tue/Wed). Dates as YYYY-MM-DD when machine-readable, "23 Apr" when prose.
- Numbers are rounded to the precision that matters: kr to the nearest 100 for weekly figures, to the nearest 1000 for monthly, 0 decimals for percentages unless the difference is under 1%.
- Don't apologise for missing data — say what you have and what it would take to fill the gap.`

// ── Budget / forecast anchoring ──────────────────────────────────────────────
// Lesson from FIXES + the 2026-04 budget-AI rewrite: forecasts that extrapolate
// from YTD or generic "%-growth" assumptions overshoot badly. Always anchor on
// prior-year ACTUAL monthly revenue, cap the stretch at +15%, and explicitly
// detect data-gap months instead of silently averaging through them.
//
// EXCEPT for businesses with stage='new' (M046). They've been operating <12 mo
// so there IS no prior year; anchoring on zeros produces actively misleading
// budgets. Use forecastAnchorFor(stage) — picks the right ruleset.
export const FORECAST_ANCHOR_ESTABLISHED = `FORECAST ANCHORING:
- Anchor every monthly prediction on the same calendar month of the PRIOR YEAR's actual revenue (not YTD, not a generic seasonality curve).
- Maximum stretch above prior-year actual: +15%. Stretches above this must be justified with a concrete reason (e.g. confirmed new revenue stream, documented price rise).
- The CURRENT calendar month is never a valid anchor — partial-month data is not comparable.
- If prior-year data for a month is missing OR shows staff_cost > 0 with revenue = 0, treat it as a data gap (skip or interpolate from nearest populated month in BOTH directions), not hibernation.`

export const FORECAST_ANCHOR_NEW = `FORECAST ANCHORING (NEW BUSINESS):
- This business is in stage='new' — it has been operating less than 12 months. There is NO prior year of actual revenue to anchor on. Do NOT apply the standard prior-year-anchor rule.
- Build budgets / forecasts from:
  (a) the most recent 4-8 weeks of actual revenue, trended forward week-by-week (not month-by-month)
  (b) industry benchmark cost ratios (food 28-32%, staff 28-42%, other 15-25%) applied to the projected revenue
  (c) any owner-supplied targets in budgets — those override (a)+(b)
- DO NOT extrapolate from YTD totals as a "growth rate" — early-stage trajectory is too noisy.
- Flag explicitly that the budget is a new-business projection without a historical anchor — owner should treat it as directional, not precise.`

/**
 * Pick the right forecast-anchor rule based on the business's stage (M046).
 * Default → ESTABLISHED (safe for legacy businesses without stage set).
 */
export function forecastAnchorFor(businessStage: string | null | undefined): string {
  return businessStage === 'new' ? FORECAST_ANCHOR_NEW : FORECAST_ANCHOR_ESTABLISHED
}

/** Deprecated — kept for back-compat. Prefer forecastAnchorFor(stage). */
export const FORECAST_ANCHOR = FORECAST_ANCHOR_ESTABLISHED

// ── Data-gap honesty ─────────────────────────────────────────────────────────
// Silent imputation is worse than visible gaps. If the AI doesn't have the
// number needed to answer a question properly, it should say so clearly.
export const DATA_GAPS = `DATA GAPS — BE HONEST:
- If you don't have the data needed to answer a question at the requested scope, say so. Do not invent, extrapolate silently, or blend business-level data into a department answer.
- Flag Fortnox-vs-POS discrepancies (e.g. POS revenue differs materially from Fortnox "Intäkter") rather than picking one without comment.
- When giving a number, cite where it came from: "Fortnox Resultatrapport", "PK /sales/ last 60 days", "manual tracker entry", etc.`

// ── Compose helper ───────────────────────────────────────────────────────────
// Most prompts want 2–3 of the above. composeRules(INDUSTRY_BENCHMARKS, VOICE)
// gives you a properly-separated block to paste into a system prompt.
export function composeRules(...blocks: string[]): string {
  return blocks.filter(Boolean).join('\n\n')
}
