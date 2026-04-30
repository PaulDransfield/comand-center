// @ts-nocheck
// app/api/group/overview/route.ts
//
// Group-level rollup for an org with multiple businesses. Returns:
//   - per-business KPIs for the selected period (+ prev period for deltas)
//   - aggregate totals across the group
//   - a Claude-written narrative paragraph that identifies the outlier
//     performer and prescribes ONE cross-business action ("Brus's Friday
//     rev/hour is X% below Carne's — copy Carne's staffing pattern, ~Y kr/wk")
//
// Designed to reuse the existing weekly-memo infrastructure. Uses the AGENT
// model (Haiku) — one call per request, ~300 output tokens.
//
// GET /api/group/overview?from=YYYY-MM-DD&to=YYYY-MM-DD
//   Defaults: current month. User must be authenticated.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { AI_MODELS, MAX_TOKENS } from '@/lib/ai/models'
import { SCOPE_NOTE }            from '@/lib/ai/scope'
import { INDUSTRY_BENCHMARKS, VOICE, SCHEDULING_ASYMMETRY } from '@/lib/ai/rules'
import { logAiRequest } from '@/lib/ai/usage'
import { aiLocaleFromRequest } from '@/lib/ai/locale'
import { requireOwnerRole } from '@/lib/auth/require-role'
import { filterAccessibleBusinesses } from '@/lib/auth/permissions'

