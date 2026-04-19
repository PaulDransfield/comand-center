// lib/ai/weekly-manager.ts
//
// Generates a Claude-written "weekly manager memo" per business — a personal,
// opinionated analysis with 3 numbered actions each with SEK impact.
//
// Not a template digest — this is prose. The goal is: the owner reads it and
// thinks "the AI noticed something I missed" at least once a month.
//
// Called from app/api/cron/weekly-digest/route.ts (Monday 06:00 UTC). Tokens
// + cost logged to ai_request_log via logAiRequest.

import { AI_MODELS, MAX_TOKENS } from '@/lib/ai/models'
import { logAiRequest }          from '@/lib/ai/usage'

type Db = any

export interface ManagerMemo {
  narrative:   string        // The 150–200 word memo
  actions:     Array<{
    title:     string
    impact:    string        // e.g. "+4 200 kr/wk"
    reasoning: string
  }>
  facts_cited: string[]      // Structured list of facts the memo relies on
}

export interface WeeklyContext {
  businessName: string
  weekLabel:    string       // "Week 14 — 6 Apr to 12 Apr 2026"
  thisWeek:     WeekBlock
  lastWeek:     WeekBlock
  prior4Weeks:  WeekBlock[]  // oldest first, excludes this + last week
  monthToDate:  MonthBlock
  openAlerts:   Array<{ title: string; severity: string; description: string }>
  budget:       { revenue_target: number; food_cost_pct_target: number; staff_cost_pct_target: number } | null
  departments:  Array<{ name: string; revenue: number; labour_pct: number | null }>
  weekdayPattern: Array<{ weekday: string; avg_rev: number; avg_hours: number; avg_labour_pct: number | null }>
}

interface WeekBlock {
  from:         string
  to:           string
  revenue:      number
  staff_cost:   number
  labour_pct:   number | null
  hours:        number
  shifts:       number
  covers:       number
}

interface MonthBlock {
  year:        number
  month:       number
  revenue:     number
  staff_cost:  number
  food_cost:   number
}

