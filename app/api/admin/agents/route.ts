// @ts-nocheck
// app/api/admin/agents/route.ts
// Cross-customer agent overview for /admin/agents.
// For each of the 6 agents: list recent runs (with customer name), totals, last-run age.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkAdminSecret } from '@/lib/admin/check-secret'

export const dynamic = 'force-dynamic'

function checkAuth(req: NextRequest): boolean {
  return checkAdminSecret(req)
}

const AGENT_SOURCES = [
  {
    key:    'anomaly_detection',
    name:   'Anomaly detection',
    cron:   '/api/cron/anomaly-check',
    table:  'anomaly_alerts',
    time:   'created_at',
    label:  (r: any) => `${r.severity} · ${r.title ?? 'alert'}`,
  },
  {
    key:    'forecast_calibration',
    name:   'Forecast calibration',
    cron:   '/api/cron/forecast-calibration',
    table:  'forecast_calibration',
    time:   'calibrated_at',
    label:  (r: any) => `accuracy ${r.accuracy_pct ?? '?'}% · bias ${r.bias_factor ?? '?'}`,
  },
  {
    key:    'scheduling_optimization',
    name:   'Scheduling optimisation',
    cron:   '/api/cron/scheduling-optimization',
    table:  'scheduling_recommendations',
    time:   'generated_at',
    label:  (r: any) => r.analysis_period ?? 'recommendation',
  },
  {
    key:    'monday_briefing',
    name:   'Monday briefing',
    cron:   '/api/cron/weekly-digest',
    table:  'briefings',
    time:   'created_at',
    label:  (r: any) => `week ${r.week_start ?? '?'}`,
  },
  {
    key:    'onboarding_success',
    name:   'Onboarding success',
    cron:   '/api/cron/onboarding-success',
    table:  null,  // tracked as boolean on integrations, no timestamps per run
    time:   null,
    label:  () => '',
  },
  {
    key:    'supplier_price_creep',
    name:   'Supplier price creep',
    cron:   '/api/cron/supplier-price-creep',
    table:  'supplier_price_alerts',
    time:   'detected_at',
    label:  (r: any) => `${r.supplier_name ?? '?'} · ${r.item_name ?? '?'}`,
    blocked: true,
  },
]

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createAdminClient()
  const now = Date.now()
  const weekAgo = new Date(now - 7 * 86_400_000).toISOString()

  // Fetch org names in one query for label resolution
  const { data: orgs } = await db.from('organisations').select('id, name')
  const orgNameById: Record<string, string> = {}
  for (const o of orgs ?? []) orgNameById[o.id] = o.name

  // Fetch feature flags grouped by agent_key to show how many orgs have each disabled
  const { data: flags } = await db.from('feature_flags').select('org_id, flag, enabled').like('flag', 'agent_%')
  const disabledCounts: Record<string, number> = {}
  for (const f of flags ?? []) {
    if (f.enabled === false) {
      const key = f.flag.replace('agent_', '')
      disabledCounts[key] = (disabledCounts[key] ?? 0) + 1
    }
  }

  // For each agent, fetch last 10 runs + count in last 7 days
  const agents = await Promise.all(AGENT_SOURCES.map(async (a) => {
    if (!a.table) {
      return {
        ...a,
        recent_runs:  [],
        runs_7d:      0,
        total_runs:   0,
        last_run:     null,
        disabled_for: disabledCounts[a.key] ?? 0,
      }
    }
    try {
      const [recentRes, countWeekRes, countTotalRes] = await Promise.all([
        db.from(a.table).select('*').order(a.time, { ascending: false }).limit(10),
        db.from(a.table).select('id', { count: 'exact', head: true }).gte(a.time, weekAgo),
        db.from(a.table).select('id', { count: 'exact', head: true }),
      ])
      const recent = (recentRes.data ?? []).map((r: any) => ({
        org_id:   r.org_id,
        org_name: orgNameById[r.org_id] ?? '?',
        at:       r[a.time],
        label:    a.label(r),
      }))
      return {
        key:        a.key,
        name:       a.name,
        cron:       a.cron,
        blocked:    a.blocked ?? false,
        recent_runs: recent,
        runs_7d:    countWeekRes.count ?? 0,
        total_runs: countTotalRes.count ?? 0,
        last_run:   recent[0]?.at ?? null,
        disabled_for: disabledCounts[a.key] ?? 0,
      }
    } catch (err: any) {
      return {
        key:     a.key,
        name:    a.name,
        cron:    a.cron,
        blocked: a.blocked ?? false,
        error:   err.message,
        recent_runs: [],
        runs_7d:    0,
        total_runs: 0,
        last_run:   null,
        disabled_for: disabledCounts[a.key] ?? 0,
      }
    }
  }))

  return NextResponse.json({ agents })
}

// POST — bulk run: triggers the cron for one agent (runs for all customers per its scope)
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const { agent } = body
  const agentDef = AGENT_SOURCES.find(a => a.key === agent)
  if (!agentDef) return NextResponse.json({ error: 'Unknown agent' }, { status: 400 })
  if (agentDef.blocked) return NextResponse.json({ error: 'Agent is blocked (external dependency pending)' }, { status: 400 })

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://comandcenter.se'
  try {
    const res = await fetch(`${appUrl}${agentDef.cron}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}` },
    })
    const text = await res.text()
    return NextResponse.json({ ok: res.ok, status: res.status, response: text.slice(0, 500) })
  } catch (err: any) {
    return NextResponse.json({ error: 'Run failed: ' + err.message }, { status: 502 })
  }
}
