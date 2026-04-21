// @ts-nocheck
// app/api/budgets/coach/route.ts
//
// AI Budget Coach — pace check for the current month. Answers the owner's
// real question: "am I on track, and if not, what do I do about it?"
//
// Reads: current month's budget (revenue target + cost % targets) and the
// MTD actuals from monthly_metrics / daily_metrics. Projects end-of-month,
// computes gap to target, asks Claude for a one-paragraph prescription.
// If the gap is in labour, the response links to /scheduling where the AI
// suggestion has the specific hours to trim.
//
// GET /api/budgets/coach?business_id=UUID
//   Auth: session cookie (same as the rest of /api/budgets)

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { AI_MODELS, MAX_TOKENS } from '@/lib/ai/models'
import { logAiRequest } from '@/lib/ai/usage'

export const dynamic    = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const bizId = req.nextUrl.searchParams.get('business_id')
  if (!bizId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db  = createAdminClient()
  const now = new Date()
  const year  = now.getFullYear()
  const month = now.getMonth() + 1
  const dayOfMonth  = now.getDate()
  const daysInMonth = new Date(year, month, 0).getDate()
  const pctElapsed  = dayOfMonth / daysInMonth   // 0..1

  // Business + ownership check
  const { data: biz } = await db.from('businesses').select('id, name, org_id, target_staff_pct, target_margin_pct').eq('id', bizId).maybeSingle()
  if (!biz || biz.org_id !== auth.orgId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const [budgetRes, mmRes, dailyRes] = await Promise.all([
    db.from('budgets')
      .select('revenue_target, food_cost_pct_target, staff_cost_pct_target, net_profit_target')
      .eq('business_id', bizId).eq('year', year).eq('month', month)
      .maybeSingle(),
    db.from('monthly_metrics')
      .select('revenue, staff_cost, food_cost, hours_worked')
      .eq('business_id', bizId).eq('year', year).eq('month', month)
      .maybeSingle(),
    db.from('daily_metrics')
      .select('date, revenue, staff_cost, hours_worked')
      .eq('business_id', bizId)
      .gte('date', `${year}-${String(month).padStart(2, '0')}-01`),
  ])

  const budget = budgetRes.data
  const mm     = mmRes.data
  const daily  = (dailyRes.data ?? []).filter(d => d.date <= now.toISOString().slice(0, 10))

  if (!budget || !budget.revenue_target) {
    return NextResponse.json({
      has_budget: false,
      narrative: null,
      hint: 'Set a budget for this month (or click "Generate with AI") to see pacing + recommendations.',
    })
  }

  const mtdRevenue     = Number(mm?.revenue    ?? daily.reduce((s: number, d: any) => s + Number(d.revenue ?? 0), 0))
  const mtdLabourCost  = Number(mm?.staff_cost ?? daily.reduce((s: number, d: any) => s + Number(d.staff_cost ?? 0), 0))
  const mtdFoodCost    = Number(mm?.food_cost  ?? 0)

  // Linear projection — naive but explains the dynamics well enough for a
  // coach paragraph. The AI can refine with its own narrative.
  const projectedRev        = pctElapsed > 0 ? mtdRevenue    / pctElapsed : 0
  const projectedLabour     = pctElapsed > 0 ? mtdLabourCost / pctElapsed : 0
  const projectedLabourPct  = projectedRev > 0 ? (projectedLabour / projectedRev) * 100 : 0
  const revenueGap          = Number(budget.revenue_target) - projectedRev
  const labourPctGap        = projectedLabourPct - Number(budget.staff_cost_pct_target ?? 40)
  const paceIndex           = projectedRev > 0 && budget.revenue_target > 0 ? (projectedRev / Number(budget.revenue_target)) : 1

  // Narrative is cheap but not free — skip when no budget set or less than
  // 3 days of data in the month (pacing math is noisy).
  let narrative: string | null = null
  if (dayOfMonth >= 3 && process.env.ANTHROPIC_API_KEY) {
    narrative = await generateNarrative(db, auth.orgId, {
      businessName: biz.name,
      year, month, dayOfMonth, daysInMonth,
      budget: {
        revenue_target:    Number(budget.revenue_target),
        food_pct_target:   Number(budget.food_cost_pct_target ?? 0),
        staff_pct_target:  Number(budget.staff_cost_pct_target ?? 0),
        profit_target:     Number(budget.net_profit_target ?? 0),
      },
      mtd: {
        revenue:     mtdRevenue,
        labour:      mtdLabourCost,
        food:        mtdFoodCost,
        pctElapsed,
      },
      projected: {
        revenue:     projectedRev,
        labour:      projectedLabour,
        labour_pct:  projectedLabourPct,
      },
      gaps: {
        revenue:   revenueGap,
        labour_pp: labourPctGap,
      },
    })
  }

  return NextResponse.json({
    has_budget: true,
    year, month,
    day_of_month:  dayOfMonth,
    days_in_month: daysInMonth,
    pct_elapsed:   pctElapsed,
    mtd: {
      revenue:    Math.round(mtdRevenue),
      labour:     Math.round(mtdLabourCost),
      food:       Math.round(mtdFoodCost),
    },
    projected: {
      revenue:    Math.round(projectedRev),
      labour:     Math.round(projectedLabour),
      labour_pct: Math.round(projectedLabourPct * 10) / 10,
    },
    pace_index:         Math.round(paceIndex * 1000) / 1000,
    revenue_gap:        Math.round(revenueGap),
    labour_pct_gap:     Math.round(labourPctGap * 10) / 10,
    // True when labour is the dominant issue — UI uses this to show a link to /scheduling
    labour_is_the_lever: labourPctGap > 1.5,
    narrative,
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}

async function generateNarrative(db: any, orgId: string, ctx: any): Promise<string | null> {
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const fmtKr = (n: number) => Math.round(n).toLocaleString('en-GB').replace(/,/g, ' ') + ' kr'
  const fmtPct = (n: number) => (Math.round(n * 10) / 10).toFixed(1) + '%'

  const prompt = `You are the budget coach for ${ctx.businessName}. It's day ${ctx.dayOfMonth} of ${MONTHS[ctx.month - 1]} ${ctx.year} (${Math.round(ctx.mtd.pctElapsed * 100)}% through). Write ONE short paragraph (70-110 words) that:

1. Open with a one-sentence verdict — on pace, ahead, or behind revenue target.
2. Call out the biggest lever for the rest of the month with a specific action. If labour % is running over target, the action should reference the /scheduling page ("trim next week's hours — the scheduling page shows the specific cuts").
3. End with a projected month-end number and whether the target will be hit.

Direct, Swedish-owner-to-owner tone. Use exact SEK numbers. No preamble, no "I recommend" — say it.

MONTH-TO-DATE
Revenue: ${fmtKr(ctx.mtd.revenue)} · target ${fmtKr(ctx.budget.revenue_target)} for the full month
Labour cost: ${fmtKr(ctx.mtd.labour)} · target ${fmtPct(ctx.budget.staff_pct_target)} of revenue
Food cost: ${fmtKr(ctx.mtd.food)} · target ${fmtPct(ctx.budget.food_pct_target)} of revenue

PROJECTED END-OF-MONTH (linear pacing)
Revenue: ${fmtKr(ctx.projected.revenue)} (${ctx.gaps.revenue >= 0 ? 'under' : 'over'} target by ${fmtKr(Math.abs(ctx.gaps.revenue))})
Labour: ${fmtKr(ctx.projected.labour)} (${fmtPct(ctx.projected.labour_pct)} of revenue — ${ctx.gaps.labour_pp >= 0 ? '+' : ''}${ctx.gaps.labour_pp}pp vs target)

Write the paragraph now.`

  const started = Date.now()
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
    const response  = await claude.messages.create({
      model:      AI_MODELS.AGENT,
      max_tokens: MAX_TOKENS.AGENT_SUMMARY,
      messages:   [{ role: 'user', content: prompt }],
    })
    const text = (response.content?.[0] as any)?.text?.trim() ?? ''

    try {
      await logAiRequest(db, {
        org_id:        orgId,
        request_type:  'budget_coach',
        model:         AI_MODELS.AGENT,
        input_tokens:  response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
        duration_ms:   Date.now() - started,
      })
    } catch { /* non-fatal */ }

    return text || null
  } catch (e: any) {
    console.error('[budgets/coach] Claude failed:', e.message)
    return null
  }
}
