// app/api/admin/v2/agents/route.ts
//
// Operational view of AI agents for the admin v2 Agents tab.
//
// GET: returns one row per agent with:
//   - is_active state from agent_settings (M035) — gracefully falls back
//     to true if M035 hasn't been applied
//   - last_run timestamp + recent_runs from each agent's output table
//   - runs_24h count
//   - recent_failures across the whole platform from sync_log where
//     status='error' (best signal we have until per-agent run logging
//     ships in a future PR)
//
// POST: kill switch — toggles agent_settings.is_active and writes audit.
// Body: { agent_key, is_active, reason }. Reason ≥ 10 chars enforced.
//
// Per the PR 6 plan: extends the existing /api/admin/agents shape (with
// running/failed panels). The OLD route stays untouched.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'

export const dynamic = 'force-dynamic'

const REASON_MIN = 10

// Mirror of AGENT_SOURCES in the old route — duplicated rather than
// imported because the old route is `// @ts-nocheck` and pulling its
// types in would broaden ts-nocheck's effective scope.
interface AgentSource {
  key:    string
  name:   string
  cron:   string
  table:  string | null
  time:   string | null
  blocked?: boolean
}
const AGENTS: AgentSource[] = [
  { key: 'anomaly_detection',       name: 'Anomaly detection',        cron: '/api/cron/anomaly-check',           table: 'anomaly_alerts',             time: 'created_at' },
  { key: 'forecast_calibration',    name: 'Forecast calibration',     cron: '/api/cron/forecast-calibration',    table: 'forecast_calibration',       time: 'calibrated_at' },
  { key: 'scheduling_optimization', name: 'Scheduling optimisation',  cron: '/api/cron/scheduling-optimization', table: 'scheduling_recommendations', time: 'generated_at' },
  { key: 'monday_briefing',         name: 'Monday briefing',          cron: '/api/cron/weekly-digest',           table: 'briefings',                  time: 'created_at' },
  { key: 'onboarding_success',      name: 'Onboarding success',       cron: '/api/cron/onboarding-success',      table: null,                         time: null },
  { key: 'supplier_price_creep',    name: 'Supplier price creep',     cron: '/api/cron/supplier-price-creep',    table: 'supplier_price_alerts',      time: 'detected_at', blocked: true },
]

