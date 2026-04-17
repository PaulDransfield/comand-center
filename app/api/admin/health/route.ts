// @ts-nocheck
// app/api/admin/health/route.ts
// System health summary for /admin/health — cron detail, AI spend, error feed.
// Inferred status: we don't have a cron_runs table, so we use proxy signals
// (recent sync_log entries, recent anomaly_alerts, recent forecast_calibration rows).

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkAdminSecret } from '@/lib/admin/check-secret'

export const dynamic = 'force-dynamic'

function checkAuth(req: NextRequest): boolean {
  return checkAdminSecret(req)
}

const CRON_DEFS = [
  { path: '/api/cron/master-sync',             schedule: '0 5 * * *',  name: 'Master sync',          probe: { table: 'sync_log',                 time: 'created_at', status: 'success' } },
  { path: '/api/cron/anomaly-check',           schedule: '30 5 * * *', name: 'Anomaly check',        probe: { table: 'anomaly_alerts',           time: 'created_at' } },
  { path: '/api/cron/health-check',            schedule: '0 6 * * *',  name: 'Health check',         probe: null },
  { path: '/api/cron/weekly-digest',           schedule: '0 6 * * 1',  name: 'Weekly digest',        probe: { table: 'briefings',                time: 'created_at' } },
  { path: '/api/cron/forecast-calibration',    schedule: '0 4 1 * *',  name: 'Forecast calibration', probe: { table: 'forecast_calibration',     time: 'calibrated_at' } },
  { path: '/api/cron/supplier-price-creep',    schedule: '0 5 1 * *',  name: 'Supplier price creep', probe: { table: 'supplier_price_alerts',    time: 'detected_at' } },
  { path: '/api/cron/scheduling-optimization', schedule: '0 7 * * 1',  name: 'Scheduling optim.',    probe: { table: 'scheduling_recommendations', time: 'generated_at' } },
  { path: '/api/cron/onboarding-success',      schedule: '0 8 * * *',  name: 'Onboarding success',   probe: null },
  { path: '/api/cron/api-discovery-enhanced',  schedule: '0 3 * * 0',  name: 'API discovery',        probe: { table: 'api_discoveries_enhanced', time: 'discovered_at' } },
]

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createAdminClient()
  const now = Date.now()
  const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10)

  // Cron probe — look up last row per probe.table
  const cronRows = await Promise.all(CRON_DEFS.map(async (c) => {
    if (!c.probe) return { ...c, last_run: null, total_7d: 0 }
    try {
      const { data } = await db.from(c.probe.table).select(c.probe.time).order(c.probe.time, { ascending: false }).limit(1)
      const lastRun = data?.[0]?.[c.probe.time] ?? null
      const weekAgo = new Date(now - 7 * 86_400_000).toISOString()
      const { count } = await db.from(c.probe.table).select('id', { count: 'exact', head: true }).gte(c.probe.time, weekAgo)
      return { name: c.name, path: c.path, schedule: c.schedule, last_run: lastRun, total_7d: count ?? 0 }
    } catch {
      return { name: c.name, path: c.path, schedule: c.schedule, last_run: null, total_7d: 0, error: 'table missing' }
    }
  }))

  // AI spend this month — usage table
  const { data: aiUsage } = await db.from('ai_usage_daily').select('query_count').gte('date', firstOfMonth)
  const aiQueriesMonth = (aiUsage ?? []).reduce((s: number, r: any) => s + Number(r.query_count ?? 0), 0)
  // Rough cost: Haiku ~$0.00125/query (500 input + 150 output tokens avg)
  const aiCostUsd = aiQueriesMonth * 0.00125

  // Sync success rate (last 7 days) by provider
  const weekAgo = new Date(now - 7 * 86_400_000).toISOString()
  const { data: syncLogs } = await db.from('sync_log').select('provider, status').gte('created_at', weekAgo)
  const syncByProvider: Record<string, { success: number; fail: number }> = {}
  for (const s of syncLogs ?? []) {
    if (!syncByProvider[s.provider]) syncByProvider[s.provider] = { success: 0, fail: 0 }
    if (s.status === 'success') syncByProvider[s.provider].success++
    else syncByProvider[s.provider].fail++
  }

  // Integration errors — any integrations currently in error state
  const { data: errIntegs } = await db.from('integrations').select('id, provider, org_id, business_id, last_error, last_sync_at').not('last_error', 'is', null).order('last_sync_at', { ascending: false }).limit(20)

  // Lookup org names
  const orgIds = [...new Set((errIntegs ?? []).map((i: any) => i.org_id))]
  let orgNames: Record<string, string> = {}
  if (orgIds.length) {
    const { data: orgs } = await db.from('organisations').select('id, name').in('id', orgIds)
    for (const o of orgs ?? []) orgNames[o.id] = o.name
  }

  const errorFeed = (errIntegs ?? []).map((i: any) => ({
    integration_id: i.id,
    provider:       i.provider,
    org_id:         i.org_id,
    org_name:       orgNames[i.org_id] ?? '?',
    last_error:     i.last_error,
    last_sync_at:   i.last_sync_at,
  }))

  return NextResponse.json({
    crons:            cronRows,
    ai: {
      queries_month:  aiQueriesMonth,
      cost_usd_month: aiCostUsd,
    },
    sync_by_provider: Object.entries(syncByProvider).map(([p, v]: any) => ({
      provider: p,
      success:  v.success,
      fail:     v.fail,
      rate:     v.success + v.fail > 0 ? Math.round((v.success / (v.success + v.fail)) * 100) : null,
    })),
    error_feed: errorFeed,
  })
}
