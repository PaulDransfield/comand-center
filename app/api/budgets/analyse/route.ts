// @ts-nocheck
// app/api/budgets/analyse/route.ts
// Per-month AI analysis: compare budget vs actual for a single month,
// call out what went right and what went wrong. Only comments on metrics
// that actually have data — no feedback on e.g. food cost when food cost is 0.
//
// POST { business_id, year, month } →
//   {
//     verdict: 'hit' | 'missed' | 'mixed' | 'no-data',
//     headline: string,
//     analysis: [{ metric, status: 'good'|'bad'|'warn', message }],
//     recommendations: string[]
//   }
//
// Uses Claude Haiku 4.5. ~$0.002 per call.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { AI_MODELS } from '@/lib/ai/models'
import { checkAiLimit, incrementAiUsage, logAiRequest } from '@/lib/ai/usage'
import { SCOPE_NOTE } from '@/lib/ai/scope'
import { aiLocaleFromRequest } from '@/lib/ai/locale'
import { requireFinanceAccess, requireBusinessAccess } from '@/lib/auth/require-role'

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const fmt = (n: any) => (n === null || n === undefined) ? null : Math.round(Number(n))

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const finForbidden = requireFinanceAccess(auth); if (finForbidden) return finForbidden

  const body = await req.json().catch(() => ({}))
  const businessId = body.business_id
  const year       = Number(body.year)
  const month      = Number(body.month)
  if (!businessId || !year || !month) {
    return NextResponse.json({ error: 'business_id, year, month required' }, { status: 400 })
  }
  const bizForbidden = requireBusinessAccess(auth, businessId); if (bizForbidden) return bizForbidden

  const db = createAdminClient()

  // Daily AI query gate — counts same as an /api/ask call against the plan limit.
  const gate = await checkAiLimit(db, auth.orgId)
  if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status })

  // ── Pull actual (monthly_metrics with tracker_data fallback), budget, last year ──
  // Every tenanted read filters org_id first — service role bypasses RLS.
  const [mmRes, trRes, bdRes, lyMmRes, lyTrRes, bizRes] = await Promise.all([
    db.from('monthly_metrics')
      .select('revenue, staff_cost, food_cost, net_profit, margin_pct, covers, hours_worked')
      .eq('org_id', auth.orgId).eq('business_id', businessId).eq('year', year).eq('month', month).maybeSingle(),
    db.from('tracker_data')
      .select('revenue, staff_cost, food_cost, rent_cost, other_cost, net_profit, margin_pct')
      .eq('org_id', auth.orgId).eq('business_id', businessId).eq('period_year', year).eq('period_month', month).maybeSingle(),
    db.from('budgets')
      .select('revenue_target, food_cost_pct_target, staff_cost_pct_target, net_profit_target, margin_pct_target')
      .eq('org_id', auth.orgId).eq('business_id', businessId).eq('year', year).eq('month', month).maybeSingle(),
    db.from('monthly_metrics')
      .select('revenue, staff_cost, food_cost, net_profit, margin_pct')
      .eq('org_id', auth.orgId).eq('business_id', businessId).eq('year', year - 1).eq('month', month).maybeSingle(),
    db.from('tracker_data')
      .select('revenue, staff_cost, food_cost, net_profit, margin_pct')
      .eq('org_id', auth.orgId).eq('business_id', businessId).eq('period_year', year - 1).eq('period_month', month).maybeSingle(),
    db.from('businesses').select('name').eq('org_id', auth.orgId).eq('id', businessId).maybeSingle(),
  ])

  // Merge actual: monthly_metrics wins, tracker_data fills gaps
  const mm = mmRes.data ?? {}
  const tr = trRes.data ?? {}
  const actual = {
    revenue:    fmt(mm.revenue    ?? tr.revenue),
    staff_cost: fmt(mm.staff_cost ?? tr.staff_cost),
    food_cost:  fmt(mm.food_cost  ?? tr.food_cost),
    net_profit: fmt(mm.net_profit ?? tr.net_profit),
    margin_pct: mm.margin_pct ?? tr.margin_pct ?? null,
    covers:     fmt(mm.covers),
    hours:      mm.hours_worked ?? null,
  }

  // Merge last-year: same logic
  const lyMm = lyMmRes.data ?? {}
  const lyTr = lyTrRes.data ?? {}
  const lastYear = {
    revenue:    fmt(lyMm.revenue    ?? lyTr.revenue),
    staff_cost: fmt(lyMm.staff_cost ?? lyTr.staff_cost),
    food_cost:  fmt(lyMm.food_cost  ?? lyTr.food_cost),
    net_profit: fmt(lyMm.net_profit ?? lyTr.net_profit),
    margin_pct: lyMm.margin_pct ?? lyTr.margin_pct ?? null,
  }

  const budget = bdRes.data ?? null

  // Gate: if no actuals at all, nothing to analyse
  const hasAnyActual = actual.revenue || actual.staff_cost || actual.food_cost || actual.net_profit
  if (!hasAnyActual) {
    return NextResponse.json({
      verdict:  'no-data',
      headline: `No data synced for ${MONTHS[month - 1]} ${year} yet — nothing to analyse.`,
      analysis: [],
      recommendations: [],
    })
  }

  // ── Build conditional prompt — only include metrics that have data ──
  const lines: string[] = [
    `Restaurant: ${bizRes.data?.name ?? 'business'}`,
    `Month:      ${MONTHS[month - 1]} ${year}`,
    '',
    'ACTUAL RESULTS (only lines present had real data):',
  ]

  const hasRev    = !!actual.revenue
  const hasStaff  = !!actual.staff_cost
  const hasFood   = !!actual.food_cost
  const hasProfit = actual.net_profit !== null && actual.net_profit !== undefined
  const hasMargin = actual.margin_pct !== null && actual.margin_pct !== undefined

  if (hasRev)    lines.push(`- Revenue:    ${actual.revenue} kr`)
  if (hasStaff)  lines.push(`- Staff cost: ${actual.staff_cost} kr` + (hasRev ? ` (${(actual.staff_cost/actual.revenue*100).toFixed(1)}% of revenue)` : ''))
  if (hasFood)   lines.push(`- Food cost:  ${actual.food_cost} kr` + (hasRev ? ` (${(actual.food_cost/actual.revenue*100).toFixed(1)}% of revenue)` : ''))
  if (hasProfit) lines.push(`- Net profit: ${actual.net_profit} kr`)
  if (hasMargin) lines.push(`- Margin:     ${actual.margin_pct}%`)
  if (actual.covers) lines.push(`- Covers:    ${actual.covers}`)
  if (actual.hours)  lines.push(`- Hours:     ${Math.round(actual.hours)}`)

  // Budget section
  if (budget) {
    lines.push('', 'BUDGET TARGETS:')
    if (budget.revenue_target)         lines.push(`- Revenue target:   ${Math.round(budget.revenue_target)} kr`)
    if (budget.food_cost_pct_target)   lines.push(`- Food cost target: ${budget.food_cost_pct_target}%`)
    if (budget.staff_cost_pct_target)  lines.push(`- Staff cost target: ${budget.staff_cost_pct_target}%`)
    if (budget.net_profit_target)      lines.push(`- Profit target:    ${Math.round(budget.net_profit_target)} kr`)
    if (budget.margin_pct_target)      lines.push(`- Margin target:    ${budget.margin_pct_target}%`)
  } else {
    lines.push('', 'BUDGET: no budget set for this month — compare vs last year instead.')
  }

  // Last year comparison (only include populated fields)
  const hasLy = lastYear.revenue || lastYear.staff_cost || lastYear.food_cost
  if (hasLy) {
    lines.push('', `LAST YEAR (${MONTHS[month - 1]} ${year - 1}) FOR CONTEXT:`)
    if (lastYear.revenue)    lines.push(`- Revenue:    ${lastYear.revenue} kr`)
    if (lastYear.staff_cost) lines.push(`- Staff cost: ${lastYear.staff_cost} kr`)
    if (lastYear.food_cost)  lines.push(`- Food cost:  ${lastYear.food_cost} kr`)
    if (lastYear.net_profit !== null) lines.push(`- Net profit: ${lastYear.net_profit} kr`)
    if (lastYear.margin_pct !== null) lines.push(`- Margin:     ${lastYear.margin_pct}%`)
  }

  const metricsAvailable: string[] = []
  if (hasRev)    metricsAvailable.push('revenue')
  if (hasStaff)  metricsAvailable.push('staff_cost')
  if (hasFood)   metricsAvailable.push('food_cost')
  if (hasProfit) metricsAvailable.push('net_profit')
  if (hasMargin) metricsAvailable.push('margin')

  const prompt = `You are analysing a single month's performance for a Swedish restaurant.

${SCOPE_NOTE}

${lines.join('\n')}

RULES:
- Only comment on metrics present above. DO NOT invent, guess, or mention metrics that have no data (e.g. if food cost is absent, say nothing about food cost).
- Available metrics to comment on: ${metricsAvailable.join(', ')}
- For each metric with data, compare to budget (if set) OR to last year (if available).
- Keep each message to one short sentence.
- Be direct — call out wins AND misses plainly. No fluff.
- Recommendations: 1-3 concrete, actionable items. Skip recommendations if nothing stands out.

Return JSON only, no markdown fence, no prose outside JSON:

{
  "verdict": "hit" | "missed" | "mixed",
  "headline": "<one punchy sentence summarising the month>",
  "analysis": [
    { "metric": "revenue"|"staff_cost"|"food_cost"|"net_profit"|"margin", "status": "good"|"bad"|"warn", "message": "<one sentence>" }
  ],
  "recommendations": ["<actionable item>", ...]
}`

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 })
  }

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    // Tool use: strict schema for single-month budget-vs-actual analysis.
    const submitAnalysisTool = {
      name: 'submit_analysis',
      description: 'Submit the single-month variance analysis.',
      input_schema: {
        type: 'object',
        properties: {
          verdict:  { type: 'string', description: 'One-sentence verdict on the month.' },
          drivers:  {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                metric:      { type: 'string' },
                direction:   { enum: ['above', 'below', 'on'] },
                magnitude:   { type: 'string' },
                explanation: { type: 'string' },
              },
              required: ['metric', 'direction', 'magnitude'],
            },
          },
          next_step: { type: 'string', description: 'One concrete action for the coming month.' },
        },
        required: ['verdict', 'drivers', 'next_step'],
      },
    }

    const startedAt = Date.now()
    const { promptFragment: localeFragment } = aiLocaleFromRequest(req)
    const response = await (claude as any).messages.create({
      model:      AI_MODELS.AGENT,
      max_tokens: 800,
      tools:      [submitAnalysisTool],
      tool_choice: { type: 'tool', name: 'submit_analysis' },
      system:     localeFragment,
      messages:   [{ role: 'user', content: prompt }],
    })

    const toolUse = (response.content ?? []).find((b: any) => b.type === 'tool_use')
    const parsed = toolUse?.input
    if (!parsed?.verdict) {
      return NextResponse.json({ error: 'AI response missing verdict', raw: response }, { status: 502 })
    }

    // Filter out any analysis rows referencing metrics that weren't available
    // (belt and braces — guards against Claude ignoring the "only comment on present metrics" rule)
    const allowed = new Set(metricsAvailable)
    const analysis = (parsed.analysis ?? []).filter((a: any) => allowed.has(a.metric))

    await incrementAiUsage(db, auth.orgId)
    await logAiRequest(db, {
      org_id:        auth.orgId,
      user_id:       auth.userId,
      request_type:  'budget_analyse',
      model:         AI_MODELS.AGENT,
      page:          'budget',
      input_tokens:  (response as any).usage?.input_tokens  ?? 0,
      output_tokens: (response as any).usage?.output_tokens ?? 0,
      duration_ms:   Date.now() - startedAt,
    })

    return NextResponse.json({
      verdict:         parsed.verdict ?? 'mixed',
      headline:        String(parsed.headline ?? ''),
      analysis,
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.slice(0, 5) : [],
    })

  } catch (err: any) {
    console.error('[budgets/analyse] AI error:', err)
    return NextResponse.json({ error: 'AI service error: ' + err.message }, { status: 503 })
  }
}
