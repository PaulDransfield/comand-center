// app/api/settings/ai-agents/[key]/route.ts
//
// Per-agent activity drill-down. Returns:
//   - meta:        the AgentMeta record (name, description, schedule)
//   - runs:        last 20 cron_run_log rows for this agent's cron_name
//   - llm_calls:   last 20 ai_request_log rows for this agent's request_types
//   - actions:     agent-specific outputs (anomaly_alerts, briefings,
//                  scheduling_recommendations) — empty for agents that don't
//                  persist explicit outputs (forecast_calibration, onboarding)
//   - cost:        { last_7d, last_30d, all_time } totals in USD
//
// Auth: owner only. Same as the listing endpoint.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { AGENTS } from '@/lib/ai/agent-registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { key: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (auth.role !== 'owner') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const agent = AGENTS.find(a => a.key === params.key)
  if (!agent) {
    return NextResponse.json({ error: `unknown agent key: ${params.key}` }, { status: 404 })
  }

  const db = createAdminClient()

  // ── Cron runs ──────────────────────────────────────────────────────
  let runs: any[] = []
  try {
    const { data } = await db
      .from('cron_run_log')
      .select('id, started_at, finished_at, status, error_message, payload')
      .eq('cron_name', agent.cron_name)
      .order('started_at', { ascending: false })
      .limit(20)
    runs = data ?? []
  } catch { /* table may not exist */ }

  // ── LLM calls (last 20, this org) ──────────────────────────────────
  let llmCalls: any[] = []
  if (agent.request_types.length > 0) {
    try {
      const { data } = await db
        .from('ai_request_log')
        .select('id, created_at, request_type, model, cost_usd, input_tokens, output_tokens, latency_ms, status')
        .eq('org_id', auth.orgId)
        .in('request_type', agent.request_types)
        .order('created_at', { ascending: false })
        .limit(20)
      llmCalls = data ?? []
    } catch { /* table may not be populated */ }
  }

  // ── Cost totals over windows ───────────────────────────────────────
  const now = Date.now()
  const since7d  = new Date(now - 7  * 86_400_000).toISOString()
  const since30d = new Date(now - 30 * 86_400_000).toISOString()

  let cost = { last_7d: 0, last_30d: 0, all_time: 0 }
  if (agent.request_types.length > 0) {
    try {
      const { data: spend } = await db
        .from('ai_request_log')
        .select('cost_usd, created_at')
        .eq('org_id', auth.orgId)
        .in('request_type', agent.request_types)
      for (const r of (spend ?? []) as any[]) {
        const c = Number(r.cost_usd ?? 0)
        cost.all_time += c
        if (r.created_at >= since30d) cost.last_30d += c
        if (r.created_at >= since7d)  cost.last_7d  += c
      }
    } catch { /* ignore */ }
  }

  // ── Agent-specific actions (the visible outputs) ───────────────────
  let actions: AgentAction[] = []
  switch (agent.key) {
    case 'anomaly_detection':
      actions = await loadAnomalyAlerts(db, auth.orgId)
      break
    case 'monday_briefing':
      actions = await loadBriefings(db, auth.orgId)
      break
    case 'scheduling_optimization':
      actions = await loadSchedulingRecs(db, auth.orgId)
      break
    // forecast_calibration: no explicit output table — runs adjust bias factors in-place
    // supplier_price_creep: persists into anomaly_alerts with alert_type='line_item_*' — covered there
    // onboarding_success: sends an email; logged in ai_request_log, no separate table
  }

  return NextResponse.json({
    meta: {
      key:            agent.key,
      name:           agent.name,
      description:    agent.description,
      schedule_human: agent.schedule_human,
      plan_required:  agent.plan_required,
      cron_name:      agent.cron_name,
      request_types:  agent.request_types,
    },
    runs,
    llm_calls: llmCalls,
    actions,
    cost: {
      last_7d:  Math.round(cost.last_7d  * 10000) / 10000,
      last_30d: Math.round(cost.last_30d * 10000) / 10000,
      all_time: Math.round(cost.all_time * 10000) / 10000,
    },
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}

// ─── Action loaders ──────────────────────────────────────────────────

interface AgentAction {
  id:           string
  occurred_at:  string
  business_id?: string | null
  business_name?: string | null
  kind:         string
  title:        string
  detail?:      string | null
  meta?:        Record<string, any>
}

async function loadAnomalyAlerts(db: any, orgId: string): Promise<AgentAction[]> {
  try {
    const { data } = await db
      .from('anomaly_alerts')
      .select('id, created_at, business_id, alert_type, severity, title, description')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(25)
    const bizMap = await businessNameMap(db, orgId)
    return (data ?? []).map((r: any) => ({
      id:            r.id,
      occurred_at:   r.created_at,
      business_id:   r.business_id,
      business_name: bizMap[r.business_id] ?? null,
      kind:          r.alert_type ?? 'anomaly',
      title:         r.title ?? '(no title)',
      detail:        r.description ?? null,
      meta:          { severity: r.severity },
    }))
  } catch { return [] }
}

async function loadBriefings(db: any, orgId: string): Promise<AgentAction[]> {
  try {
    const { data } = await db
      .from('briefings')
      .select('id, created_at, business_id, week_start, content, key_metrics')
      .eq('org_id', orgId)
      .order('week_start', { ascending: false })
      .limit(20)
    const bizMap = await businessNameMap(db, orgId)
    return (data ?? []).map((r: any) => {
      const actions = Array.isArray(r.key_metrics?.actions) ? r.key_metrics.actions : []
      const headline = actions[0]?.headline ?? actions[0]?.title ?? null
      const summary  = typeof r.content === 'string' ? r.content : null
      const short    = summary && summary.length > 220 ? summary.slice(0, 217) + '…' : summary
      return {
        id:            r.id,
        occurred_at:   r.created_at ?? r.week_start,
        business_id:   r.business_id,
        business_name: bizMap[r.business_id] ?? null,
        kind:          'monday_memo',
        title:         headline
          ? `Monday memo — ${headline}`
          : `Monday memo — week of ${r.week_start}`,
        detail:        short,
        meta:          { week_start: r.week_start, action_count: actions.length },
      }
    })
  } catch { return [] }
}

async function loadSchedulingRecs(db: any, orgId: string): Promise<AgentAction[]> {
  try {
    const { data } = await db
      .from('scheduling_recommendations')
      .select('id, generated_at, business_id, recommendations, analysis_period, metadata')
      .eq('org_id', orgId)
      .order('generated_at', { ascending: false })
      .limit(20)
    const bizMap = await businessNameMap(db, orgId)
    return (data ?? []).map((r: any) => {
      const recs = Array.isArray(r.recommendations)
        ? r.recommendations
        : (r.recommendations?.suggested ?? r.recommendations?.cuts ?? [])
      const savingsKr = recs.reduce((s: number, x: any) => s + Number(x?.savings_sek ?? x?.estimated_saving ?? 0), 0)
      const count = Array.isArray(recs) ? recs.length : 0
      return {
        id:            r.id,
        occurred_at:   r.generated_at,
        business_id:   r.business_id,
        business_name: bizMap[r.business_id] ?? null,
        kind:          'scheduling_rec',
        title:         count > 0
          ? `${count} cut suggestion${count === 1 ? '' : 's'}${savingsKr > 0 ? ` — ${Math.round(savingsKr).toLocaleString('sv-SE')} kr potential saving` : ''}`
          : 'No cuts recommended (rota matches demand)',
        detail:        r.analysis_period
          ? `Analysed week of ${r.analysis_period.start ?? r.analysis_period}`
          : null,
        meta:          { rec_count: count, savings_kr: savingsKr },
      }
    })
  } catch { return [] }
}

const bizNameCache = new Map<string, Record<string, string>>()
async function businessNameMap(db: any, orgId: string): Promise<Record<string, string>> {
  if (bizNameCache.has(orgId)) return bizNameCache.get(orgId)!
  try {
    const { data } = await db
      .from('businesses')
      .select('id, name')
      .eq('org_id', orgId)
    const m: Record<string, string> = {}
    for (const b of (data ?? []) as any[]) m[b.id] = b.name
    bizNameCache.set(orgId, m)
    setTimeout(() => bizNameCache.delete(orgId), 60_000)
    return m
  } catch { return {} }
}
