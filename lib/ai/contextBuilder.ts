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
export const FORECAST_KEYWORDS   = /\b(forecast(s|ed|ing)?|predict(s|ed|ion|ions|ing)?|next\s*(week|month|quarter)|this\s+week|upcoming|expect(s|ed|ing)?|will\s+(i|we|he|she|it|they|the)|going\s+to|gonna|project(s|ed|ion|ions|ing)?|hours?\s+to\s+cut|cut\s+hours?|hit\s+\d+\s*%|labour\s*%|staff\s*cost\s*(of|%|target)|coming\s+(week|month)|target|aim(ing)?\s+for|plan(ned|ning)?\s+for)\b/i
export const SCHEDULE_KEYWORDS   = /\b(schedul(e|ed|ing)|hours?\s+to\s+cut|cut\s+hours?|how\s+many\s+hours?|hit\s+\d+\s*%|staff\s+(this|next|the)\s+week|labour\s*%|labour\s+cost|overstaffed|understaffed|roster|shifts?\s+(this|next)|next\s+week|this\s+week)\b/i
export const COMPARISON_KEYWORDS = /\b(compare|comparison|vs|versus|same\s+(week|month|period|time|day)\s+last\s+year|year[\s-]*over[\s-]*year|yoy|growth|vs\.?\s+last\s+year|vs\.?\s+(jan|feb|mar|apr|maj|may|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{4}|how\s+does\s+.*compare|compared\s+to)\b/i
export const TREND_KEYWORDS      = /\b(trend(s|ing|ed)?|rolling|last\s+(4|6|8|12)\s+(weeks|months)|getting\s+(better|worse)|declin(ing|e|ed)|improv(ing|ed|ement)|momentum|trajectory|over\s+time|past\s+(few|3|4|6)\s+(weeks|months))\b/i
export const ANOMALY_KEYWORDS    = /\b(why\s+(is|did|are|was|were)|what\s+(changed|happened)|reason|cause(s|d|es)?|anomal(y|ies|ous)|unusual|spike(d|s)?|surge(d|s)?|drop(ped|s)?|jump(ed|s)?|crash(ed|es)?|out\s+of\s+line|off\s+vs)\b/i
export const DEPARTMENT_KEYWORDS = /\b(department(s)?|dept(s)?|kitchen|bar|bella|carne|asp|which\s+(area|location)|by\s+dept|per\s+department|location\s+breakdown|each\s+location)\b/i
export const BUDGET_KEYWORDS     = /\b(budget(s|ed)?|target(s|ed)?|on\s+(track|budget|target)|vs\s+plan|allowance|over\s*(budget|spend)|under\s*(budget|spend)|am\s+i\s+on|how\s+much\s+(can|left)|spend\s+vs)\b/i
export const ACCURACY_KEYWORDS   = /\b(accura(te|cy)|accurate|how\s+(off|wrong|right)|forecast\s+(error|accuracy|miss)|missed?\s+(by|the)|calibrat|how\s+reliable|trust(worthy)?\s+(is|the)\s+forecast|bias)\b/i
export const WEATHER_KEYWORDS    = /\b(weather|rain(y|s|ed|ing)?|sunny?|cold|hot|warm|temp(erature)?|forecast\s+(for|the)\s+(weekend|week)|will\s+(it|the\s+weather)|°c|degrees)\b/i
export const STAFF_INDIV_KEYWORDS = /\b(who(\s+is|\s+are|'s)?|which\s+(staff|employee|person|member)|individual|by\s+(staff|employee|person)|most\s+(expensive|hours|overtime|late)|overtime|late\s+(arrival|shifts?)|highest\s+(cost|hours))\b/i
export const GROUP_KEYWORDS      = /\b(which\s+(location|business|restaurant|venue|site)|all\s+(locations|businesses|sites)|across\s+(my|all|the)\s+(business|location|venue|restaurant)|group(\s+wide|-wide)?|portfolio|combined|aggregate|total\s+across)\b/i

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

export type EnrichmentTag =
  | 'cost' | 'forecast' | 'comparison' | 'trend' | 'anomaly' | 'department' | 'schedule'
  | 'budget' | 'pk_forecast' | 'accuracy' | 'weather' | 'staff_individual' | 'group' | 'food_lines' | 'staff_lines'
  | 'overhead_review'

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
  const maxChars         = opts.maxChars ?? 10000
  const enrichmentBudget = opts.enrichmentBudget ?? 5000
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

  // ── COST / FOOD-LINES / STAFF-LINES ENRICHMENT ────────────────────────────
  // tracker_line_items in the categories the question implies. Originally
  // this was other_cost only (session 12); now extended so "why is food cost
  // up" or "what's driving the staff line" get the same line-item drill.
  // Determined per-question by inspecting the keywords. Each category
  // returns its own block so Claude knows the scope.
  const wantsCostLines  = COST_KEYWORDS.test(question)
  const wantsFoodLines  = /\b(food\s+cost|cogs|inventory|råvar|råvaror|ingredient|leverant|supplier|ölet?|drycker|alcohol\s+cost)\b/i.test(question)
  const wantsStaffLines = /\b(staff\s+cost|payroll|wages?|salar(y|ies)|löner?|lönek|pension|payroll\s+tax|sociala\s+avgift)\b/i.test(question)
  const wantedLineCats = new Set<string>()
  if (wantsCostLines)  wantedLineCats.add('other_cost')
  if (wantsFoodLines)  wantedLineCats.add('food_cost')
  if (wantsStaffLines) wantedLineCats.add('staff_cost')
  if (opts.businessId && remainingBudget > 200 && wantedLineCats.size) {
    try {
      const yearFrom = new Date().getFullYear() - 1
      const { data: lines } = await db
        .from('tracker_line_items')
        .select('period_year, period_month, category, subcategory, label_sv, amount')
        .eq('org_id',      opts.orgId)
        .eq('business_id', opts.businessId)
        .in('category',    Array.from(wantedLineCats))
        .gte('period_year', yearFrom)
        .order('period_year', { ascending: false })
        .order('period_month', { ascending: false })
        .order('amount',      { ascending: false })
        .limit(80)
      if (lines?.length) {
        // Group by category so the AI can scope its answer.
        const byCat: Record<string, any[]> = {}
        for (const l of lines) {
          if (!byCat[l.category]) byCat[l.category] = []
          if (byCat[l.category].length < 25) byCat[l.category].push(l)
        }
        for (const [cat, rows] of Object.entries(byCat)) {
          const formatted = rows.map((l: any) => {
            const period = l.period_month && l.period_month > 0
              ? `${MONTHS[l.period_month - 1]} ${l.period_year}`
              : `${l.period_year} (annual)`
            const sub = l.subcategory ? ` [${l.subcategory}]` : ''
            return `  - ${period}: ${l.label_sv}${sub} — ${fmt(l.amount)} kr`
          }).join('\n')
          const tag: EnrichmentTag = cat === 'food_cost' ? 'food_lines' : cat === 'staff_cost' ? 'staff_lines' : 'cost'
          attach(tag, `\n\n${cat} line items (last 12 months from Fortnox PDFs — BUSINESS-WIDE, top 25 by amount):\n${formatted}`)
        }
      }
    } catch (e: any) { warnings.push('line-items enrichment failed: ' + (e?.message ?? 'unknown')) }
  }

  // ── OVERHEAD REVIEW ENRICHMENT (PR 4) ─────────────────────────────────────
  // Pending overhead-review flags + projected savings. Fires on the same
  // COST keywords as the line-item drill, plus "save" / "cut" / "where can
  // I" patterns that aren't strictly cost-vocabulary but mean the same
  // thing in conversation. Cheap (single small SELECT) and small (~150
  // tokens) so it's safe to land alongside other enrichments.
  const wantsSavingTalk = /\b(save|saving|cut|reduce|trim|where\s+can\s+i|opportunit)/i.test(question)
  if (opts.businessId && remainingBudget > 150 && (wantsCostLines || wantsSavingTalk)) {
    try {
      const { data: flags } = await db
        .from('overhead_flags')
        .select('supplier_name, amount_sek, flag_type, period_year, period_month, ai_explanation')
        .eq('org_id', opts.orgId)
        .eq('business_id', opts.businessId)
        .eq('resolution_status', 'pending')
      if (flags && flags.length > 0) {
        // Dedup latest amount per supplier — matches the dashboard math.
        const latestPer = new Map<string, { amount: number; flag_type: string; ai: string | null; key: number }>()
        for (const f of flags as any[]) {
          const periodKey = Number(f.period_year) * 100 + Number(f.period_month)
          const prev = latestPer.get(f.supplier_name)
          if (!prev || periodKey > prev.key) {
            latestPer.set(f.supplier_name, {
              amount:    Number(f.amount_sek ?? 0),
              flag_type: String(f.flag_type),
              ai:        f.ai_explanation ?? null,
              key:       periodKey,
            })
          }
        }
        const totalSavings = Array.from(latestPer.values()).reduce((s, v) => s + v.amount, 0)
        const top3 = Array.from(latestPer.entries())
          .sort((a, b) => b[1].amount - a[1].amount)
          .slice(0, 3)
        const top3Lines = top3.map(([name, v]) => {
          const aiBit = v.ai ? ` (${v.ai})` : ''
          return `  - ${name} — ${fmt(v.amount)} kr/mo (${v.flag_type})${aiBit}`
        }).join('\n')
        attach(
          'overhead_review',
          `\n\nOverhead-review queue (BUSINESS-WIDE, supplier-deduped): ${latestPer.size} pending flag${latestPer.size === 1 ? '' : 's'} worth ~${fmt(totalSavings)} kr/mo if all cancelled. Top 3:\n${top3Lines}\n[INSTRUCTION TO CLAUDE: when the user asks "where can I save?" or similar, use these flags as the concrete answer. They go to /overheads/review to make decisions. NEVER tell them to cut a specific item — present the options and let the owner decide.]`,
        )
      }
    } catch (e: any) { warnings.push('overhead-review enrichment failed: ' + (e?.message ?? 'unknown')) }
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
        attach('forecast', `\n\nForecasts for ${yNow} (from forecasts table, model = trailing average + seasonality) — alongside ${yPrev} actuals for anchoring:\n${lines}\n[INSTRUCTION TO CLAUDE: when the user asks a forward-looking question (predict, next week, hours to cut, hit X% labour) and the inline page context shows zero values for the future period — that's expected, the period hasn't happened yet. USE these forecasts (or prior-year same-month actual) as the revenue baseline. DO NOT respond "no data available" or ask the user for the forecast — you have it here. Pick the most relevant month from the table above based on what they asked.]`)
      }
    } catch (e: any) { warnings.push('forecast enrichment failed: ' + (e?.message ?? 'unknown')) }
  }

  // ── SCHEDULE ENRICHMENT ───────────────────────────────────────────────────
  // Forward-looking SCHEDULED shifts from staff_logs (where pk_log_url ends
  // in '_scheduled'). These are rosters posted for upcoming dates that the
  // aggregator deliberately excludes from `daily_metrics` (those track
  // ACTUALS only). Without this, the AI knows the revenue forecast but has
  // no visibility into what's already on the schedule, so it can't compute
  // "hours to cut to hit X% labour" — it has to ask the user.
  //
  // Sums: scheduled hours + estimated salary, by date, today + next 14 days.
  if (opts.businessId && remainingBudget > 200 && SCHEDULE_KEYWORDS.test(question)) {
    try {
      const today = new Date().toISOString().slice(0, 10)
      const horizon = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10)
      const { data: scheduled } = await db
        .from('staff_logs')
        .select('shift_date, hours_worked, estimated_salary, cost_actual, staff_group')
        .eq('org_id', opts.orgId).eq('business_id', opts.businessId)
        .gte('shift_date', today)
        .lte('shift_date', horizon)
        .like('pk_log_url', '%_scheduled')
        .order('shift_date', { ascending: true })
        .limit(2000)
      if (scheduled?.length) {
        const byDate: Record<string, { hours: number; cost: number; shifts: number }> = {}
        for (const s of scheduled) {
          const d = s.shift_date
          if (!byDate[d]) byDate[d] = { hours: 0, cost: 0, shifts: 0 }
          byDate[d].hours += Number(s.hours_worked ?? 0)
          // Use cost_actual when present (rare for future dates), else
          // estimated_salary (the planned-cost figure PK returns for posted
          // shifts that haven't happened yet).
          const c = Number(s.cost_actual ?? 0) > 0 ? Number(s.cost_actual) : Number(s.estimated_salary ?? 0)
          byDate[d].cost += c
          byDate[d].shifts += 1
        }
        const dates = Object.keys(byDate).sort()
        const totalHours = dates.reduce((s, d) => s + byDate[d].hours, 0)
        const totalCost  = dates.reduce((s, d) => s + byDate[d].cost,  0)
        const lines = dates.slice(0, 14).map(d => {
          const r = byDate[d]
          return `  - ${d}: ${r.shifts} shifts, ${Math.round(r.hours * 10) / 10}h scheduled, ${fmt(r.cost)} kr est. cost`
        }).join('\n')
        const avgRate = totalHours > 0 ? Math.round(totalCost / totalHours) : null
        attach('schedule', `\n\nForward-looking SCHEDULED shifts (today + next 14 days, from PK roster — these are PLANNED hours, not actuals; cost is PK's estimated_salary):\n${lines}\n  TOTAL: ${Math.round(totalHours * 10) / 10}h scheduled, ${fmt(totalCost)} kr est. cost${avgRate ? `, ~${avgRate} kr/h blended` : ''}\n[INSTRUCTION TO CLAUDE: when computing "hours to cut to hit X% labour", use this scheduled cost vs the forecast revenue. Formula: target_cost = forecast_revenue × X%; hours_to_cut = (current_scheduled_cost − target_cost) / blended_rate. If totalHours = 0, the user hasn't posted a roster yet — say so.]`)
      }
    } catch (e: any) { warnings.push('schedule enrichment failed: ' + (e?.message ?? 'unknown')) }
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

  // ── BUDGET ENRICHMENT ─────────────────────────────────────────────────────
  // Targets the user has set on /budget. Lets the AI answer "am I tracking
  // against May target", "how much budget do I have left for marketing".
  if (opts.businessId && remainingBudget > 200 && BUDGET_KEYWORDS.test(question)) {
    try {
      const yNow = new Date().getUTCFullYear()
      const { data: budgets } = await db
        .from('budgets')
        .select('year, month, revenue_target, food_cost_target, staff_cost_target, other_cost_target, net_profit_target')
        .eq('org_id', opts.orgId).eq('business_id', opts.businessId)
        .eq('year', yNow)
        .order('month', { ascending: true })
      if (budgets?.length) {
        const lines = budgets.map((b: any) => {
          const parts = [
            b.revenue_target    ? `rev ${fmt(b.revenue_target)}`         : null,
            b.staff_cost_target ? `staff ${fmt(b.staff_cost_target)}`    : null,
            b.food_cost_target  ? `food ${fmt(b.food_cost_target)}`      : null,
            b.other_cost_target ? `other ${fmt(b.other_cost_target)}`    : null,
            b.net_profit_target ? `net ${fmt(b.net_profit_target)}`      : null,
          ].filter(Boolean).join(' | ')
          return `  - ${MONTHS[b.month - 1]} ${b.year}: ${parts}`
        }).join('\n')
        attach('budget', `\n\nBudget targets for ${yNow} (set by owner on /budget — compare against monthly_metrics actuals to compute on-track status):\n${lines}`)
      }
    } catch (e: any) { warnings.push('budget enrichment failed: ' + (e?.message ?? 'unknown')) }
  }

  // ── PK SALE FORECAST ENRICHMENT ───────────────────────────────────────────
  // Personalkollen's own short-term sale forecast — sometimes more accurate
  // than our model on a 7–14 day horizon since it incorporates real-time
  // booking signals from the venue's POS layer. Surfaces alongside our
  // /forecasts table so Claude can compare "model says X, PK says Y".
  if (opts.businessId && remainingBudget > 200 && (FORECAST_KEYWORDS.test(question) || /\b(personalkollen|pk\s+forecast|venue\s+forecast)\b/i.test(question))) {
    try {
      const today = new Date().toISOString().slice(0, 10)
      const horizon = new Date(Date.now() + 21 * 86400_000).toISOString().slice(0, 10)
      const { data: pk } = await db
        .from('pk_sale_forecasts')
        .select('forecast_date, amount, workplace_url')
        .eq('org_id', opts.orgId).eq('business_id', opts.businessId)
        .gte('forecast_date', today)
        .lte('forecast_date', horizon)
        .order('forecast_date', { ascending: true })
        .limit(200)
      if (pk?.length) {
        const byDate: Record<string, number> = {}
        for (const r of pk) byDate[r.forecast_date] = (byDate[r.forecast_date] ?? 0) + Number(r.amount ?? 0)
        const dates = Object.keys(byDate).sort()
        const total = dates.reduce((s, d) => s + byDate[d], 0)
        const lines = dates.slice(0, 14).map(d => `  - ${d}: ${fmt(byDate[d])} kr`).join('\n')
        attach('pk_forecast', `\n\nPersonalkollen's own sale forecast (next ~21 days, summed across departments — venue-side estimate, often more accurate short-horizon than our model):\n${lines}\n  TOTAL window: ${fmt(total)} kr across ${dates.length} days`)
      }
    } catch (e: any) { warnings.push('pk_forecast enrichment failed: ' + (e?.message ?? 'unknown')) }
  }

  // ── ACCURACY ENRICHMENT ───────────────────────────────────────────────────
  // forecast_calibration latest row + recent ai_forecast_outcomes hits/misses.
  // Lets Claude be honest about how reliable its own forecasts have been
  // ("my last 5 monthly forecasts were on average +8 % over actual").
  if (opts.businessId && remainingBudget > 200 && ACCURACY_KEYWORDS.test(question)) {
    try {
      const [calRes, outcomesRes] = await Promise.all([
        db.from('forecast_calibration')
          .select('accuracy_pct, bias_factor, calibrated_at')
          .eq('business_id', opts.businessId)
          .order('calibrated_at', { ascending: false })
          .limit(1),
        db.from('ai_forecast_outcomes')
          .select('surface, period_year, period_month, suggested_revenue, actual_revenue, revenue_error_pct, revenue_direction, owner_reaction')
          .eq('business_id', opts.businessId)
          .not('actuals_resolved_at', 'is', null)
          .order('created_at', { ascending: false })
          .limit(8),
      ])
      const cal      = calRes.data?.[0]
      const outcomes = outcomesRes.data ?? []
      if (cal || outcomes.length) {
        let block = '\n\nForecast accuracy track record:'
        if (cal) {
          block += `\n  - Latest calibration (${cal.calibrated_at?.slice(0, 10)}): accuracy ${cal.accuracy_pct ?? '—'}%, rolling bias factor ${cal.bias_factor ?? '—'} (1.00 = unbiased, >1 = forecast undershot, <1 = forecast overshot)`
        }
        if (outcomes.length) {
          const lines = outcomes.slice(0, 6).map((o: any) =>
            `    · ${o.surface} ${MONTHS[(o.period_month ?? 1) - 1]} ${o.period_year}: forecast ${fmt(o.suggested_revenue)} kr → actual ${fmt(o.actual_revenue)} kr (${o.revenue_error_pct ?? '—'}% ${o.revenue_direction ?? ''})`
          ).join('\n')
          block += `\n  - Last ${outcomes.length} resolved AI suggestions:\n${lines}`
        }
        attach('accuracy', block)
      }
    } catch (e: any) { warnings.push('accuracy enrichment failed: ' + (e?.message ?? 'unknown')) }
  }

  // ── WEATHER ENRICHMENT ────────────────────────────────────────────────────
  // weather_daily for last 7 + next 7 days. Temperature, precip, wind, code.
  // Lets Claude answer "will Friday's rain hurt revenue" or "was last
  // weekend's drop weather-driven".
  if (opts.businessId && remainingBudget > 200 && WEATHER_KEYWORDS.test(question)) {
    try {
      const since   = new Date(Date.now() - 7  * 86400_000).toISOString().slice(0, 10)
      const horizon = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10)
      const { data: w } = await db
        .from('weather_daily')
        .select('date, temp_min, temp_max, temp_avg, precip_mm, wind_max, weather_code')
        .eq('business_id', opts.businessId)
        .gte('date', since)
        .lte('date', horizon)
        .order('date', { ascending: true })
        .limit(30)
      if (w?.length) {
        const lines = w.map((d: any) =>
          `  - ${d.date}: ${d.temp_min}°/${d.temp_max}°C, ${d.precip_mm ?? 0}mm rain, wind ${d.wind_max ?? 0}m/s (WMO ${d.weather_code ?? '—'})`
        ).join('\n')
        attach('weather', `\n\nWeather (past 7 + next 14 days, business-local timezone):\n${lines}\n[Note: precip > 5 mm typically reduces walk-in by 10–25 %; over 10 mm by 25–50 %. Use historical correlation to caveat predictions.]`)
      }
    } catch (e: any) { warnings.push('weather enrichment failed: ' + (e?.message ?? 'unknown')) }
  }

  // ── STAFF INDIVIDUAL ENRICHMENT ───────────────────────────────────────────
  // Per-staff aggregates for last 30 days — top 10 by cost. Powers "who has
  // the most overtime", "who's late most often". Names truncated.
  if (opts.businessId && remainingBudget > 200 && STAFF_INDIV_KEYWORDS.test(question)) {
    try {
      const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
      const { data: shifts } = await db
        .from('staff_logs')
        .select('staff_uid, staff_name, hours_worked, cost_actual, estimated_salary, is_late, ob_supplement_kr, staff_group')
        .eq('org_id', opts.orgId).eq('business_id', opts.businessId)
        .gte('shift_date', since)
        .not('pk_log_url', 'like', '%_scheduled')
        .or('cost_actual.gt.0,estimated_salary.gt.0')
        .limit(2000)
      if (shifts?.length) {
        const byStaff: Record<string, { name: string; dept: string | null; hours: number; cost: number; shifts: number; late: number; ob: number }> = {}
        for (const s of shifts) {
          const k = s.staff_uid ?? s.staff_name ?? 'unknown'
          if (!byStaff[k]) byStaff[k] = { name: (s.staff_name ?? k).slice(0, 24), dept: s.staff_group ?? null, hours: 0, cost: 0, shifts: 0, late: 0, ob: 0 }
          byStaff[k].hours  += Number(s.hours_worked ?? 0)
          byStaff[k].cost   += Number(s.cost_actual ?? 0) > 0 ? Number(s.cost_actual) : Number(s.estimated_salary ?? 0)
          byStaff[k].shifts += 1
          if (s.is_late) byStaff[k].late += 1
          byStaff[k].ob    += Number(s.ob_supplement_kr ?? 0)
        }
        const top = Object.values(byStaff).sort((a, b) => b.cost - a.cost).slice(0, 10)
        const lines = top.map(p =>
          `  - ${p.name}${p.dept ? ` (${p.dept})` : ''}: ${Math.round(p.hours * 10) / 10}h, ${fmt(p.cost)} kr across ${p.shifts} shifts | late ${p.late}× | OB ${fmt(p.ob)} kr`
        ).join('\n')
        attach('staff_individual', `\n\nTop 10 staff by cost (last 30 days, actual shifts only — excludes scheduled-but-not-worked):\n${lines}`)
      }
    } catch (e: any) { warnings.push('staff_individual enrichment failed: ' + (e?.message ?? 'unknown')) }
  }

  // ── GROUP / CROSS-BUSINESS ENRICHMENT ─────────────────────────────────────
  // When the org has multiple businesses AND the question is group-scoped
  // ("which location is worst"), fetch monthly_metrics for every business
  // for the current year. Bypasses the businessId scope of every other
  // enrichment by design — this is the one cross-cutting view.
  if (remainingBudget > 200 && GROUP_KEYWORDS.test(question)) {
    try {
      const { data: bizList } = await db
        .from('businesses')
        .select('id, name, is_active')
        .eq('org_id', opts.orgId)
        .eq('is_active', true)
        .order('name', { ascending: true })
      if (bizList && bizList.length > 1) {
        const yNow = new Date().getUTCFullYear()
        const { data: rows } = await db
          .from('monthly_metrics')
          .select('business_id, year, month, revenue, staff_cost, food_cost, net_profit, margin_pct, labour_pct')
          .eq('org_id', opts.orgId)
          .eq('year', yNow)
          .in('business_id', bizList.map((b: any) => b.id))
          .order('month', { ascending: true })
          .limit(500)
        const nameById: Record<string, string> = {}
        for (const b of bizList) nameById[b.id] = b.name
        const byBiz: Record<string, any[]> = {}
        for (const r of rows ?? []) {
          if (!byBiz[r.business_id]) byBiz[r.business_id] = []
          byBiz[r.business_id].push(r)
        }
        const blocks = Object.entries(byBiz).map(([bid, recs]) => {
          const ytdRev    = recs.reduce((s, r: any) => s + Number(r.revenue ?? 0),    0)
          const ytdProfit = recs.reduce((s, r: any) => s + Number(r.net_profit ?? 0), 0)
          const ytdLabour = recs.reduce((s, r: any) => s + Number(r.staff_cost ?? 0), 0)
          const ytdMargin = ytdRev > 0 ? Math.round((ytdProfit / ytdRev) * 1000) / 10 : 0
          const ytdLabPct = ytdRev > 0 ? Math.round((ytdLabour / ytdRev) * 1000) / 10 : 0
          return `  - ${nameById[bid] ?? bid.slice(0, 8)}: YTD rev ${fmt(ytdRev)} kr, net ${fmt(ytdProfit)} kr (${ytdMargin}%), labour ${ytdLabPct}%`
        }).join('\n')
        if (blocks) {
          attach('group', `\n\nCross-business view (${yNow} YTD across ${bizList.length} active businesses in this org):\n${blocks}\n[Use this when the user asks "which location is worst" / "compare locations". Per-business detail requires switching to that business in the sidebar.]`)
        }
      }
    } catch (e: any) { warnings.push('group enrichment failed: ' + (e?.message ?? 'unknown')) }
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