export const dynamic    = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  // M043: /group is owner-only at the page level. Mirror at the API.
  const ownerForbidden = requireOwnerRole(auth); if (ownerForbidden) return ownerForbidden

  const u       = new URL(req.url)
  const now     = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
  const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10)
  const from    = u.searchParams.get('from') ?? monthStart
  const to      = u.searchParams.get('to')   ?? monthEnd
  // Prev period = same-length window ending the day before `from`
  const fromD   = new Date(from + 'T00:00:00')
  const toD     = new Date(to   + 'T00:00:00')
  const periodDays = Math.round((toD.getTime() - fromD.getTime()) / 86_400_000) + 1
  const prevTo   = new Date(fromD); prevTo.setDate(prevTo.getDate() - 1)
  const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - periodDays + 1)
  const prevFromStr = prevFrom.toISOString().slice(0, 10)
  const prevToStr   = prevTo.toISOString().slice(0, 10)

  const db = createAdminClient()

  // All active businesses for this org
  const { data: businesses } = await db
    .from('businesses')
    .select('id, name, city, colour, target_staff_pct, target_margin_pct')
    .eq('org_id', auth.orgId)
    .eq('is_active', true)
    .order('name')

  if (!businesses?.length) {
    return NextResponse.json({ businesses: [], summary: null, narrative: null })
  }

  // Pull daily_metrics for both periods across all businesses in one go
  const bizIds = businesses.map(b => b.id)
  const [curRes, prevRes] = await Promise.all([
    db.from('daily_metrics')
      .select('business_id, date, revenue, staff_cost, hours_worked, covers, labour_pct')
      .eq('org_id', auth.orgId)
      .in('business_id', bizIds)
      .gte('date', from),
    db.from('daily_metrics')
      .select('business_id, date, revenue, staff_cost, hours_worked, covers')
      .eq('org_id', auth.orgId)
      .in('business_id', bizIds)
      .gte('date', prevFromStr),
  ])
  // Supabase date upper-bound filter bug — filter in memory (FIXES.md §0)
  const curRows  = (curRes.data  ?? []).filter(r => r.date <= to)
  const prevRows = (prevRes.data ?? []).filter(r => r.date <= prevToStr)

  // Aggregate per business + keep the raw daily sequence for per-card sparklines
  const emptyAgg = () => ({ revenue: 0, staff_cost: 0, hours: 0, covers: 0, days: 0 })
  const cur:  Record<string, any>  = {}
  const prev: Record<string, any>  = {}
  const daily: Record<string, Array<{ date: string; revenue: number }>> = {}
  for (const id of bizIds) { cur[id] = emptyAgg(); prev[id] = emptyAgg(); daily[id] = [] }

  for (const r of curRows) {
    const b = cur[r.business_id]; if (!b) continue
    if (r.revenue > 0 || r.staff_cost > 0) b.days += 1
    b.revenue    += Number(r.revenue    ?? 0)
    b.staff_cost += Number(r.staff_cost ?? 0)
    b.hours      += Number(r.hours_worked ?? 0)
    b.covers     += Number(r.covers     ?? 0)
    daily[r.business_id].push({ date: r.date, revenue: Number(r.revenue ?? 0) })
  }
  for (const r of prevRows) {
    const b = prev[r.business_id]; if (!b) continue
    b.revenue    += Number(r.revenue    ?? 0)
    b.staff_cost += Number(r.staff_cost ?? 0)
    b.hours      += Number(r.hours_worked ?? 0)
    b.covers     += Number(r.covers     ?? 0)
  }
  // Sort each daily series by date and trim to last 30 days — the sparkline
  // only needs a compact trend, not the full window.
  for (const id of bizIds) {
    daily[id].sort((a, b) => a.date.localeCompare(b.date))
    if (daily[id].length > 30) daily[id] = daily[id].slice(-30)
  }

  // Shape per-business rows
  const rows = businesses.map(biz => {
    const c = cur[biz.id]
    const p = prev[biz.id]
    const labourPct    = c.revenue > 0 ? (c.staff_cost / c.revenue) * 100 : null
    const revPerHour   = c.hours   > 0 ? c.revenue / c.hours : null
    const margin       = c.revenue - c.staff_cost                    // pre-food/rent margin
    const marginPct    = c.revenue > 0 ? (margin / c.revenue) * 100 : null
    const revenueDelta = p.revenue > 0 ? ((c.revenue - p.revenue) / p.revenue) * 100 : null
    return {
      id:            biz.id,
      name:          biz.name,
      city:          biz.city,
      colour:        biz.colour,
      target_staff_pct:  Number(biz.target_staff_pct ?? 40),
      target_margin_pct: Number(biz.target_margin_pct ?? 12),
      revenue:       Math.round(c.revenue),
      staff_cost:    Math.round(c.staff_cost),
      hours:         Math.round(c.hours * 10) / 10,
      covers:        c.covers,
      days_with_data: c.days,
      labour_pct:    labourPct    != null ? Math.round(labourPct    * 10) / 10 : null,
      margin_pct:    marginPct    != null ? Math.round(marginPct    * 10) / 10 : null,
      rev_per_hour:  revPerHour   != null ? Math.round(revPerHour) : null,
      rev_per_cover: c.covers > 0 ? Math.round(c.revenue / c.covers) : null,
      prev_revenue:  Math.round(p.revenue),
      revenue_delta_pct: revenueDelta != null ? Math.round(revenueDelta * 10) / 10 : null,
      daily_revenue: daily[biz.id],   // compact time series for the card sparkline
    }
  })

  // Group totals
  const totalRevenue  = rows.reduce((s, r) => s + r.revenue,    0)
  const totalLabour   = rows.reduce((s, r) => s + r.staff_cost, 0)
  const totalHours    = rows.reduce((s, r) => s + r.hours,      0)
  const totalCovers   = rows.reduce((s, r) => s + r.covers,     0)
  const groupLabourPct = totalRevenue > 0 ? (totalLabour / totalRevenue) * 100 : null
  const groupMarginPct = totalRevenue > 0 ? ((totalRevenue - totalLabour) / totalRevenue) * 100 : null

  // Rank for narrative
  const ranked = [...rows].filter(r => r.revenue > 0)
  const byMargin    = [...ranked].sort((a, b) => (b.margin_pct ?? -1e9) - (a.margin_pct ?? -1e9))
  const byLabourPct = [...ranked].sort((a, b) => (a.labour_pct ?? 1e9)  - (b.labour_pct ?? 1e9))
  const byRevPerHr  = [...ranked].sort((a, b) => (b.rev_per_hour ?? 0)  - (a.rev_per_hour ?? 0))

  const summary = {
    period_from:      from,
    period_to:        to,
    business_count:   rows.length,
    total_revenue:    totalRevenue,
    total_staff_cost: totalLabour,
    total_hours:      totalHours,
    total_covers:     totalCovers,
    group_labour_pct: groupLabourPct != null ? Math.round(groupLabourPct * 10) / 10 : null,
    group_margin_pct: groupMarginPct != null ? Math.round(groupMarginPct * 10) / 10 : null,
    top_margin:    byMargin[0]?.name    ?? null,
    top_lean:      byLabourPct[0]?.name ?? null,
    top_output:    byRevPerHr[0]?.name  ?? null,
  }

  // Generate AI narrative — only if we have 2+ businesses with data
  let narrative: string | null = null
  let items: Array<{ tone: string; entity: string; message: string }> | null = null
  if (ranked.length >= 2 && process.env.ANTHROPIC_API_KEY) {
    const aiOut = await generateNarrative(db, auth.orgId, rows, summary)
    narrative = aiOut.narrative
    items     = aiOut.items
  }

  return NextResponse.json({
    businesses: rows,
    summary,
    narrative,
    items,
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Narrative generator — single Haiku call that identifies the outlier + one
// cross-business action. Deliberately short, opinionated, SEK-quantified.
// ─────────────────────────────────────────────────────────────────────────────
async function generateNarrative(
  db: any, orgId: string, rows: any[], summary: any,
): Promise<{ narrative: string | null; items: Array<{ tone: string; entity: string; message: string }> | null }> {
  const prompt = `You are the group operations manager of a restaurant group with ${rows.length} locations. You have their trading data for ${summary.period_from} to ${summary.period_to}.

${SCOPE_NOTE}

${INDUSTRY_BENCHMARKS}

${VOICE}

${SCHEDULING_ASYMMETRY}

Return a JSON object with EXACTLY this shape and nothing else:

{
  "items": [
    { "tone": "bad" | "warning" | "good", "entity": "<location name>", "message": "<short action, max 120 chars>" }
  ]
}

Rules for items:
- Produce 2 or 3 items, covering DIFFERENT angles:
  (a) the biggest problem → tone "bad" or "warning", with a specific action (close / cut hours / restructure).
  (b) an opportunity or reallocation → tone "warning", suggesting moving hours or capacity from the weak site to the strong one, with an estimated SEK/week impact.
  (c) what's working → tone "good", praising the best performer and naming what to preserve (schedule pattern, rev/hour, etc.).
- Each "message" must be ≤ 120 characters, plain English, no preamble.
- Each "entity" must be the exact location name from the data below.
- If a location has high labour % (over 80%) with low revenue, that's the problem bullet.
- If only one location has meaningful revenue, item (b) may be omitted.

TRADING DATA (all ex-VAT, SEK)

Group total: revenue ${fmtKr(summary.total_revenue)}, labour ${fmtKr(summary.total_staff_cost)} (${summary.group_labour_pct ?? '—'}%), margin ${summary.group_margin_pct ?? '—'}%
Period: ${summary.period_from} to ${summary.period_to}

Per business:
${rows.map(r => `  ${r.name} — rev ${fmtKr(r.revenue)} (${r.revenue_delta_pct != null ? (r.revenue_delta_pct >= 0 ? '+' : '') + r.revenue_delta_pct + '%' : '—'} vs prev), labour ${fmtKr(r.staff_cost)} (${r.labour_pct ?? '—'}%), margin ${r.margin_pct ?? '—'}%, ${r.hours}h, ${r.rev_per_hour ? fmtKr(r.rev_per_hour) + '/hr' : '—/hr'}, ${r.covers} covers`).join('\n')}

Return ONLY the JSON object — no code fence, no preamble, no trailing prose.`

  const started = Date.now()
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
    const { promptFragment: localeFragment } = aiLocaleFromRequest(req)
    const response  = await claude.messages.create({
      model:      AI_MODELS.AGENT,
      max_tokens: MAX_TOKENS.AGENT_SUMMARY,
      system:     localeFragment,
      messages:   [{ role: 'user', content: prompt }],
    })
    const text = (response.content?.[0] as any)?.text?.trim() ?? ''

    try {
      await logAiRequest(db, {
        org_id:        orgId,
        request_type:  'group_overview',
        model:         AI_MODELS.AGENT,
        input_tokens:  response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
        duration_ms:   Date.now() - started,
      })
    } catch { /* non-fatal */ }

    if (!text) return { narrative: null, items: null }

    // Parse the JSON object the model was asked to produce. Strip any leading
    // code fence defensively — some Haiku responses still wrap in ```json.
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    try {
      const parsed = JSON.parse(cleaned)
      const out: Array<{ tone: string; entity: string; message: string }> = []
      if (Array.isArray(parsed?.items)) {
        for (const it of parsed.items) {
          if (!it || typeof it.message !== 'string') continue
          const tone   = ['good', 'warning', 'bad'].includes(it.tone) ? it.tone : 'warning'
          const entity = typeof it.entity === 'string' ? it.entity.slice(0, 40) : 'Group'
          const message = it.message.trim().slice(0, 160)
          out.push({ tone, entity, message })
        }
      }
      return { narrative: text, items: out.length ? out.slice(0, 3) : null }
    } catch {
      // Parse failed — return the raw text as fallback narrative.
      return { narrative: text, items: null }
    }
  } catch (e: any) {
    console.error('[group/overview] Claude call failed:', e.message)
    return { narrative: null, items: null }
  }
}

function fmtKr(n: number): string {
  return Math.round(n).toLocaleString('en-GB').replace(/,/g, ' ') + ' kr'
}
