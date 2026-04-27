// lib/ai/contextBuilder.ts
//
// Reusable context assembly for /api/ask and future AI surfaces that take a
// freeform question + structured data. Centralises two responsibilities that
// used to live inline in the ask route:
//
//   1. Truncate the caller's page-provided context to a sensible budget.
//   2. Auto-enrich based on question keywords. Each enrichment is opt-in
//      (keyword-triggered), small (~600 chars), and shares a global enrichment
//      budget so a question matching multiple keywords still fits.
//
// Returns the composed context string plus metadata about what was added
// and what was truncated, so the caller can log / surface that to the user
// if they want. Never throws — enrichment failures degrade to the base
// context unchanged.
//
// Enrichment catalogue (FIXES.md §0y — full sweep added 2026-04-27 after
// the "AI says no Week 18 data" report. Pages no longer have to pre-fetch
// historical / forecast / comparison data into their inline summary; if
// the question matches the keyword, the enrichment lands automatically):
//
//   COST       — last 12 months of tracker_line_items (other_cost). Pre-existing.
//   FORECAST   — current-year forecasts table + prior-year actuals for the same months.
//   COMPARISON — same-period-last-year monthly_metrics for YoY anchoring.
//   TREND      — last 6 months of monthly_metrics for rolling-direction questions.
//   ANOMALY    — last 30 days of anomaly_alerts (un-dismissed) for "why did X" questions.
//   DEPARTMENT — current-year dept_metrics so business-wide pages can answer dept questions.
//
// Multiple enrichments can fire on a single question; the budget is shared
// proportionally. Add new enrichments by following the same pattern: export
// the keyword regex, add a fetcher that returns a string block, slot it into
// the composer below.
//
// The dead lib/ai/buildContext.ts was an older, never-wired draft of this.
// This file replaces it. If you find buildContext.ts still lingering, it's
// safe to delete.

type Db = any

