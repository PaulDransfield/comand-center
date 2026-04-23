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
export const FORECAST_ANCHOR = `FORECAST ANCHORING:
- Anchor every monthly prediction on the same calendar month of the PRIOR YEAR's actual revenue (not YTD, not a generic seasonality curve).
- Maximum stretch above prior-year actual: +15%. Stretches above this must be justified with a concrete reason (e.g. confirmed new revenue stream, documented price rise).
- The CURRENT calendar month is never a valid anchor — partial-month data is not comparable.
- If prior-year data for a month is missing OR shows staff_cost > 0 with revenue = 0, treat it as a data gap (skip or interpolate from nearest populated month in BOTH directions), not hibernation.`

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
