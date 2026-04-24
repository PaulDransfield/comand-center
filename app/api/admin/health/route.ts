// @ts-nocheck
// app/api/admin/health/route.ts
// System health summary for /admin/health — cron detail, AI spend, error feed.
// Inferred status: we don't have a cron_runs table, so we use proxy signals
// (recent sync_log entries, recent anomaly_alerts, recent forecast_calibration rows).

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkAdminSecret } from '@/lib/admin/check-secret'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 30

function checkAuth(req: NextRequest): boolean {
  return checkAdminSecret(req)
}

const CRON_DEFS = [
  { path: '/api/cron/master-sync',             schedule: '0 5 * * *',      name: 'Master sync',          probe: { table: 'sync_log',                 time: 'created_at', status: 'success' } },
  { path: '/api/cron/catchup-sync',            schedule: '0 7,10,14,18 *', name: 'Catchup sync',         probe: { table: 'sync_log',                 time: 'created_at', status: 'success' } },
  { path: '/api/cron/anomaly-check',           schedule: '30 5 * * *',     name: 'Anomaly check',        probe: { table: 'anomaly_alerts',           time: 'created_at' } },
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

  // Optional business filter for the AI learning panel (+ anything else
  // that benefits from per-business drill-down). Absent = aggregate.
  const businessFilter = req.nextUrl.searchParams.get('business_id') || null

  // List of all businesses so the UI can render a selector. Joined with
  // org name for display. Sorted by org then business for a stable list.
  const { data: businessesList } = await db
    .from('businesses')
    .select('id, name, org_id, is_active, organisations(name)')
    .order('name', { ascending: true })

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

  // ── Extraction queue snapshot ───────────────────────────────────
  // Counts by status so the operator can see at a glance whether jobs
  // are stuck. 'dead' > 0 warrants investigation (3 failed attempts).
  const extractionQueue = { pending: 0, processing: 0, completed_1d: 0, failed: 0, dead: 0, stale: 0 }
  try {
    const oneDayAgo = new Date(now - 24 * 60 * 60_000).toISOString()
    const tenMinAgo = new Date(now - 10 * 60_000).toISOString()
    const [pend, proc, comp, dead, stale] = await Promise.all([
      db.from('extraction_jobs').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      db.from('extraction_jobs').select('id', { count: 'exact', head: true }).eq('status', 'processing'),
      db.from('extraction_jobs').select('id', { count: 'exact', head: true }).eq('status', 'completed').gte('completed_at', oneDayAgo),
      db.from('extraction_jobs').select('id', { count: 'exact', head: true }).eq('status', 'dead'),
      db.from('extraction_jobs').select('id', { count: 'exact', head: true }).eq('status', 'processing').lt('started_at', tenMinAgo),
    ])
    extractionQueue.pending      = pend.count     ?? 0
    extractionQueue.processing   = proc.count     ?? 0
    extractionQueue.completed_1d = comp.count     ?? 0
    extractionQueue.dead         = dead.count     ?? 0
    extractionQueue.stale        = stale.count    ?? 0
  } catch { /* table may not exist in envs without M017 */ }

  // ── Stripe webhook dedup activity ──────────────────────────────
  let stripeDedup = { processed_1d: 0 }
  try {
    const oneDayAgo = new Date(now - 24 * 60 * 60_000).toISOString()
    const { count } = await db
      .from('stripe_processed_events')
      .select('event_id', { count: 'exact', head: true })
      .gte('processed_at', oneDayAgo)
    stripeDedup.processed_1d = count ?? 0
  } catch { /* M018 may not be applied */ }

  // ── Org rate-limit burn ────────────────────────────────────────
  // Recent windows where an org has exceeded the limit — useful signal
  // for a compromised session or abusive client.
  let rateLimitHits: Array<{ org_id: string; bucket: string; count: number; window_start: string }> = []
  try {
    const oneDayAgo = new Date(now - 24 * 60 * 60_000).toISOString()
    const { data } = await db
      .from('org_rate_limits')
      .select('org_id, bucket, count, window_start')
      .gte('window_start', oneDayAgo)
      .gte('count', 5)
      .order('window_start', { ascending: false })
      .limit(20)
    rateLimitHits = data ?? []
  } catch { /* M018 may not be applied */ }

  // ── AI feedback loop — suggestions captured, actuals resolved,
  //    owner reactions, directional bias by surface ───────────────
  // Surfaces the state of the AI self-learning loop wired in M020.
  // Lets you watch the loop actually filling up with real data as
  // months close out.
  const aiLearning: any = {
    total_suggestions:  0,
    resolved_suggestions: 0,
    pending_resolution:   0,
    reactions: { too_high: 0, too_low: 0, just_right: 0, wrong_shape: 0 },
    directional_bias: null as null | { mean_error_pct: number; sample_size: number },
    recent_rows: [] as Array<{ surface: string; org_id: string; business_id: string; period_year: number; period_month: number | null; suggested_revenue: number | null; actual_revenue: number | null; revenue_error_pct: number | null; revenue_direction: string | null; owner_reaction: string | null; created_at: string }>,
  }
  try {
    const totalQ    = db.from('ai_forecast_outcomes').select('id', { count: 'exact', head: true })
    const resolvedQ = db.from('ai_forecast_outcomes').select('id', { count: 'exact', head: true }).not('actuals_resolved_at', 'is', null)
    const reactionQ = db.from('ai_forecast_outcomes').select('owner_reaction').not('owner_reaction', 'is', null)
    const recentQ   = db.from('ai_forecast_outcomes')
      .select('surface, org_id, business_id, period_year, period_month, suggested_revenue, actual_revenue, revenue_error_pct, revenue_direction, owner_reaction, created_at')
      .order('created_at', { ascending: false })
      .limit(25)
    if (businessFilter) {
      totalQ.eq('business_id', businessFilter)
      resolvedQ.eq('business_id', businessFilter)
      reactionQ.eq('business_id', businessFilter)
      recentQ.eq('business_id', businessFilter)
    }
    const [totalRes, resolvedRes, reactionRes, recentRes] = await Promise.all([totalQ, resolvedQ, reactionQ, recentQ])
    aiLearning.total_suggestions   = totalRes.count    ?? 0
    aiLearning.resolved_suggestions = resolvedRes.count ?? 0
    aiLearning.pending_resolution   = aiLearning.total_suggestions - aiLearning.resolved_suggestions
    for (const r of reactionRes.data ?? []) {
      if (r.owner_reaction && r.owner_reaction in aiLearning.reactions) {
        aiLearning.reactions[r.owner_reaction]++
      }
    }

    // Directional bias — mean signed error % across all resolved rows.
    // Positive = AI tends to under-predict (actuals come in higher).
    // Negative = AI tends to over-predict.
    const biasQ = db
      .from('ai_forecast_outcomes')
      .select('revenue_error_pct')
      .not('revenue_error_pct', 'is', null)
    if (businessFilter) biasQ.eq('business_id', businessFilter)
    const { data: biasRows } = await biasQ
    const errs = (biasRows ?? []).map(r => Number(r.revenue_error_pct)).filter(n => Number.isFinite(n))
    if (errs.length) {
      const mean = errs.reduce((s, n) => s + n, 0) / errs.length
      aiLearning.directional_bias = { mean_error_pct: Math.round(mean * 10) / 10, sample_size: errs.length }
    }

    // Enrich each recent row with business_name for UI readability.
    const bizNameMap = new Map<string, string>()
    for (const b of businessesList ?? []) bizNameMap.set(b.id, b.name ?? b.id.slice(0, 8))
    aiLearning.recent_rows = (recentRes.data ?? []).map((r: any) => ({
      ...r,
      business_name: bizNameMap.get(r.business_id) ?? r.business_id.slice(0, 8),
    }))
    aiLearning.filtered_by_business_id = businessFilter
  } catch { /* M020 may not be applied */ }

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
    error_feed:       errorFeed,
    extraction_queue: extractionQueue,
    stripe_dedup:     stripeDedup,
    rate_limit_hits:  rateLimitHits,
    ai_learning:      aiLearning,
    businesses:       (businessesList ?? []).map((b: any) => ({
      id:        b.id,
      name:      b.name,
      org_id:    b.org_id,
      org_name:  b.organisations?.name ?? null,
      is_active: b.is_active,
    })),
  })
}