// ─────────────────────────────────────────────────────────────────────────────
// Build the context blob — what we feed to Claude.
// ─────────────────────────────────────────────────────────────────────────────
export async function buildWeeklyContext(
  db:           Db,
  orgId:        string,
  businessId:   string,
  businessName: string,
  mondayOfBriefing: Date,  // the Monday AFTER the week being summarised
): Promise<WeeklyContext> {
  const lastSunday = new Date(mondayOfBriefing); lastSunday.setDate(lastSunday.getDate() - 1)
  const lastMonday = new Date(mondayOfBriefing); lastMonday.setDate(lastMonday.getDate() - 7)
  const toDate     = lastSunday.toISOString().slice(0, 10)
  const fromDate   = lastMonday.toISOString().slice(0, 10)

  const weekBefore = new Date(lastMonday); weekBefore.setDate(weekBefore.getDate() - 7)
  const weekBeforeTo = new Date(lastSunday); weekBeforeTo.setDate(weekBeforeTo.getDate() - 7)

  const priorStart = new Date(weekBefore); priorStart.setDate(priorStart.getDate() - 28)
  const priorEnd   = new Date(weekBefore); priorEnd.setDate(priorEnd.getDate() - 1)

  // 6 weeks of daily_metrics to cover: this week, last week, 4 prior weeks.
  const { data: dailies } = await db
    .from('daily_metrics')
    .select('date, revenue, staff_cost, hours_worked, shifts, covers, labour_pct')
    .eq('business_id', businessId)
    .gte('date', priorStart.toISOString().slice(0, 10))
    .lte('date', toDate)
    .order('date', { ascending: true })

  const weekBlock = (from: Date, to: Date): WeekBlock => {
    const fromS = from.toISOString().slice(0, 10)
    const toS   = to.toISOString().slice(0, 10)
    const rows  = (dailies ?? []).filter((r: any) => r.date >= fromS && r.date <= toS)
    const rev    = rows.reduce((s: number, r: any) => s + Number(r.revenue ?? 0), 0)
    const cost   = rows.reduce((s: number, r: any) => s + Number(r.staff_cost ?? 0), 0)
    const hours  = rows.reduce((s: number, r: any) => s + Number(r.hours_worked ?? 0), 0)
    const shifts = rows.reduce((s: number, r: any) => s + Number(r.shifts ?? 0), 0)
    const covers = rows.reduce((s: number, r: any) => s + Number(r.covers ?? 0), 0)
    return {
      from: fromS, to: toS,
      revenue: Math.round(rev), staff_cost: Math.round(cost),
      labour_pct: rev > 0 ? Math.round((cost / rev) * 1000) / 10 : null,
      hours: Math.round(hours * 10) / 10, shifts, covers,
    }
  }

  const thisWeek = weekBlock(lastMonday, lastSunday)
  const lastWeekBlk = weekBlock(weekBefore, weekBeforeTo)

  const prior4Weeks: WeekBlock[] = []
  for (let i = 4; i >= 2; i--) {
    const wStart = new Date(lastMonday); wStart.setDate(wStart.getDate() - 7 * i)
    const wEnd   = new Date(lastSunday); wEnd.setDate(wEnd.getDate() - 7 * i)
    prior4Weeks.push(weekBlock(wStart, wEnd))
  }

  // Weekday pattern: avg per day-of-week from the 4 prior weeks.
  const byDow: Record<number, { rev: number[]; hours: number[]; labour: number[] }> = {}
  for (let d = 0; d < 7; d++) byDow[d] = { rev: [], hours: [], labour: [] }
  for (const r of (dailies ?? [])) {
    if (!r.date) continue
    if (r.date > priorEnd.toISOString().slice(0, 10)) continue  // only 4 prior weeks
    const dow = (new Date(r.date).getUTCDay() + 6) % 7          // Mon=0 … Sun=6
    byDow[dow].rev.push(Number(r.revenue ?? 0))
    byDow[dow].hours.push(Number(r.hours_worked ?? 0))
    if (r.labour_pct != null) byDow[dow].labour.push(Number(r.labour_pct))
  }
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const avg = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0
  const weekdayPattern = DAYS.map((label, i) => ({
    weekday:         label,
    avg_rev:         Math.round(avg(byDow[i].rev)),
    avg_hours:       Math.round(avg(byDow[i].hours) * 10) / 10,
    avg_labour_pct:  byDow[i].labour.length ? Math.round(avg(byDow[i].labour) * 10) / 10 : null,
  }))

  // Month-to-date at time of the briefing.
  const mtdMonth = lastSunday.getMonth() + 1
  const mtdYear  = lastSunday.getFullYear()
  const { data: mm } = await db
    .from('monthly_metrics')
    .select('revenue, staff_cost, food_cost')
    .eq('business_id', businessId)
    .eq('year',  mtdYear)
    .eq('month', mtdMonth)
    .maybeSingle()
  const monthToDate: MonthBlock = {
    year: mtdYear, month: mtdMonth,
    revenue:    Number(mm?.revenue    ?? 0),
    staff_cost: Number(mm?.staff_cost ?? 0),
    food_cost:  Number(mm?.food_cost  ?? 0),
  }

  // Budget for this month
  const { data: bud } = await db
    .from('budgets')
    .select('revenue_target, food_cost_pct_target, staff_cost_pct_target')
    .eq('business_id', businessId).eq('year', mtdYear).eq('month', mtdMonth)
    .maybeSingle()

  // Last 14 days of open alerts
  const sinceAlerts = new Date(lastMonday); sinceAlerts.setDate(sinceAlerts.getDate() - 14)
  const { data: alerts } = await db
    .from('anomaly_alerts')
    .select('title, severity, description, created_at')
    .eq('business_id', businessId)
    .gte('created_at', sinceAlerts.toISOString())
    .order('created_at', { ascending: false })
    .limit(5)

  // Dept breakdown for this week
  const { data: deptRows } = await db
    .from('dept_metrics')
    .select('dept_name, revenue, staff_cost, labour_pct, year, month')
    .eq('business_id', businessId)
    .eq('year',  mtdYear)
    .eq('month', mtdMonth)
  const departments = (deptRows ?? [])
    .map((d: any) => ({
      name:        d.dept_name,
      revenue:     Number(d.revenue ?? 0),
      labour_pct:  d.labour_pct != null ? Number(d.labour_pct) : null,
    }))
    .sort((a: any, b: any) => b.revenue - a.revenue)

  const weekLabel = `${lastMonday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${lastSunday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`

  return {
    businessName,
    weekLabel,
    thisWeek,
    lastWeek: lastWeekBlk,
    prior4Weeks,
    monthToDate,
    openAlerts: (alerts ?? []).map((a: any) => ({
      title: a.title, severity: a.severity, description: a.description,
    })),
    budget: bud ? {
      revenue_target:        Number(bud.revenue_target ?? 0),
      food_cost_pct_target:  Number(bud.food_cost_pct_target ?? 0),
      staff_cost_pct_target: Number(bud.staff_cost_pct_target ?? 0),
    } : null,
    departments,
    weekdayPattern,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The prompt. Deliberately strict — 3 numbered actions, each SEK-quantified,
// 150–200 words max. Claude has a known habit of padding; the constraints force
// signal.
// ─────────────────────────────────────────────────────────────────────────────
function buildPrompt(ctx: WeeklyContext): string {
  const wp = ctx.weekdayPattern.filter(w => w.avg_rev > 0)
  return `You are the general manager of ${ctx.businessName}. You have access to the full week's trading data. Write a short memo to the owner — not a report, a conversation. Your job is to notice 3 things worth acting on and tell them in plain language with exact numbers and SEK impact.

TRADING DATA (all figures in SEK, ex-VAT)
Week just finished: ${ctx.weekLabel}
Revenue: ${fmt(ctx.thisWeek.revenue)}  (prev week ${fmt(ctx.lastWeek.revenue)} · ${delta(ctx.thisWeek.revenue, ctx.lastWeek.revenue)})
Labour cost: ${fmt(ctx.thisWeek.staff_cost)}  (${ctx.thisWeek.labour_pct ?? '—'} %)
Hours worked: ${ctx.thisWeek.hours}  ·  Shifts: ${ctx.thisWeek.shifts}
Covers: ${ctx.thisWeek.covers}
${ctx.budget ? `Month budget target revenue: ${fmt(ctx.budget.revenue_target)} / staff % target: ${ctx.budget.staff_cost_pct_target}` : ''}

WEEKDAY PATTERN (last 4 complete weeks avg)
${wp.map(w => `  ${w.weekday}: ${fmt(w.avg_rev)} rev · ${w.avg_hours}h · ${w.avg_labour_pct ?? '—'}% labour`).join('\n')}

DEPARTMENT MIX (month-to-date ${ctx.monthToDate.year}-${String(ctx.monthToDate.month).padStart(2,'0')})
${ctx.departments.slice(0, 6).map(d => `  ${d.name}: ${fmt(d.revenue)} rev · ${d.labour_pct ?? '—'}% labour`).join('\n')}

4-WEEK REVENUE TREND  (oldest → newest)
${ctx.prior4Weeks.map((w, i) => `  Week -${4 - i}: ${fmt(w.revenue)}`).join('\n')}
  Last week:  ${fmt(ctx.lastWeek.revenue)}
  This week:  ${fmt(ctx.thisWeek.revenue)}

${ctx.openAlerts.length ? `OPEN ALERTS\n${ctx.openAlerts.map(a => `  [${a.severity}] ${a.title} — ${a.description}`).join('\n')}` : 'OPEN ALERTS\n  None.'}

WRITE YOUR MEMO
Constraints — NON-NEGOTIABLE:
- 150–200 words total
- Open with a one-sentence verdict on the week ("Strong week — X is carrying you", "Quiet week, and here's what to do about it", etc.)
- Then exactly 3 numbered actions. Each action MUST include:
  (a) A specific observation with concrete numbers
  (b) The action in imperative form
  (c) Expected SEK impact ("saves 4 200 kr/wk", "recovers 1.2 pts labour %", etc.)
- No generic advice. Every action must reference numbers from the data above.
- Tone: direct, conversational, Swedish owner-to-owner. Assume technical literacy.
- No "I recommend", no "You should consider" — just say it. "Drop X. Saves Y."
- End with ONE sentence flagging the biggest risk for next week if it exists.
- Output JSON ONLY in this exact shape:

{
  "narrative": "The full memo as one block of prose, 150-200 words. Include the numbered actions inline within the prose.",
  "actions": [
    { "title": "Short 3-6 word title", "impact": "+X kr/wk or -Y% labour etc", "reasoning": "one-sentence why" },
    { "title": "...", "impact": "...", "reasoning": "..." },
    { "title": "...", "impact": "...", "reasoning": "..." }
  ],
  "facts_cited": [
    "Tuesday avg hours 42 — labour 63% last 4 weeks",
    "Saturday Bella 486k rev vs Friday 116k",
    "..."
  ]
}`
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-GB').replace(/,/g, ' ') + ' kr'
}
function delta(curr: number, prev: number): string {
  if (prev <= 0) return '—'
  const p = ((curr - prev) / prev) * 100
  const s = p >= 0 ? '+' : ''
  return `${s}${p.toFixed(1)}%`
}

// ─────────────────────────────────────────────────────────────────────────────
// Call Claude, parse, log cost.
// ─────────────────────────────────────────────────────────────────────────────
export async function generateWeeklyMemo(
  db:           Db,
  orgId:        string,
  businessId:   string,
  ctx:          WeeklyContext,
): Promise<ManagerMemo | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null

  const prompt = buildPrompt(ctx)
  const started = Date.now()

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

    const response = await claude.messages.create({
      model:       AI_MODELS.AGENT,
      max_tokens:  MAX_TOKENS.AGENT_SUMMARY,
      messages:    [{ role: 'user', content: prompt }],
    })

    const text = (response.content?.[0] as any)?.text?.trim() ?? ''

    // Log cost regardless of parse success.
    try {
      await logAiRequest(db, {
        org_id:        orgId,
        request_type:  'weekly_manager_memo',
        model:         AI_MODELS.AGENT,
        input_tokens:  response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
        duration_ms:   Date.now() - started,
      })
    } catch { /* non-fatal */ }

    // Extract JSON from response. Claude occasionally wraps in ```json …```.
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) {
      console.warn('[weekly-manager] Claude returned no JSON. raw:', text.slice(0, 400))
      return null
    }
    const parsed = JSON.parse(match[0])
    if (!parsed?.narrative) {
      console.warn('[weekly-manager] parsed but missing narrative', parsed)
      return null
    }
    return {
      narrative:   String(parsed.narrative),
      actions:     Array.isArray(parsed.actions) ? parsed.actions.slice(0, 3) : [],
      facts_cited: Array.isArray(parsed.facts_cited) ? parsed.facts_cited : [],
    }
  } catch (e: any) {
    console.error('[weekly-manager] Claude call failed:', e.message)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Email HTML — minimal, reads like a letter, not a dashboard.
// ─────────────────────────────────────────────────────────────────────────────
export function memoEmailHtml(ctx: WeeklyContext, memo: ManagerMemo, appUrl: string, orgId: string): string {
  const safe = (s: string) => (s ?? '').replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;')
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:Georgia,serif;color:#1a1f2e;">
  <div style="max-width:620px;margin:0 auto;padding:32px 24px;">
    <div style="font-size:12px;color:#6b7280;letter-spacing:.1em;text-transform:uppercase;margin-bottom:12px;font-family:-apple-system,Segoe UI,sans-serif;">
      ${safe(ctx.businessName)} · Week of ${safe(ctx.weekLabel)}
    </div>
    <h1 style="font-size:24px;font-weight:500;margin:0 0 24px;line-height:1.3;">
      Monday memo from your AI manager
    </h1>
    <div style="font-size:15px;line-height:1.7;white-space:pre-wrap;margin-bottom:32px;">
      ${safe(memo.narrative)}
    </div>
    ${memo.actions.length ? `
      <div style="border-top:1px solid #d4d4d0;padding-top:24px;margin-bottom:24px;font-family:-apple-system,Segoe UI,sans-serif;">
        <div style="font-size:11px;color:#6b7280;letter-spacing:.08em;text-transform:uppercase;margin-bottom:12px;">Recommended actions</div>
        ${memo.actions.map((a, i) => `
          <div style="margin-bottom:16px;padding:12px 14px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;">
              <div style="font-weight:600;font-size:14px;color:#1a1f2e;">${i + 1}. ${safe(a.title)}</div>
              <div style="font-size:12px;color:#059669;font-weight:600;white-space:nowrap;">${safe(a.impact)}</div>
            </div>
            <div style="font-size:13px;color:#4b5563;margin-top:4px;">${safe(a.reasoning)}</div>
          </div>
        `).join('')}
      </div>
    ` : ''}
    <div style="border-top:1px solid #d4d4d0;padding-top:16px;font-size:12px;color:#6b7280;font-family:-apple-system,Segoe UI,sans-serif;">
      <a href="${appUrl}/scheduling" style="color:#1e3a5f;text-decoration:none;margin-right:12px;">View schedule comparison →</a>
      <a href="${appUrl}/tracker" style="color:#1e3a5f;text-decoration:none;">P&amp;L detail →</a>
    </div>
    <div style="margin-top:24px;font-size:10px;color:#9ca3af;font-family:-apple-system,Segoe UI,sans-serif;">
      Generated by CommandCenter AI · <a href="${appUrl}/api/unsubscribe?org=${orgId}&amp;token=${Buffer.from(orgId).toString('base64')}" style="color:#9ca3af;">Unsubscribe</a>
    </div>
  </div>
</body></html>`
}