const DAY_MS = 86_400_000

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req)
  if ('ok' in guard === false) return guard as NextResponse

  const db    = createAdminClient()
  const now   = Date.now()
  const day1  = new Date(now -  1 * DAY_MS).toISOString()
  const day7  = new Date(now -  7 * DAY_MS).toISOString()

  // ── Active state from agent_settings (M035 — degrades gracefully) ───
  const settingsByKey: Record<string, { is_active: boolean; last_changed_at: string | null; last_changed_by: string | null; last_change_reason: string | null }> = {}
  let settingsTablePresent = true
  try {
    const { data, error } = await db
      .from('agent_settings')
      .select('key, is_active, last_changed_at, last_changed_by, last_change_reason')
    if (error) throw error
    for (const r of data ?? []) settingsByKey[r.key] = r
  } catch (e: any) {
    // M035 not applied yet — treat all agents as active. The UI shows a
    // banner pointing to the migration so Paul knows why kill switches
    // can't be persisted.
    settingsTablePresent = false
  }

  // ── Per-agent operational stats ─────────────────────────────────────
  const agents = await Promise.all(AGENTS.map(async (a) => {
    const settings = settingsByKey[a.key] ?? null
    const isActive = settings?.is_active ?? true   // default to active when no row

    if (!a.table) {
      return {
        key:               a.key,
        name:              a.name,
        cron:              a.cron,
        blocked:           a.blocked ?? false,
        is_active:         isActive,
        settings_persisted: !!settings,
        last_run:          null,
        runs_24h:          0,
        runs_7d:           0,
        last_changed_at:   settings?.last_changed_at   ?? null,
        last_changed_by:   settings?.last_changed_by   ?? null,
        last_change_reason: settings?.last_change_reason ?? null,
      }
    }
    try {
      const [latestRes, count24Res, count7dRes] = await Promise.all([
        db.from(a.table).select(a.time as string).order(a.time as string, { ascending: false }).limit(1).maybeSingle(),
        db.from(a.table).select('*', { count: 'exact', head: true }).gte(a.time as string, day1),
        db.from(a.table).select('*', { count: 'exact', head: true }).gte(a.time as string, day7),
      ])
      const lastAt = (latestRes.data as any)?.[a.time as string] ?? null
      return {
        key:               a.key,
        name:              a.name,
        cron:              a.cron,
        blocked:           a.blocked ?? false,
        is_active:         isActive,
        settings_persisted: !!settings,
        last_run:          lastAt,
        runs_24h:          count24Res.count ?? 0,
        runs_7d:           count7dRes.count ?? 0,
        last_changed_at:   settings?.last_changed_at   ?? null,
        last_changed_by:   settings?.last_changed_by   ?? null,
        last_change_reason: settings?.last_change_reason ?? null,
      }
    } catch (err: any) {
      return {
        key:               a.key,
        name:              a.name,
        cron:              a.cron,
        blocked:           a.blocked ?? false,
        is_active:         isActive,
        settings_persisted: !!settings,
        last_run:          null,
        runs_24h:          0,
        runs_7d:           0,
        error:             err?.message ?? 'fetch failed',
        last_changed_at:   settings?.last_changed_at   ?? null,
        last_changed_by:   settings?.last_changed_by   ?? null,
        last_change_reason: settings?.last_change_reason ?? null,
      }
    }
  }))

  // ── Recent failures across the platform ─────────────────────────────
  // Best DB signal we have for "agent / cron failures" is sync_log where
  // status != 'success'. Per-agent failures don't write to the
  // agent-output tables (those record successes only). A future PR can
  // add a unified agent_run_log; for now this is the honest answer.
  const { data: failedSyncs } = await db
    .from('sync_log')
    .select('id, org_id, provider, status, error_msg, duration_ms, created_at')
    .neq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(20)

  // Enrich with org names.
  const orgIds = [...new Set((failedSyncs ?? []).map((r: any) => r.org_id).filter(Boolean))]
  const { data: orgs } = orgIds.length
    ? await db.from('organisations').select('id, name').in('id', orgIds)
    : { data: [] as any[] }
  const orgNameById: Record<string, string> = {}
  for (const o of orgs ?? []) orgNameById[o.id] = o.name

  const recentFailures = (failedSyncs ?? []).map((r: any) => ({
    id:          r.id,
    org_id:      r.org_id,
    org_name:    orgNameById[r.org_id] ?? '?',
    provider:    r.provider,
    status:      r.status,
    error_msg:   r.error_msg,
    duration_ms: r.duration_ms,
    created_at:  r.created_at,
  }))

  return NextResponse.json({
    agents,
    recent_failures:    recentFailures,
    settings_persisted: settingsTablePresent,
    generated_at:       new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

// POST — kill switch. Body: { agent_key, is_active, reason }
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req)
  if ('ok' in guard === false) return guard as NextResponse

  let body: any = {}
  try { body = await req.json() } catch {}
  const agentKey = String(body?.agent_key ?? '').trim()
  const isActive = !!body?.is_active
  const reason   = String(body?.reason ?? '').trim()

  if (!agentKey)                    return NextResponse.json({ error: 'agent_key required' }, { status: 400 })
  if (!AGENTS.find(a => a.key === agentKey)) return NextResponse.json({ error: `unknown agent_key: ${agentKey}` }, { status: 400 })
  if (reason.length < REASON_MIN)   return NextResponse.json({ error: `reason required (min ${REASON_MIN} chars)` }, { status: 400 })

  const db = createAdminClient()

  // Audit FIRST.
  await recordAdminAction(db, {
    action:     ADMIN_ACTIONS.AGENT_TOGGLE,
    targetType: 'agent',
    targetId:   agentKey,
    payload:    {
      reason,
      surface:        'admin_v2',
      agent_key:      agentKey,
      is_active:      isActive,
    },
    req,
  })

  // Upsert agent_settings.
  const { error } = await db
    .from('agent_settings')
    .upsert({
      key:                agentKey,
      is_active:          isActive,
      last_changed_at:    new Date().toISOString(),
      last_changed_by:    'admin',
      last_change_reason: reason,
    }, { onConflict: 'key' })
  if (error) {
    if (error.message?.toLowerCase().includes('does not exist')) {
      return NextResponse.json({
        error: 'agent_settings table missing — run M035-ADMIN-AGENT-SETTINGS.sql in Supabase first',
      }, { status: 500 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    ok:        true,
    agent_key: agentKey,
    is_active: isActive,
    reason,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
