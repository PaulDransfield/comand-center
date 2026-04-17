// @ts-nocheck
// app/api/admin/customers/[orgId]/agents/route.ts
//
// GET  — per-agent status for this org: enabled flag + last-run timestamp
// POST — { action: 'toggle' | 'run', agent, enabled? }
//        toggle: upserts feature_flags row agent_{name} for this org
//        run:    fires the cron URL for this agent (with org_id param where supported)

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

// ── Agent registry ─────────────────────────────────────────────────────────
// Each agent has: internal key · display name · description · cron URL ·
// scope (per-org = admin endpoint supports ?org_id, global = runs for all orgs)
// and a DB table to look up the last-run timestamp.
const AGENTS = [
  {
    key:  'anomaly_detection',
    name: 'Anomaly detection',
    desc: 'Nightly scan for unusual cost/revenue spikes — emails the owner.',
    cron: '/api/cron/anomaly-check',
    scope: 'per-org',
    lastRunTable: 'anomaly_alerts',
    lastRunColumn: 'created_at',
  },
  {
    key:  'forecast_calibration',
    name: 'Forecast calibration',
    desc: 'Monthly accuracy check — recalculates bias factors.',
    cron: '/api/cron/forecast-calibration',
    scope: 'global',
    lastRunTable: 'forecast_calibration',
    lastRunColumn: 'calibrated_at',
  },
  {
    key:  'scheduling_optimization',
    name: 'Scheduling optimisation',
    desc: 'Weekly AI review of shifts vs revenue. Group plan only.',
    cron: '/api/cron/scheduling-optimization',
    scope: 'global',
    lastRunTable: 'scheduling_recommendations',
    lastRunColumn: 'generated_at',
  },
  {
    key:  'monday_briefing',
    name: 'Monday briefing',
    desc: 'Weekly digest email sent every Monday morning.',
    cron: '/api/cron/weekly-digest',
    scope: 'global',
    lastRunTable: 'briefings',
    lastRunColumn: 'created_at',
  },
  {
    key:  'onboarding_success',
    name: 'Onboarding success',
    desc: 'Welcome email on first sync — cron + inline paths.',
    cron: '/api/cron/onboarding-success',
    scope: 'global',
    lastRunTable: null,  // tracked as boolean flag on integrations, not timestamp
    lastRunColumn: null,
  },
  {
    key:  'supplier_price_creep',
    name: 'Supplier price creep',
    desc: 'Monthly Fortnox scan for price hikes. Blocked on OAuth approval.',
    cron: '/api/cron/supplier-price-creep',
    scope: 'global',
    lastRunTable: 'supplier_price_alerts',
    lastRunColumn: 'detected_at',
    blocked: true,
  },
]

function checkAuth(req: NextRequest): boolean {
  const secret = req.headers.get('x-admin-secret') ?? req.cookies.get('admin_secret')?.value
  return secret === process.env.ADMIN_SECRET
}

// ── GET: per-agent status for this org ─────────────────────────────────────
export async function GET(req: NextRequest, { params }: { params: { orgId: string } }) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const orgId = params.orgId
  const db = createAdminClient()

  const { data: flags } = await db.from('feature_flags').select('flag, enabled, updated_at, notes').eq('org_id', orgId)
  const flagsByName = new Map<string, any>((flags ?? []).map((f: any) => [f.flag, f]))

  // Fetch latest timestamp per agent in parallel
  const lastRuns = await Promise.all(AGENTS.map(async (a) => {
    if (!a.lastRunTable || !a.lastRunColumn) return null
    try {
      const { data } = await db.from(a.lastRunTable)
        .select(a.lastRunColumn)
        .eq('org_id', orgId)
        .order(a.lastRunColumn, { ascending: false })
        .limit(1)
      return data?.[0]?.[a.lastRunColumn] ?? null
    } catch { return null }
  }))

  const agents = AGENTS.map((a, i) => {
    const flag = flagsByName.get(`agent_${a.key}`)
    // Default is enabled — only disabled if flag row exists with enabled=false
    const enabled = flag ? flag.enabled : true
    return {
      key:         a.key,
      name:        a.name,
      desc:        a.desc,
      scope:       a.scope,
      blocked:     a.blocked ?? false,
      enabled,
      last_run:    lastRuns[i],
      flag_notes:  flag?.notes ?? null,
    }
  })

  return NextResponse.json({ agents })
}

// ── POST: toggle or run ────────────────────────────────────────────────────
export async function POST(req: NextRequest, { params }: { params: { orgId: string } }) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const orgId = params.orgId
  const body = await req.json().catch(() => ({}))
  const { action, agent, enabled } = body

  const agentDef = AGENTS.find(a => a.key === agent)
  if (!agentDef) return NextResponse.json({ error: 'Unknown agent: ' + agent }, { status: 400 })

  const db = createAdminClient()

  if (action === 'toggle') {
    await db.from('feature_flags').upsert({
      org_id:  orgId,
      flag:    `agent_${agent}`,
      enabled: !!enabled,
      notes:   enabled === false ? `Disabled by admin ${new Date().toISOString().slice(0, 10)}` : null,
    }, { onConflict: 'org_id,flag' })
    await recordAdminAction(db, { action: ADMIN_ACTIONS.AGENT_TOGGLE, orgId, targetType: 'agent', targetId: agent, payload: { enabled: !!enabled }, req })
    return NextResponse.json({ ok: true, enabled: !!enabled })
  }

  if (action === 'run') {
    if (agentDef.blocked) {
      return NextResponse.json({ error: 'Agent is blocked (external dependency pending)' }, { status: 400 })
    }
    // Fire the cron URL. Supports ?org_id for per-org agents; otherwise runs globally.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://comandcenter.se'
    const suffix = agentDef.scope === 'per-org' ? `?org_id=${orgId}` : ''
    try {
      const res = await fetch(`${appUrl}${agentDef.cron}${suffix}`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
        },
      })
      const respText = await res.text()
      await recordAdminAction(db, { action: ADMIN_ACTIONS.AGENT_RUN, orgId, targetType: 'agent', targetId: agent, payload: { scope: agentDef.scope, ok: res.ok, status: res.status }, req })
      return NextResponse.json({
        ok:           res.ok,
        status:       res.status,
        cron_url:     agentDef.cron + suffix,
        scope:        agentDef.scope,
        response:     respText.slice(0, 500),
        note:         agentDef.scope === 'global' ? 'This agent runs for all orgs, not just this one.' : 'Run scoped to this org only.',
      })
    } catch (err: any) {
      return NextResponse.json({ error: 'Run failed: ' + err.message }, { status: 502 })
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
