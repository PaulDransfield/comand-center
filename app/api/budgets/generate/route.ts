// @ts-nocheck
// app/api/budgets/generate/route.ts
// AI-generated budget suggestions.
// POST { business_id, year } → returns { overall_strategy, monthly: [{ month, revenue_target, food_cost_pct_target, staff_cost_pct_target, net_profit_target, reasoning }, ...] }
// Nothing is written to the DB here — the client shows the suggestions for review, then POSTs accepted ones to /api/budgets.
// Uses Claude Haiku 4.5 (agent tier). Cost per call ~$0.003.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { AI_MODELS, MAX_TOKENS } from '@/lib/ai/models'
import { checkAiLimit, incrementAiUsage, logAiRequest } from '@/lib/ai/usage'
import { SCOPE_NOTE } from '@/lib/ai/scope'
import { requireFinanceAccess, requireBusinessAccess } from '@/lib/auth/require-role'

export const dynamic    = 'force-dynamic'
export const maxDuration = 60

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const finForbidden = requireFinanceAccess(auth); if (finForbidden) return finForbidden

  const body = await req.json().catch(() => ({}))
  const businessId = body.business_id
  const year       = Number(body.year ?? new Date().getFullYear())
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const bizForbidden = requireBusinessAccess(auth, businessId); if (bizForbidden) return bizForbidden

  const db = createAdminClient()

  // Daily AI query gate — counts the same as an /api/ask call against the plan limit.
  const gate = await checkAiLimit(db, auth.orgId)
  if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status })

  // ── 1. Gather context: last year actuals, this year's forecasts, YTD actuals ──
  // Every tenanted read filters org_id first — service role bypasses RLS.
  //
  // Two sources of "last year actuals" must be merged:
  //   1. monthly_metrics — POS-sourced (Personalkollen revenue + staff aggregation).
  //   2. tracker_data    — accountant-sourced (Fortnox P&L extraction via /api/fortnox/apply).
  //
  // Fortnox is the authoritative source where it exists (books close on
  // real bank + ledger data, POS can miss cash/tips/adjustments). So we
  // read both and prefer tracker_data row-for-row, falling back to
  // monthly_metrics for months where no Fortnox PDF has been applied.
  //
  // Previous behaviour: only monthly_metrics was consulted, so uploading
  // Vero's Apr–Aug 2025 Fortnox PDFs had no effect on the 2026 budget —
  // the AI saw "no 2025 data" for Vero because Vero doesn't have
  // Personalkollen coverage for 2025. Hence Jan 2026 budget of 410k
  // against 1.6M actual.
  const [lyMetricsRes, lyTrackerRes, fcRes, ytdMetricsRes, ytdTrackerRes, bizRes, annualRes] = await Promise.all([
    db.from('monthly_metrics')
      .select('month, revenue, staff_cost, food_cost, net_profit, margin_pct')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .eq('year', year - 1)
      .order('month'),
    db.from('tracker_data')
      .select('period_month, revenue, staff_cost, food_cost, other_cost, net_profit, margin_pct')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .eq('period_year', year - 1)
      .gt('period_month', 0)
      .order('period_month'),
    db.from('forecasts')
      .select('period_month, revenue_forecast, staff_cost_forecast, food_cost_forecast, net_profit_forecast, margin_forecast')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .eq('period_year', year)
      .order('period_month'),
    db.from('monthly_metrics')
      .select('month, revenue, staff_cost, food_cost, net_profit, margin_pct')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .eq('year', year)
      .order('month'),
    db.from('tracker_data')
      .select('period_month, revenue, staff_cost, food_cost, other_cost, net_profit, margin_pct')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .eq('period_year', year)
      .gt('period_month', 0)
      .order('period_month'),
    db.from('businesses').select('name, city').eq('org_id', auth.orgId).eq('id', businessId).maybeSingle(),
    // Annual-summary fallback — older uploads stored a single annual
    // rollup with period_month=0. Kept so legacy data still contributes.
    db.from('tracker_line_items')
      .select('period_year, category, amount')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .eq('period_month', 0)
      .in('period_year', [year - 1, year - 2]),
  ])

  // Merge: prefer tracker_data (Fortnox) over monthly_metrics (POS).
  const mergeMonths = (metricsRows: any[], trackerRows: any[]) => {
    const merged = new Map<number, any>()
    for (const r of metricsRows ?? []) {
      merged.set(Number(r.month), {
        month:       Number(r.month),
        revenue:     Number(r.revenue ?? 0),
        staff_cost:  Number(r.staff_cost ?? 0),
        food_cost:   Number(r.food_cost ?? 0),
        net_profit:  Number(r.net_profit ?? 0),
        margin_pct:  r.margin_pct == null ? null : Number(r.margin_pct),
        source:      'pos',
      })
    }
    for (const r of trackerRows ?? []) {
      merged.set(Number(r.period_month), {
        month:       Number(r.period_month),
        revenue:     Number(r.revenue ?? 0),
        staff_cost:  Number(r.staff_cost ?? 0),
        food_cost:   Number(r.food_cost ?? 0),
        net_profit:  Number(r.net_profit ?? 0),
        margin_pct:  r.margin_pct == null ? null : Number(r.margin_pct),
        source:      'fortnox',
      })
    }
    return Array.from(merged.values()).sort((a, b) => a.month - b.month)
  }

  const lastYear   = mergeMonths(lyMetricsRes.data ?? [], lyTrackerRes.data ?? [])
  const forecasts  = fcRes.data ?? []
  const ytd        = mergeMonths(ytdMetricsRes.data ?? [], ytdTrackerRes.data ?? [])
  const biz        = bizRes.data
  const annualRows = annualRes.data ?? []

  // ── Prior AI accuracy — the feedback loop ─────────────────────────
  // Pull the last 12 months of ai_forecast_outcomes for this business
  // where an actual has been resolved. Feed as a "track record" block
  // so the AI can see its own systematic bias and correct for it.
  // Org-scoped query; no cross-tenant data leakage.
  const { data: priorOutcomes } = await db
    .from('ai_forecast_outcomes')
    .select('period_year, period_month, suggested_revenue, actual_revenue, revenue_error_pct, revenue_direction, owner_reaction')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .eq('surface', 'budget_generate')
    .not('actual_revenue', 'is', null)
    .order('period_year', { ascending: false })
    .order('period_month', { ascending: false })
    .limit(12)

  // ── 2. Format the data into a compact context for Claude ─────────────────────
  const fmt = (n: any) => (n === null || n === undefined) ? '?' : Math.round(Number(n)).toLocaleString('en-GB')

  // Collapse annual Fortnox line items into per-year category totals so
  // we can feed Claude a clean "Annual reference" block.
  const annualByYear: Record<number, Record<string, number>> = {}
  for (const r of annualRows) {
    const y = r.period_year as number
    if (!annualByYear[y]) annualByYear[y] = {}
    const c = r.category as string
    annualByYear[y][c] = (annualByYear[y][c] ?? 0) + Number(r.amount ?? 0)
  }
  const annualSummary = (y: number) => {
    const t = annualByYear[y]
    if (!t) return null
    const revenue    = t.revenue     ?? 0
    const food       = t.food_cost   ?? 0
    const staff      = t.staff_cost  ?? 0
    const other      = t.other_cost  ?? 0
    const depr       = t.depreciation?? 0
    const fin        = t.financial   ?? 0
    const netProfit  = revenue - food - staff - other - depr + fin
    const marginPct  = revenue > 0 ? (netProfit / revenue) * 100 : 0
    return { revenue, food, staff, other, depr, fin, netProfit, marginPct }
  }

  const lyAnnual = annualSummary(year - 1)
  const lyTable = lastYear.length
    ? lastYear.map(r => {
        // Flag data gaps explicitly so the AI doesn't confuse them
        // with genuine zero-revenue months (closed business etc).
        // Gap = revenue=0 but staff_cost>0 (payroll proves the business
        // was operating, we just lack revenue data for that period).
        const isGap = Number(r.revenue ?? 0) === 0 && Number(r.staff_cost ?? 0) > 0
        const gapFlag = isGap ? ' ⚠ DATA GAP — use YTD / nearest-month anchor' : ''
        return `  ${MONTHS[r.month - 1]}: rev=${fmt(r.revenue)} staff=${fmt(r.staff_cost)} food=${fmt(r.food_cost)} net=${fmt(r.net_profit)} margin=${r.margin_pct ?? '?'}% (src: ${r.source})${gapFlag}`
      }).join('\n')
    : lyAnnual
      ? `  (no monthly breakdown — using annual Fortnox report instead, see block below)`
      : '  (no prior-year data)'

  const ytdTable = ytd.length
    ? ytd.map(r =>
        `  ${MONTHS[r.month - 1]}: rev=${fmt(r.revenue)} staff=${fmt(r.staff_cost)} food=${fmt(r.food_cost)} net=${fmt(r.net_profit)} margin=${r.margin_pct ?? '?'}% (src: ${r.source})`
      ).join('\n')
    : '  (no current-year actuals yet)'

  const fcTable = forecasts.length
    ? forecasts.map(r =>
        `  ${MONTHS[r.period_month - 1]}: rev_forecast=${fmt(r.revenue_forecast)} staff_forecast=${fmt(r.staff_cost_forecast)} food_forecast=${fmt(r.food_cost_forecast)} net_forecast=${fmt(r.net_profit_forecast)}`
      ).join('\n')
    : '  (no forecasts yet)'

  // Prior AI accuracy block — shows the AI its own track record for
  // this business. Only populated after at least one resolved outcome.
  // Directional bias is aggregated so the AI sees "you tend to
  // under-predict by N%" and can correct.
  const outcomeRows = priorOutcomes ?? []
  let priorAccuracyBlock = ''
  if (outcomeRows.length) {
    const lines = outcomeRows.map(o => {
      const period = o.period_month
        ? `${MONTHS[o.period_month - 1]} ${o.period_year}`
        : `${o.period_year}`
      const arrow = o.revenue_direction === 'over'     ? '↓ over-predicted'
                  : o.revenue_direction === 'under'    ? '↑ under-predicted'
                  : o.revenue_direction === 'accurate' ? '≈ accurate'
                  : '— no actual'
      const errPct = o.revenue_error_pct == null ? '' : ` (${Math.round(Number(o.revenue_error_pct))}%)`
      const fb = o.owner_reaction ? ` [owner: ${o.owner_reaction}]` : ''
      return `  ${period}: suggested ${fmt(o.suggested_revenue)} → actual ${fmt(o.actual_revenue)} ${arrow}${errPct}${fb}`
    }).join('\n')

    // Compute directional bias — mean signed error % across rows with actuals
    const withErr = outcomeRows.filter(o => Number.isFinite(Number(o.revenue_error_pct)))
    const meanErr = withErr.length
      ? withErr.reduce((s, o) => s + Number(o.revenue_error_pct), 0) / withErr.length
      : 0
    const biasText = Math.abs(meanErr) < 5 ? 'broadly accurate (within ±5%)'
                   : meanErr > 0 ? `tending to UNDER-predict this business by ~${Math.round(meanErr)}%`
                   : `tending to OVER-predict this business by ~${Math.abs(Math.round(meanErr))}%`

    priorAccuracyBlock = `
PRIOR AI BUDGET ACCURACY FOR THIS BUSINESS (your own track record):
${lines}

Directional bias: your past suggestions for this business are ${biasText}.
Factor that into today's targets — but stay within the ±15% ceiling
against last year's actual for each month. Owner reactions (if shown)
are direct feedback; weight them heavily.
`
  }

  const prompt = `You are helping set monthly budget targets for a Swedish restaurant: "${biz?.name ?? 'Unknown'}"${biz?.city ? ` in ${biz.city}` : ''}.

${SCOPE_NOTE}

Your job: return 12 monthly budgets for ${year} that are GROUNDED IN LAST YEAR'S ACTUAL MONTHLY REVENUE. These become operational goals — an over-ambitious target will cause the owner to over-staff and burn real cash.

PRIMARY RULE — HISTORICAL ANCHOR:
  Each month's target MUST be anchored to the same month from last year.
  Maximum stretch: +3% to +8% above last year's ACTUAL revenue for that month.
  You are FORBIDDEN to project a target more than 15% above last year's actual
  for the same month, no matter how strong this year's YTD looks.

  If last year's actual for a given month is 440 000 kr, this year's target
  belongs in the 453 000 – 475 000 kr range. NOT 1 200 000 kr. NOT "calibrated
  forecast". The forecast engine is an input; it is NOT the anchor.

SECONDARY RULE — RESPECT LAST YEAR'S SEASONALITY:
  Do NOT assume generic "summer peak" or "holiday peak" patterns. Use the
  SHAPE of last year's actual monthly revenue as ground truth. If last year
  June was lower than May, this year June should also be lower than May — the
  business may be a winter restaurant, a lunch spot, a takeaway, seasonal,
  etc. You do not know; the last-year numbers do.

HANDLING DATA GAPS — READ CAREFULLY:
  A last-year month showing revenue=0 with staff_cost > 0 means the business
  WAS OPERATING (payroll proves it) but we simply don't have the revenue
  number for that period. This is a DATA GAP. It does NOT mean "hibernation"
  or "closed".

  ABSOLUTE HARD RULE: If staff_cost > 0 for a month (in last year or this
  year), then revenue_target for that month MUST BE > 0. A month with
  payroll and 0 revenue is impossible. If you produce revenue_target=0 for
  a month with payroll, you have failed at this task.

  CURRENT-MONTH RULE (CRITICAL): The current calendar month is NEVER a
  valid YTD anchor, even if "YTD" data exists for it. Today is part-way
  through the month, so "YTD April 2026" might show 52 000 kr when the
  full month will end at 850 000 kr. Using partial-month data as an
  anchor produces absurd targets. For the current month, ALWAYS anchor
  on last year's same month — or on the nearest FULLY-CLOSED neighbour
  if last year's same month is a data gap.

  Use this priority order for any month WITHOUT a populated prior-year row:
    (a) SAME-MONTH THIS YEAR'S YTD actual — ONLY if the calendar month has
        fully closed (last day of the month is in the past). Target =
        YTD × (1.03 to 1.08). Do NOT use partial data from the current
        month — it's under-reported by definition.
    (b) NEAREST POPULATED LAST-YEAR MONTH — check BOTH DIRECTIONS (before
        AND after). October 2025 gap? Closest populated months are August
        2025 (revenue 687k, 2 months earlier) and November 2025 (revenue
        476k, 1 month later). Use the closer one — November — and document
        the adjustment. Do NOT only look backward.
    (c) If both a-before and b-after gap-month neighbours exist with real
        data, INTERPOLATE or pick the closer in calendar distance.
    (d) STAFF COST SANITY CHECK — whichever anchor you use, the implied
        staff-cost ratio should be within 10pp of the staff_cost / revenue
        ratio from populated months. If your revenue target paired with
        that month's staff_cost would give a ratio outside the industry
        ceiling (42%), flag it in the reasoning.

  Never use industry averages or calibrated-forecast output to fill a gap.
  Never leave revenue_target at 0 when staff_cost for that month is > 0.
  Never use partial-month YTD as an anchor for the current month.

FOOD COST — ALWAYS APPLY A FLOOR:
  food_cost_pct_target MUST be between 28 and 32 for every month, ALWAYS.
  A running restaurant cannot have 0% food cost; even if last year's
  recorded food_cost was 0 (data gap — Fortnox PDF not uploaded for that
  month), the ACTUAL food cost of a trading restaurant is 28–32% of revenue.
  Never output food_cost_pct_target=0. If last year showed 0% food cost, it
  is a DATA GAP; target 30% as the prudent default for that month.

TREATING YTD (this year so far):
  This year's YTD actuals are evidence the business is trading.
  For months WITH prior-year revenue data: YTD is a signal, not the anchor.
  Stay within +15% of last-year's actual for that month.
  For months with a data gap last year: YTD for that same month IS the
  anchor (per "HANDLING DATA GAPS" rule (a)).
  Never project YTD run-rates forward into future months that already have
  prior-year data — that causes overstaffing.

STAFF COST — CAP TO HISTORICAL:
  staff_cost_pct_target = last year's actual staff cost ratio for that month,
  capped at the industry maximum (42%). Do NOT target below last year's ratio
  unless there's a concrete operational reason — the owner would read it as a
  staffing cut mandate.

INDUSTRY GUARDRAILS (ceilings, not anchors):
  Food cost: 28-32% of revenue
  Staff cost: 35-42% of revenue
  Net profit margin: 10-15%

${lyAnnual ? `LAST YEAR (${year - 1}) FORTNOX ANNUAL REPORT — whole-year totals:
  revenue=${fmt(lyAnnual.revenue)}  food_cost=${fmt(lyAnnual.food)}  staff_cost=${fmt(lyAnnual.staff)}  other_cost=${fmt(lyAnnual.other)}  net_profit=${fmt(lyAnnual.netProfit)}  margin=${lyAnnual.marginPct.toFixed(1)}%
  Use this to cross-check: the SUM of your 12 monthly revenue_targets should
  be within 15% of this figure × 1.05. If you'd exceed that sum, you're
  overshooting — pull back.

