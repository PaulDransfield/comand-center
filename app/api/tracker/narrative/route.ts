// @ts-nocheck
// app/api/tracker/narrative/route.ts
//
// Claude-written paragraph that explains the month's P&L in plain language.
// Goes on /tracker above the table. Unlike competitor tools that show the
// number and leave you to work out why, we tell the owner what drove it.
//
// Example output:
//   "April margin 18.2%, down 2.4 pts from March. Labour % rose 1.1 pts
//   driven by 14 hours of OB on the St Patrick's weekend (27-29 Mar).
//   Food cost up 0.8 pts — Carne's supplier raised prices on 12 Mar.
//   Net: 46 200 kr, on track for the 12% full-year target."
//
// GET /api/tracker/narrative?business_id=UUID[&year=YYYY&month=M]
//   Defaults to the most recent month with revenue > 0.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { AI_MODELS, MAX_TOKENS } from '@/lib/ai/models'
import { SCOPE_NOTE } from '@/lib/ai/scope'
import { logAiRequest } from '@/lib/ai/usage'
import { requireFinanceAccess, requireBusinessAccess } from '@/lib/auth/require-role'

export const dynamic    = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const finForbidden = requireFinanceAccess(auth); if (finForbidden) return finForbidden

  const u      = new URL(req.url)
  const bizId  = u.searchParams.get('business_id')
  let   year   = Number(u.searchParams.get('year')  ?? 0)
  let   month  = Number(u.searchParams.get('month') ?? 0)

  if (!bizId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const bizForbidden = requireBusinessAccess(auth, bizId); if (bizForbidden) return bizForbidden

  const db = createAdminClient()

  const { data: biz } = await db
    .from('businesses')
    .select('id, name, org_id, target_staff_pct, target_food_pct, target_margin_pct')
    .eq('id', bizId)
    .maybeSingle()
  if (!biz || biz.org_id !== auth.orgId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Resolve the target month — if caller didn't specify, use the most recent
  // month with any revenue.
  if (!year || !month) {
    const { data: latest } = await db
      .from('monthly_metrics')
      .select('year, month, revenue')
      .eq('business_id', bizId)
      .gt('revenue', 0)
      .order('year', { ascending: false })
      .order('month', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!latest) {
      return NextResponse.json({ narrative: null, reason: 'no_revenue_data' })
    }
    year  = latest.year
    month = latest.month
  }

  // Previous month for deltas
  const prevMonth = month === 1 ? 12 : month - 1
  const prevYear  = month === 1 ? year - 1 : year

  const [cmRes, pmRes, trRes, budgetRes, alertsRes] = await Promise.all([
    // Current month metrics
    db.from('monthly_metrics')
      .select('revenue, staff_cost, food_cost, rent_cost, other_cost, net_profit, margin_pct, labour_pct, food_pct, covers, hours_worked, shifts')
      .eq('business_id', bizId).eq('year', year).eq('month', month)
      .maybeSingle(),
    // Previous month metrics
    db.from('monthly_metrics')
      .select('revenue, staff_cost, food_cost, margin_pct, labour_pct, food_pct')
      .eq('business_id', bizId).eq('year', prevYear).eq('month', prevMonth)
      .maybeSingle(),
    // Manual tracker data (covers fixed costs + corrections)
    db.from('tracker_data')
      .select('revenue, food_cost, staff_cost, rent_cost, other_cost, net_profit, margin_pct')
      .eq('business_id', bizId).eq('period_year', year).eq('period_month', month)
      .maybeSingle(),
    // Budget target for this month
    db.from('budgets')
      .select('revenue_target, food_cost_pct_target, staff_cost_pct_target')
      .eq('business_id', bizId).eq('year', year).eq('month', month)
      .maybeSingle(),
    // Anomalies flagged in this month
    db.from('anomaly_alerts')
      .select('title, severity, description')
      .eq('business_id', bizId)
      .gte('period_date', `${year}-${String(month).padStart(2, '0')}-01`)
      .lte('period_date', `${year}-${String(month).padStart(2, '0')}-31`)
      .order('severity', { ascending: false })
      .limit(4),
  ])

  const cm = cmRes.data
  if (!cm || Number(cm.revenue ?? 0) === 0) {
    return NextResponse.json({ narrative: null, reason: 'no_revenue_data', year, month })
  }

  const tr  = trRes.data ?? {}
  const pm  = pmRes.data
  const bud = budgetRes.data

  // Prefer tracker_data values where present (they're the manual corrections
  // entered on /tracker — e.g. food cost, rent, other costs that don't sync).
  const revenue    = Number(tr.revenue    ?? cm.revenue ?? 0)
  const staffCost  = Number(tr.staff_cost ?? cm.staff_cost ?? 0)
  const foodCost   = Number(tr.food_cost  ?? cm.food_cost ?? 0)
  const rentCost   = Number(tr.rent_cost  ?? cm.rent_cost ?? 0)
  const otherCost  = Number(tr.other_cost ?? cm.other_cost ?? 0)
  const netProfit  = revenue - staffCost - foodCost - rentCost - otherCost
  const marginPct  = revenue > 0 ? (netProfit / revenue) * 100 : null
  const labourPct  = revenue > 0 ? (staffCost / revenue) * 100 : null
  const foodPct    = revenue > 0 && foodCost > 0 ? (foodCost / revenue) * 100 : null

  // Anomalies and alerts as raw hints for the model
  const alertBlurb = (alertsRes.data ?? [])
    .map((a: any) => `- [${a.severity}] ${a.title} — ${a.description ?? ''}`)
    .join('\n')

  const narrative = await generateNarrative(db, auth.orgId, {
    businessName: biz.name,
    year, month,
    current:  { revenue, staffCost, foodCost, rentCost, otherCost, netProfit, marginPct, labourPct, foodPct, covers: cm.covers ?? 0, hours: cm.hours_worked ?? 0, shifts: cm.shifts ?? 0 },
    prev:     pm ? {
      revenue:     Number(pm.revenue ?? 0),
      staffCost:   Number(pm.staff_cost ?? 0),
      foodCost:    Number(pm.food_cost ?? 0),
      marginPct:   pm.margin_pct != null ? Number(pm.margin_pct) : null,
      labourPct:   pm.labour_pct != null ? Number(pm.labour_pct) : null,
      foodPct:     pm.food_pct   != null ? Number(pm.food_pct)   : null,
    } : null,
    targets:  bud ? {
      revenue:    Number(bud.revenue_target ?? 0),
      foodPct:    Number(bud.food_cost_pct_target ?? 0),
      staffPct:   Number(bud.staff_cost_pct_target ?? 0),
    } : null,
    businessTargets: {
      staffPct:  Number(biz.target_staff_pct  ?? 40),
      foodPct:   Number(biz.target_food_pct   ?? 31),
      marginPct: Number(biz.target_margin_pct ?? 12),
    },
    alerts: alertBlurb,
  })

  return NextResponse.json({
    narrative,
    year, month,
    metrics: {
      revenue, staff_cost: staffCost, food_cost: foodCost, rent_cost: rentCost, other_cost: otherCost,
      net_profit: netProfit, margin_pct: marginPct, labour_pct: labourPct, food_pct: foodPct,
    },
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}

async function generateNarrative(db: any, orgId: string, ctx: any): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const monthName = MONTHS[ctx.month - 1]

  const d = (cur: number, prev: number) => {
    if (!prev) return '—'
    const p = ((cur - prev) / prev) * 100
    return `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`
  }

  const prompt = `You are the owner-operator of ${ctx.businessName} reading your own P&L.

${SCOPE_NOTE}

Write ONE short paragraph (80-120 words) that explains what happened in ${monthName} ${ctx.year}. You must:

1. Open with a one-sentence verdict on margin — hit or missed target, direction vs last month.
2. Call out the 1-2 biggest drivers (labour %, food %, or a specific cost) with concrete numbers.
3. If anomalies are listed below, explain briefly what they pointed at.
4. End with either a "next month" action or a positive note if the month was clean.

Be Swedish-owner-to-owner, direct, no preamble. Use exact SEK numbers from the data. No "I recommend" / "consider" — just say it. No JSON, plain prose.

${monthName} ${ctx.year} — ${ctx.businessName}

Revenue:     ${fmtKr(ctx.current.revenue)} ${ctx.prev ? `(${d(ctx.current.revenue, ctx.prev.revenue)} vs prev month)` : ''}
Labour cost: ${fmtKr(ctx.current.staffCost)} ${ctx.current.labourPct != null ? `(${ctx.current.labourPct.toFixed(1)}%)` : ''} ${ctx.prev?.labourPct != null ? `vs ${ctx.prev.labourPct.toFixed(1)}% prev` : ''} · target ${ctx.businessTargets.staffPct}%
Food cost:   ${fmtKr(ctx.current.foodCost)} ${ctx.current.foodPct != null ? `(${ctx.current.foodPct.toFixed(1)}%)` : ''} ${ctx.prev?.foodPct != null ? `vs ${ctx.prev.foodPct.toFixed(1)}% prev` : ''} · target ${ctx.businessTargets.foodPct}%
Rent:        ${fmtKr(ctx.current.rentCost)}
Other:       ${fmtKr(ctx.current.otherCost)}
Net profit:  ${fmtKr(ctx.current.netProfit)} ${ctx.current.marginPct != null ? `(${ctx.current.marginPct.toFixed(1)}%)` : ''} · target ${ctx.businessTargets.marginPct}%
${ctx.targets ? `Budget target revenue: ${fmtKr(ctx.targets.revenue)}` : ''}

${ctx.current.covers > 0 ? `Covers: ${ctx.current.covers}, Hours: ${ctx.current.hours}h, Shifts: ${ctx.current.shifts}` : ''}

${ctx.alerts ? `ALERTS FLAGGED THIS MONTH:\n${ctx.alerts}` : 'No anomalies flagged this month.'}

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
        request_type:  'tracker_narrative',
        model:         AI_MODELS.AGENT,
        input_tokens:  response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
        duration_ms:   Date.now() - started,
      })
    } catch { /* non-fatal */ }

    return text || null
  } catch (e: any) {
    console.error('[tracker/narrative] Claude failed:', e.message)
    return null
  }
}

function fmtKr(n: number): string {
  return Math.round(n).toLocaleString('en-GB').replace(/,/g, ' ') + ' kr'
}
