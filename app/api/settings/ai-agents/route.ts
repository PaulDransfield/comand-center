// app/api/settings/ai-agents/route.ts
//
// Owner-facing AI agents page backend.
//
// GET  → list of agents with metadata + live state (enabled, last_run_at, last_status)
// POST → toggle agent enabled state (body: { key, enabled })
//
// Auth: owner only. /settings/* is in OWNER_ONLY_PATHS per the permissions module.
// Reads/writes `feature_flags` (M012) following the existing isAgentEnabled pattern.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { AGENTS, type AgentMeta } from '@/lib/ai/agent-registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (auth.role !== 'owner') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const db = createAdminClient()

  // Fetch all agent feature flags for this org in one query
  const flagKeys = AGENTS.map(a => `agent_${a.key}`)
  const { data: flags } = await db
    .from('feature_flags')
    .select('flag, enabled')
    .eq('org_id', auth.orgId)
    .in('flag', flagKeys)

  const enabledByKey: Record<string, boolean> = {}
  for (const a of AGENTS) enabledByKey[a.key] = true   // default ON
  for (const f of (flags ?? []) as any[]) {
    const key = String(f.flag).replace(/^agent_/, '')
    enabledByKey[key] = f.enabled !== false
  }

  // Fetch last run per cron from cron_run_log
  // (best-effort — table may not exist on older deployments)
  const cronNames = AGENTS.map(a => a.cron_name)
  const lastRunByCron: Record<string, { started_at: string; finished_at: string | null; status: string | null }> = {}
  try {
    const { data: runs } = await db
      .from('cron_run_log')
      .select('cron_name, started_at, finished_at, status')
      .in('cron_name', cronNames)
      .order('started_at', { ascending: false })
      .limit(200)
    for (const r of (runs ?? []) as any[]) {
      // First (newest) per cron_name wins because of the order above
      if (!lastRunByCron[r.cron_name]) {
        lastRunByCron[r.cron_name] = {
          started_at:  r.started_at,
          finished_at: r.finished_at ?? null,
          status:      r.status ?? null,
        }
      }
    }
  } catch { /* cron_run_log might not exist; show "never run" for all */ }

  // Aggregate cost per agent — last 30 days
  // Sums ai_request_log.cost_usd grouped by request_type.
  const since = new Date()
  since.setUTCDate(since.getUTCDate() - 30)
  const costByType: Record<string, number> = {}
  try {
    const { data: spend } = await db
      .from('ai_request_log')
      .select('request_type, cost_usd')
      .eq('org_id', auth.orgId)
      .gte('created_at', since.toISOString())
    for (const r of (spend ?? []) as any[]) {
      const k = String(r.request_type ?? 'unknown')
      costByType[k] = (costByType[k] ?? 0) + Number(r.cost_usd ?? 0)
    }
  } catch { /* ai_request_log might not be populated yet */ }

  const agents = AGENTS.map(a => {
    const lastRun  = lastRunByCron[a.cron_name] ?? null
    const cost_usd = a.request_types.reduce((s, t) => s + (costByType[t] ?? 0), 0)
    return {
      key:              a.key,
      name:             a.name,
      description:      a.description,
      schedule_human:   a.schedule_human,
      plan_required:    a.plan_required,
      enabled:          enabledByKey[a.key],
      last_run_at:      lastRun?.started_at  ?? null,
      last_finished_at: lastRun?.finished_at ?? null,
      last_status:      lastRun?.status      ?? null,
      cost_usd_30d:     Math.round(cost_usd * 10000) / 10000,
    }
  })

  return NextResponse.json({ agents }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (auth.role !== 'owner') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: any = {}
  try { body = await req.json() } catch {}
  const key     = String(body?.key ?? '')
  const enabled = body?.enabled !== false   // default to enabling
  const agent   = AGENTS.find(a => a.key === key)
  if (!agent) {
    return NextResponse.json({ error: `unknown agent key: ${key}` }, { status: 400 })
  }

  const db = createAdminClient()
  const { error } = await db
    .from('feature_flags')
    .upsert({
      org_id:  auth.orgId,
      flag:    `agent_${agent.key}`,
      enabled,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'org_id,flag' })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, key: agent.key, enabled }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