// Keyword regexes. Matches both English and the Swedish vocabulary the
// owners use day-to-day. Expand conservatively — false positives bloat the
// prompt and slow Claude's response.
export const COST_KEYWORDS       = /\b(cost|overhead|overheads|subscription|subscribe|bank|fees|fee|rent|lokalhyra|software|saas|bokio|fortnox|insurance|försäkring|prenumeration|utilit|electric|marketing|accounting|audit|margin|other[_\s]cost|line[_\s]item)s?\b/i
export const FORECAST_KEYWORDS   = /\b(forecast|predict|prediction|next\s*(week|month|quarter)|upcoming|expect|expected|will\s+i|going\s+to|project(ed|ion)?|hours?\s+to\s+cut|labour\s*%|coming\s+(week|month))\b/i
export const COMPARISON_KEYWORDS = /\b(compare|vs|versus|same\s+(week|month|period|time)\s+last\s+year|year[\s-]*over[\s-]*year|yoy|growth|vs\.?\s+last\s+year|vs\.?\s+(jan|feb|mar|apr|maj|may|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{4})\b/i
export const TREND_KEYWORDS      = /\b(trend|trending|rolling|last\s+(4|6|8|12)\s+(weeks|months)|getting\s+(better|worse)|declin(ing|e)|improv(ing|ed)|momentum|trajectory|over\s+time)\b/i
export const ANOMALY_KEYWORDS    = /\b(why\s+(is|did|are)|what\s+(changed|happened)|reason|cause|caus(ed|es)|anomal|unusual|spike|surge|drop(ped)?|jump(ed)?|crash(ed)?|out\s+of\s+line)\b/i
export const DEPARTMENT_KEYWORDS = /\b(department|departments|dept|kitchen|bar|bella|carne|asp|which\s+(area|location)|by\s+dept|per\s+department|location\s+breakdown|each\s+location)\b/i

export interface BuildContextOptions {
  /** Total prompt-context character budget. Default 8000 (~3 200 input tokens). */
  maxChars?: number
  /** Total budget across ALL enrichments. Default 3000 — shared if multiple fire. */
  enrichmentBudget?: number
  /** Pass the authorised orgId so we can filter by tenant. */
  orgId: string
  /** Business to scope enrichments to. Most enrichments skip when null. */
  businessId: string | null
}

export type EnrichmentTag = 'cost' | 'forecast' | 'comparison' | 'trend' | 'anomaly' | 'department'

export interface BuiltContext {
  context: string
  baseTruncated: boolean
  /** Every enrichment that fired (multiple possible). */
  enrichmentsApplied: EnrichmentTag[]
  /** Subset of enrichmentsApplied that hit the budget cap. */
  enrichmentsTruncated: EnrichmentTag[]
  warnings: string[]
  /** @deprecated use enrichmentsApplied. Kept for backwards compatibility. */
  enrichmentApplied: EnrichmentTag | null
  /** @deprecated use enrichmentsTruncated. Kept for backwards compatibility. */
  enrichmentTruncated: boolean
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return Math.round(Number(n)).toLocaleString('en-GB').replace(/,/g, ' ')
}

export async function buildAskContext(
  db: Db,
  rawContext: string,
  question: string,
  opts: BuildContextOptions,
): Promise<BuiltContext> {
  const maxChars         = opts.maxChars ?? 8000
  const enrichmentBudget = opts.enrichmentBudget ?? 3000
  const baseBudget       = maxChars - enrichmentBudget

  let context = (rawContext ?? '').trim()
  const warnings: string[] = []
  let baseTruncated = false

  if (context.length > baseBudget) {
    warnings.push(`context truncated — was ${context.length} chars, capped at ${baseBudget}`)
    context = context.slice(0, baseBudget) + '\n\n[context truncated for cost]'
    baseTruncated = true
  }

  const enrichmentsApplied: EnrichmentTag[] = []
  const enrichmentsTruncated: EnrichmentTag[] = []
  let remainingBudget = enrichmentBudget

  // Helper to attach a block to context with shared-budget accounting.
  const attach = (tag: EnrichmentTag, block: string) => {
    if (!block) return
    const trimmed = block.length > remainingBudget
      ? block.slice(0, Math.max(0, remainingBudget - 30)) + '\n[truncated]'
      : block
    context += trimmed
    remainingBudget -= trimmed.length
    enrichmentsApplied.push(tag)
    if (block.length > remainingBudget + trimmed.length) enrichmentsTruncated.push(tag)
  }

  // ── COST ENRICHMENT ───────────────────────────────────────────────────────
  // 12 months of tracker_line_items in the other_cost bucket. Pre-existing
  // since session 12; pulled into the new shared-budget composer for
  // consistency.
  if (opts.businessId && remainingBudget > 200 && COST_KEYWORDS.test(question)) {
    try {
      const yearFrom = new Date().getFullYear() - 1
      const { data: lines } = await db
        .from('tracker_line_items')
        .select('period_year, period_month, category, subcategory, label_sv, amount')
        .eq('org_id',      opts.orgId)
        .eq('business_id', opts.businessId)
        .eq('category',    'other_cost')
        .gte('period_year', yearFrom)
        .order('period_year', { ascending: false })
        .order('period_month', { ascending: false })
        .order('amount',      { ascending: false })
        .limit(60)
      if (lines?.length) {
        const formatted = lines
          .map((l: any) => {
            const period = l.period_month && l.period_month > 0
              ? `${MONTHS[l.period_month - 1]} ${l.period_year}`
              : `${l.period_year} (annual)`
            const sub = l.subcategory ? ` [${l.subcategory}]` : ''
            return `  - ${period}: ${l.label_sv}${sub} — ${fmt(l.amount)} kr`
          })
          .join('\n')
        attach('cost', `\n\nOverhead line items (other_cost, from Fortnox PDFs — BUSINESS-WIDE, not split by department):\n${formatted}`)
      }
    } catch (e: any) { warnings.push('cost enrichment failed: ' + (e?.message ?? 'unknown')) }
  }

  // ── FORECAST ENRICHMENT ───────────────────────────────────────────────────
  // The full forecasts table for current year + last year's actuals for the
  // same months, so Claude has both the model output and a reality check.
  // Triggers on questions like "predict Week 18", "next month", "hours to cut".
  if (opts.businessId && remainingBudget > 200 && FORECAST_KEYWORDS.test(question)) {
    try {
      const now = new Date()
      const yNow  = now.getUTCFullYear()
      const yPrev = yNow - 1
      const [forecastsRes, priorActualsRes] = await Promise.all([
        db.from('forecasts')
          .select('period_year, period_month, revenue_forecast, staff_cost_forecast, food_cost_forecast, net_profit_forecast, margin_forecast, based_on_months')
          .eq('org_id', opts.orgId).eq('business_id', opts.businessId)
          .eq('period_year', yNow)
          .order('period_month', { ascending: true }),
        db.from('monthly_metrics')
          .select('year, month, revenue, staff_cost, net_profit, margin_pct')
          .eq('org_id', opts.orgId).eq('business_id', opts.businessId)
          .eq('year', yPrev)
          .order('month', { ascending: true }),
      ])
      const forecasts = forecastsRes.data ?? []
      const priors    = priorActualsRes.data ?? []
      if (forecasts.length || priors.length) {
        const priorByMonth: Record<number, any> = {}
        for (const p of priors) priorByMonth[p.month] = p
        const lines = forecasts.map((f: any) => {
          const prior = priorByMonth[f.period_month]
          const priorStr = prior
            ? ` | ${yPrev} actual: ${fmt(prior.revenue)} kr (margin ${prior.margin_pct ?? '—'}%)`
            : ` | ${yPrev}: no data`
          return `  - ${MONTHS[f.period_month - 1]} ${f.period_year}: forecast ${fmt(f.revenue_forecast)} kr (margin ${f.margin_forecast ?? '—'}%, based on ${f.based_on_months} months)${priorStr}`
        }).join('\n')
        attach('forecast', `\n\nForecasts for ${yNow} (from forecasts table, model = trailing average + seasonality) — alongside ${yPrev} actuals for anchoring:\n${lines}\n[Note: forecasts are point estimates. Same-week-last-year is a more reliable single anchor than the model average.]`)
      }
    } catch (e: any) { warnings.push('forecast enrichment failed: ' + (e?.message ?? 'unknown')) }
  }

  // ── COMPARISON ENRICHMENT ─────────────────────────────────────────────────
  // Same period last year. Without this, "vs same time last year" / "YoY"
  // questions get a "no historical baseline available" reply.
  if (opts.businessId && remainingBudget > 200 && COMPARISON_KEYWORDS.test(question)) {
    try {
      const now = new Date()
      const yPrev = now.getUTCFullYear() - 1
      const { data: prior } = await db
        .from('monthly_metrics')
        .select('year, month, revenue, staff_cost, food_cost, net_profit, margin_pct, labour_pct')
        .eq('org_id', opts.orgId).eq('business_id', opts.businessId)
        .eq('year', yPrev)
        .order('month', { ascending: true })
      if (prior?.length) {
        const lines = prior.map((p: any) =>
          `  - ${MONTHS[p.month - 1]} ${p.year}: revenue ${fmt(p.revenue)} kr | staff ${fmt(p.staff_cost)} kr (${p.labour_pct ?? '—'}%) | margin ${p.margin_pct ?? '—'}%`
        ).join('\n')
        attach('comparison', `\n\nPrior-year reference (${yPrev} monthly actuals — use to compute YoY % deltas):\n${lines}`)
      }
    } catch (e: any) { warnings.push('comparison enrichment failed: ' + (e?.message ?? 'unknown')) }
  }

  // ── TREND ENRICHMENT ──────────────────────────────────────────────────────
  // Last 6 months of monthly_metrics. Lets Claude answer "is X getting
  // better/worse" without each page having to pre-fetch a rolling window.
  if (opts.businessId && remainingBudget > 200 && TREND_KEYWORDS.test(question)) {
    try {
      const now = new Date()
      const sixAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, 1))
      const yMin = sixAgo.getUTCFullYear()
      const { data: trail } = await db
        .from('monthly_metrics')
        .select('year, month, revenue, staff_cost, labour_pct, margin_pct')
        .eq('org_id', opts.orgId).eq('business_id', opts.businessId)
        .gte('year', yMin)
        .order('year', { ascending: true })
        .order('month', { ascending: true })
      const recent = (trail ?? []).filter((r: any) => {
        const d = new Date(Date.UTC(r.year, r.month - 1, 1))
        return d >= sixAgo
      }).slice(-6)
      if (recent.length) {
        const lines = recent.map((r: any) =>
          `  - ${MONTHS[r.month - 1]} ${r.year}: revenue ${fmt(r.revenue)} kr | labour ${r.labour_pct ?? '—'}% | margin ${r.margin_pct ?? '—'}%`
        ).join('\n')
        attach('trend', `\n\nLast 6 months trend (oldest first — compute direction from this):\n${lines}`)
      }
    } catch (e: any) { warnings.push('trend enrichment failed: ' + (e?.message ?? 'unknown')) }
  }

  // ── ANOMALY ENRICHMENT ────────────────────────────────────────────────────
  // Recent un-dismissed anomaly_alerts. Lets Claude give a real answer to
  // "why did revenue drop last week" instead of inventing one.
  if (opts.businessId && remainingBudget > 200 && ANOMALY_KEYWORDS.test(question)) {
    try {
      const since = new Date(Date.now() - 30 * 86400_000).toISOString()
      const { data: alerts } = await db
        .from('anomaly_alerts')
        .select('alert_type, severity, title, description, metric_value, expected_value, period_date, created_at')
        .eq('org_id', opts.orgId).eq('business_id', opts.businessId)
        .eq('is_dismissed', false)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(15)
      if (alerts?.length) {
        const lines = alerts.map((a: any) => {
          const dev = a.expected_value > 0
            ? Math.round(((a.metric_value - a.expected_value) / a.expected_value) * 100)
            : null
          const devStr = dev != null ? ` (${dev > 0 ? '+' : ''}${dev}% vs expected)` : ''
          return `  - [${a.severity}] ${a.period_date ?? a.created_at?.slice(0, 10)} ${a.title}${devStr}: ${a.description ?? ''}`
        }).join('\n')
        attach('anomaly', `\n\nRecent anomaly_alerts (last 30 days, un-dismissed — these are AI-detected flags with comparison context):\n${lines}`)
      }
    } catch (e: any) { warnings.push('anomaly enrichment failed: ' + (e?.message ?? 'unknown')) }
  }

  // ── DEPARTMENT ENRICHMENT ─────────────────────────────────────────────────
  // dept_metrics for current year. Pages like /dashboard and /tracker are
  // business-wide; without this, "how is the bar doing?" returns "I only
  // have business-wide data". Note: dept_metrics has revenue + staff_cost
  // only — food_cost / overheads stay business-wide per SCOPE_NOTE.
  if (opts.businessId && remainingBudget > 200 && DEPARTMENT_KEYWORDS.test(question)) {
    try {
      const yNow = new Date().getUTCFullYear()
      const { data: depts } = await db
        .from('dept_metrics')
        .select('dept_name, year, month, revenue, staff_cost, labour_pct, gp_pct')
        .eq('org_id', opts.orgId).eq('business_id', opts.businessId)
        .eq('year', yNow)
        .order('month', { ascending: false })
        .limit(60)
      if (depts?.length) {
        // Group by department, show the most recent 3 months per dept.
        const byDept: Record<string, any[]> = {}
        for (const d of depts) {
          if (!byDept[d.dept_name]) byDept[d.dept_name] = []
          if (byDept[d.dept_name].length < 3) byDept[d.dept_name].push(d)
        }
        const lines = Object.entries(byDept).map(([name, rows]) => {
          const monthsStr = rows.map((r: any) =>
            `${MONTHS[r.month - 1]} rev ${fmt(r.revenue)} kr / staff ${fmt(r.staff_cost)} kr (labour ${r.labour_pct ?? '—'}%, GP ${r.gp_pct ?? '—'}%)`
          ).join(' · ')
          return `  - ${name}: ${monthsStr}`
        }).join('\n')
        attach('department', `\n\nDepartment breakdown (last 3 months per dept, current year — DEPT-level revenue + staff only; food_cost & overheads stay business-wide per SCOPE_NOTE):\n${lines}`)
      }
    } catch (e: any) { warnings.push('department enrichment failed: ' + (e?.message ?? 'unknown')) }
  }

  return {
    context,
    baseTruncated,
    enrichmentsApplied,
    enrichmentsTruncated,
    warnings,
    enrichmentApplied:   enrichmentsApplied[0] ?? null,
    enrichmentTruncated: enrichmentsTruncated.length > 0,
  }
}
