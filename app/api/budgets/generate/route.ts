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

export const dynamic    = 'force-dynamic'
export const maxDuration = 60

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const businessId = body.business_id
  const year       = Number(body.year ?? new Date().getFullYear())
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()

  // Daily AI query gate — counts the same as an /api/ask call against the plan limit.
  const gate = await checkAiLimit(db, auth.orgId)
  if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status })

  // ── 1. Gather context: last year actuals, this year's forecasts, YTD actuals ──
  // Every tenanted read filters org_id first — service role bypasses RLS.
  const [lyRes, fcRes, ytdRes, bizRes] = await Promise.all([
    // Last year actuals from monthly_metrics
    db.from('monthly_metrics')
      .select('month, revenue, staff_cost, food_cost, net_profit, margin_pct')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .eq('year', year - 1)
      .order('month'),
    // Calibrated forecasts for this year
    db.from('forecasts')
      .select('period_month, revenue_forecast, staff_cost_forecast, food_cost_forecast, net_profit_forecast, margin_forecast')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .eq('period_year', year)
      .order('period_month'),
    // Current year actuals so far
    db.from('monthly_metrics')
      .select('month, revenue, staff_cost, food_cost, net_profit, margin_pct')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .eq('year', year)
      .order('month'),
    db.from('businesses').select('name, city').eq('org_id', auth.orgId).eq('id', businessId).maybeSingle(),
  ])

  const lastYear = lyRes.data ?? []
  const forecasts = fcRes.data ?? []
  const ytd       = ytdRes.data ?? []
  const biz       = bizRes.data

  // ── 2. Format the data into a compact context for Claude ─────────────────────
  const fmt = (n: any) => (n === null || n === undefined) ? '?' : Math.round(Number(n)).toLocaleString('en-GB')

  const lyTable = lastYear.length
    ? lastYear.map(r =>
        `  ${MONTHS[r.month - 1]}: rev=${fmt(r.revenue)} staff=${fmt(r.staff_cost)} food=${fmt(r.food_cost)} net=${fmt(r.net_profit)} margin=${r.margin_pct ?? '?'}%`
      ).join('\n')
    : '  (no prior-year data)'

  const ytdTable = ytd.length
    ? ytd.map(r =>
        `  ${MONTHS[r.month - 1]}: rev=${fmt(r.revenue)} staff=${fmt(r.staff_cost)} food=${fmt(r.food_cost)} net=${fmt(r.net_profit)} margin=${r.margin_pct ?? '?'}%`
      ).join('\n')
    : '  (no current-year actuals yet)'

  const fcTable = forecasts.length
    ? forecasts.map(r =>
        `  ${MONTHS[r.period_month - 1]}: rev_forecast=${fmt(r.revenue_forecast)} staff_forecast=${fmt(r.staff_cost_forecast)} food_forecast=${fmt(r.food_cost_forecast)} net_forecast=${fmt(r.net_profit_forecast)}`
      ).join('\n')
    : '  (no forecasts yet)'

  const prompt = `You are helping set monthly budget targets for a Swedish restaurant: "${biz?.name ?? 'Unknown'}"${biz?.city ? ` in ${biz.city}` : ''}.

Your job: return 12 monthly budgets for ${year} that are realistic, slightly ambitious, and usable as stretch targets. These become operational goals the team will be measured against.

All figures in Swedish kronor (kr). All percentages in 0-100 (e.g. 31 for 31%).

LAST YEAR (${year - 1}) ACTUALS:
${lyTable}

${year} CURRENT-YEAR ACTUALS SO FAR:
${ytdTable}

CALIBRATED FORECASTS FOR ${year} (per-business calibrated, trust these as the baseline):
${fcTable}

INDUSTRY GUARDRAILS (Swedish casual/mid-market restaurants):
- Food cost: ~28-32% of revenue
- Staff cost: ~35-42% of revenue
- Net profit margin: ~10-15%

SEASONALITY TO CONSIDER (Sweden):
- Jan: post-holiday slow
- Feb-Apr: steady
- May-Aug: outdoor-dining peak, summer tourists
- Sep-Oct: return to workplace routines
- Nov-Dec: holiday peak

RULES:
- revenue_target should be slightly above forecast (5-10% stretch) unless YTD data clearly suggests otherwise
- food_cost_pct_target should target lower end of industry range when margin is healthy
- staff_cost_pct_target should be realistic — use last year's actual staff cost ratio as starting point
- net_profit_target = revenue_target × (1 - food_pct/100 - staff_pct/100 - 10% other-cost assumption)
- reasoning: one short sentence, mention ONE concrete datapoint from above (e.g. "last April hit 420k so stretch to 460k")

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

    const startedAt = Date.now()
    const response = await claude.messages.create({
      model:      AI_MODELS.AGENT,
      max_tokens: 2500, // 12 months × ~150 tokens each + overall strategy + JSON overhead
      messages:   [{ role: 'user', content: prompt }],
    })

    const text = (response.content?.[0] as any)?.text ?? ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return NextResponse.json({ error: 'AI response not valid JSON', raw: text }, { status: 502 })
    }

    let parsed: any
    try { parsed = JSON.parse(jsonMatch[0]) } catch (e: any) {
      return NextResponse.json({ error: 'AI response parse failed: ' + e.message, raw: text }, { status: 502 })
    }

    // Normalise: ensure we have 12 months. Fill gaps with zeros.
    const byMonth = new Map<number, any>()
    for (const s of parsed.monthly ?? []) {
      if (s.month >= 1 && s.month <= 12) byMonth.set(s.month, s)
    }
    const monthly = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1
      const s = byMonth.get(m)
      return {
        month:                  m,
        revenue_target:         Math.round(Number(s?.revenue_target         ?? 0)),
        food_cost_pct_target:   Math.round(Number(s?.food_cost_pct_target   ?? 31)),
        staff_cost_pct_target:  Math.round(Number(s?.staff_cost_pct_target  ?? 40)),
        net_profit_target:      Math.round(Number(s?.net_profit_target      ?? 0)),
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

    return NextResponse.json({
      overall_strategy: String(parsed.overall_strategy ?? ''),
      monthly,
      context_used: {
        last_year_months:  lastYear.length,
        ytd_months:        ytd.length,
        forecast_months:   forecasts.length,
      },
    })

  } catch (err: any) {
    console.error('[budgets/generate] AI error:', err)
    return NextResponse.json({ error: 'AI service error: ' + err.message }, { status: 503 })
  }
}