` : ''}LAST YEAR (${year - 1}) ACTUAL MONTHLY — THE AUTHORITATIVE ANCHOR:
${lyTable}

${year} CURRENT-YEAR ACTUALS SO FAR (YTD — input only, not the anchor):
${ytdTable}

CALIBRATED FORECASTS FOR ${year} (input only, NOT the anchor — informs confidence band but never the target):
${fcTable}
${priorAccuracyBlock}

RULES:
- revenue_target = last year's same-month actual × (1.03 to 1.08). Hard max: last year × 1.15.
- If last year data is a gap (zero revenue with staff cost), anchor on nearest populated month.
- food_cost_pct_target: lower end of industry range when margin is healthy.
- staff_cost_pct_target: anchored on last year's same-month ratio, never below it.
- net_profit_target = revenue_target × (1 - food_pct/100 - staff_pct/100 - 10% other-cost assumption)
- reasoning: one short sentence with BOTH last year's actual AND your target, so the owner can see the anchor. e.g. "Jul 2025 actual 440k → target 470k (+7%)" — NOT "calibrated forecast 1.36M so stretch to 1.46M".

Return JSON only, no prose outside JSON, no markdown code fence:

{
  "overall_strategy": "one paragraph explaining the year's goal — 2-3 sentences max",
  "monthly": [
    { "month": 1,  "revenue_target": <int>, "food_cost_pct_target": <int>, "staff_cost_pct_target": <int>, "net_profit_target": <int>, "reasoning": "<sentence>" },
    ... 12 months total ...
  ]
}`

  // ── 3. Call Claude Haiku ──────────────────────────────────────────────────
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 })
  }

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    // Tool use — forces Haiku to respond via submit_budget with a strict
    // schema. Replaces regex-parse which silently 502'd when Claude added
    // commentary around the JSON.
    const submitBudgetTool = {
      name: 'submit_budget',
      description: 'Submit the 12-month budget proposal.',
      input_schema: {
        type: 'object',
        properties: {
          strategy: { type: 'string', description: 'One paragraph overall strategy (80-150 words).' },
          months: {
            type: 'array',
            minItems: 12,
            maxItems: 12,
            items: {
              type: 'object',
              properties: {
                month:            { type: 'number' },
                revenue_target:   { type: 'number' },
                food_pct_target:  { type: 'number' },
                staff_pct_target: { type: 'number' },
                notes:            { type: 'string' },
              },
              required: ['month', 'revenue_target', 'food_pct_target', 'staff_pct_target'],
            },
          },
        },
        required: ['strategy', 'months'],
      },
    }

    const startedAt = Date.now()
    const response = await (claude as any).messages.create({
      model:      AI_MODELS.AGENT,
      max_tokens: 2500,
      tools:      [submitBudgetTool],
      tool_choice: { type: 'tool', name: 'submit_budget' },
      messages:   [{ role: 'user', content: prompt }],
    })

    const toolUse = (response.content ?? []).find((b: any) => b.type === 'tool_use')
    const parsed = toolUse?.input
    if (!parsed?.months) {
      return NextResponse.json({ error: 'AI response missing months', raw: response }, { status: 502 })
    }

    // Normalise: ensure we have 12 months. Fill gaps with zeros.
    // Also enforce the server-side backstops that protect against Haiku
    // ignoring prompt rules — food cost floor, anti-zero-revenue-with-
    // payroll guard. Any suggestion that slips through gets repaired
    // here before it reaches the UI.
    const lastYearByMonth = new Map<number, any>()
    for (const r of lastYear) lastYearByMonth.set(Number(r.month), r)
    const ytdByMonth = new Map<number, any>()
    for (const r of ytd) ytdByMonth.set(Number(r.month), r)

    const byMonth = new Map<number, any>()
    for (const s of parsed.monthly ?? []) {
      if (s.month >= 1 && s.month <= 12) byMonth.set(s.month, s)
    }
    const monthly = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1
      const s = byMonth.get(m)

      let revenueTarget = Math.round(Number(s?.revenue_target ?? 0))
      const foodPctRaw  = Math.round(Number(s?.food_cost_pct_target ?? 30))
      const staffPctRaw = Math.round(Number(s?.staff_cost_pct_target ?? 40))

      // Food cost floor — 28-32% range, clamp to 30% when missing/zero.
      // No running restaurant has 0% food cost, regardless of data gaps.
      const foodCostPctTarget = foodPctRaw < 28 ? 30 : Math.min(foodPctRaw, 32)

      // Anti-zero-revenue backstop. If the AI budgeted 0 revenue for a
      // month that had any payroll (last year OR this year), pick the
      // best available anchor from our data and apply a 5% stretch.
      if (revenueTarget <= 0) {
        const ly = lastYearByMonth.get(m)
        const yt = ytdByMonth.get(m)
        const lyStaff = Number(ly?.staff_cost ?? 0)
        const ytStaff = Number(yt?.staff_cost ?? 0)

        if (lyStaff > 0 || ytStaff > 0) {
          // Must budget something. Priority: YTD actual > LY revenue >
          // nearest-populated-month revenue.
          const ytRev = Number(yt?.revenue ?? 0)
          const lyRev = Number(ly?.revenue ?? 0)

          if (ytRev > 0) {
            revenueTarget = Math.round(ytRev * 1.05)
          } else if (lyRev > 0) {
            revenueTarget = Math.round(lyRev * 1.05)
          } else {
            // Find nearest populated month in last year, in either direction.
            let nearest = 0
            let nearestDist = Infinity
            for (const [otherM, row] of lastYearByMonth) {
              const rev = Number(row?.revenue ?? 0)
              if (rev > 0) {
                const dist = Math.abs(otherM - m)
                if (dist < nearestDist) { nearestDist = dist; nearest = rev }
              }
            }
            if (nearest > 0) revenueTarget = Math.round(nearest * 0.95)  // conservative adjustment for gap month
          }
        }
      }

      // Recompute net profit using the (potentially repaired) numbers
      // so the UI can't show -435k loss against a 0 revenue row.
      const netProfitTarget = Math.round(revenueTarget * (1 - foodCostPctTarget / 100 - staffPctRaw / 100 - 0.10))

      return {
        month:                  m,
        revenue_target:         revenueTarget,
        food_cost_pct_target:   foodCostPctTarget,
        staff_cost_pct_target:  staffPctRaw,
        net_profit_target:      netProfitTarget,
        reasoning:              String(s?.reasoning ?? ''),
      }
    })

    await incrementAiUsage(db, auth.orgId)
    await logAiRequest(db, {
      org_id:        auth.orgId,
      user_id:       auth.userId,
      request_type:  'budget_generate',
      model:         AI_MODELS.AGENT,
      page:          'budget',
      input_tokens:  (response as any).usage?.input_tokens  ?? 0,
      output_tokens: (response as any).usage?.output_tokens ?? 0,
      duration_ms:   Date.now() - startedAt,
    })

    // Capture one outcome row per suggested month. The accuracy-
    // reconciler cron fills in actuals when the month closes, then
    // priorAccuracyBlock picks them up on the next budget generation.
    // Legal: numeric values only, no PII. Org-scoped via RLS.
    try {
      const lastYearByMonth = new Map<number, any>()
      for (const r of lastYear) lastYearByMonth.set(Number(r.month), r)

      const outcomeRowsToInsert = monthly.map(m => {
        const revenue = m.revenue_target
        const staff   = Math.round(revenue * (m.staff_cost_pct_target / 100))
        const food    = Math.round(revenue * (m.food_cost_pct_target / 100))
        const other   = Math.round(revenue * 0.10)   // matches AI's 10% other-cost assumption
        const net     = m.net_profit_target
        const marginPct = revenue > 0 ? Math.round((net / revenue) * 1000) / 10 : 0

        return {
          org_id:               auth.orgId,
          business_id:          businessId,
          surface:              'budget_generate',
          model:                AI_MODELS.AGENT,
          period_year:          year,
          period_month:         m.month,
          suggested_revenue:    revenue,
          suggested_staff_cost: staff,
          suggested_food_cost:  food,
          suggested_other_cost: other,
          suggested_net_profit: net,
          suggested_margin_pct: marginPct,
          // Tight context snapshot — no PII, just what the AI was
          // anchoring on for this month's prediction.
          suggested_context: {
            last_year_revenue:   lastYearByMonth.get(m.month)?.revenue ?? null,
            last_year_staff_pct: lastYearByMonth.get(m.month)?.margin_pct ?? null,
            ytd_avg_revenue:     ytd.length ? Math.round(ytd.reduce((s: number, r: any) => s + Number(r.revenue ?? 0), 0) / ytd.length) : null,
            reasoning:           m.reasoning,
          },
        }
      })

      // Upsert on (business_id, period_year, period_month, surface) via
      // delete-then-insert so re-generating replaces prior suggestions
      // cleanly. The 'surface' dimension keeps budget vs coach vs memo
      // suggestions separate even for the same month.
      await db.from('ai_forecast_outcomes')
        .delete()
        .eq('business_id', businessId)
        .eq('period_year', year)
        .eq('surface', 'budget_generate')
        .is('actuals_resolved_at', null)   // never delete resolved history
      const { error: insErr } = await db.from('ai_forecast_outcomes').insert(outcomeRowsToInsert)
      if (insErr) console.warn('[budgets/generate] outcomes capture failed:', insErr.message)
    } catch (e: any) {
      // Non-fatal: the user still gets their suggestions; the feedback
      // loop just misses this generation.
      console.warn('[budgets/generate] outcomes capture threw:', e?.message)
    }

    return NextResponse.json({
      overall_strategy: String(parsed.overall_strategy ?? ''),
      monthly,
      context_used: {
        last_year_months:  lastYear.length,
        ytd_months:        ytd.length,
        forecast_months:   forecasts.length,
        prior_outcomes:    outcomeRows.length,
      },
    })

  } catch (err: any) {
    console.error('[budgets/generate] AI error:', err)
    return NextResponse.json({ error: 'AI service error: ' + err.message }, { status: 503 })
  }
}
