// @ts-nocheck
// app/api/admin/overview/route.ts
// KPIs + recent activity + cron status for /admin/overview.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { PLANS }                     from '@/lib/stripe/config'
import { checkAdminSecret } from '@/lib/admin/check-secret'

export const dynamic = 'force-dynamic'

function checkAuth(req: NextRequest): boolean {
  return checkAdminSecret(req)
}

// vercel.json cron schedule summary for expected next-run calculation + last-run lookup
const EXPECTED_CRONS = [
  { path: '/api/cron/master-sync',             schedule: '0 5 * * *',   name: 'Master sync' },
  { path: '/api/cron/anomaly-check',           schedule: '30 5 * * *',  name: 'Anomaly check' },
  { path: '/api/cron/health-check',            schedule: '0 6 * * *',   name: 'Health check' },
  { path: '/api/cron/weekly-digest',           schedule: '0 6 * * 1',   name: 'Weekly digest' },
  { path: '/api/cron/forecast-calibration',    schedule: '0 4 1 * *',   name: 'Forecast calibration' },
  { path: '/api/cron/supplier-price-creep',    schedule: '0 5 1 * *',   name: 'Supplier price creep' },
  { path: '/api/cron/scheduling-optimization', schedule: '0 7 * * 1',   name: 'Scheduling optimisation' },
  { path: '/api/cron/onboarding-success',      schedule: '0 8 * * *',   name: 'Onboarding success' },
  { path: '/api/cron/api-discovery-enhanced',  schedule: '0 3 * * 0',   name: 'API discovery' },
]

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createAdminClient()
  const now = Date.now()
  const day = 86_400_000
  const weekAgo     = new Date(now - 7  * day).toISOString()
  const lastWeekAgo = new Date(now - 14 * day).toISOString()
  const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10)

  // Parallel fetches
  const [orgsRes, integsRes, setupReqsRes, alertsRes, aiMonthRes] = await Promise.all([
    db.from('organisations').select('id, name, plan, is_active, created_at, stripe_customer_id').order('created_at', { ascending: false }),
    db.from('integrations').select('org_id, status, last_sync_at'),
    db.from('onboarding_progress').select('org_id, step, metadata, updated_at').eq('step', 'setup_requested').order('updated_at', { ascending: false }).limit(5),
    db.from('anomaly_alerts').select('org_id, severity, title, created_at').eq('is_dismissed', false).order('created_at', { ascending: false }).limit(10),
    db.from('ai_usage_daily').select('org_id, query_count, date').gte('date', firstOfMonth),
  ])

  const orgs = orgsRes.data ?? []
  const integrations = integsRes.data ?? []

  // Bucket orgs into stages + MRR calc
  let mrrSek = 0, active = 0, trialing = 0, atRisk = 0, churned = 0, inSetup = 0
  const byOrg: Record<string, any> = {}
  for (const o of orgs) byOrg[o.id] = o

  for (const o of orgs) {
    if (!o.is_active) { churned++; continue }
    const integs = integrations.filter((i: any) => i.org_id === o.id)
    const connected = integs.filter((i: any) => i.status === 'connected')
    const lastSyncTs = integs.map((i: any) => i.last_sync_at ? new Date(i.last_sync_at).getTime() : 0).reduce((a, b) => Math.max(a, b), 0)
    const lastSyncDays = lastSyncTs > 0 ? Math.floor((now - lastSyncTs) / day) : null

    if (o.plan === 'trial') trialing++
    if (connected.length === 0) { /* new */ }
    else if (lastSyncTs === 0) { inSetup++ }
    else if (lastSyncDays !== null && lastSyncDays > 14) { atRisk++ }
    else { active++ }

    // MRR — only count non-trial, active
    if (o.is_active && o.plan && o.plan !== 'trial') {
      const plan = PLANS[o.plan as keyof typeof PLANS]
      if (plan && plan.price_sek) mrrSek += plan.price_sek
    }
  }

  // Signups this week vs last week
  const signupsThisWeek = orgs.filter((o: any) => new Date(o.created_at).getTime() > now - 7 * day).length
  const signupsLastWeek = orgs.filter((o: any) => {
    const t = new Date(o.created_at).getTime()
    return t > now - 14 * day && t <= now - 7 * day
  }).length

  // Recent signups (top 5)
  const recentSignups = orgs.slice(0, 5).map((o: any) => ({
    id:         o.id,
    name:       o.name,
    plan:       o.plan,
    created_at: o.created_at,
    is_active:  o.is_active,
  }))

  // Recent setup requests (already filtered in query)
  const recentSetupRequests = (setupReqsRes.data ?? []).map((s: any) => ({
    org_id:      s.org_id,
    org_name:    byOrg[s.org_id]?.name,
    restaurant:  s.metadata?.restaurantName,
    city:        s.metadata?.city,
    staff:       s.metadata?.staffSystem,
    accounting:  s.metadata?.accounting,
    pos:         s.metadata?.pos,
    requested_at: s.updated_at,
  }))

  // Critical/high alerts recent
  const criticalAlerts = (alertsRes.data ?? []).filter((a: any) => a.severity === 'critical' || a.severity === 'high').slice(0, 5).map((a: any) => ({
    ...a,
    org_name: byOrg[a.org_id]?.name,
  }))

  // AI cost this month (Haiku $1 input / $5 output per 1M tokens; avg 500 input + 150 output per query = ~$0.00125/query)
  // This is rough — give an order of magnitude, not billing-accurate.
  const aiQueriesThisMonth = (aiMonthRes.data ?? []).reduce((s: number, r: any) => s + Number(r.query_count ?? 0), 0)
  const aiCostEstimateUsd = aiQueriesThisMonth * 0.00125

  // Cron status — look up sync_log for most recent by provider, plus check for
  // health-check / other cron-specific tables. For MVP just show expected schedules
  // + a "last run from sync_log" where applicable.
  const { data: recentSyncLogs } = await db
    .from('sync_log')
    .select('provider, status, created_at')
    .order('created_at', { ascending: false })
    .limit(50)

  const lastSyncByProvider: Record<string, any> = {}
  for (const s of recentSyncLogs ?? []) {
    if (!lastSyncByProvider[s.provider]) lastSyncByProvider[s.provider] = s
  }

  const cronStatus = EXPECTED_CRONS.map(c => {
    // Approximate — real per-cron last-run would need a cron_runs table.
    // For now we just use the existence of related activity.
    let lastRun = null
    if (c.path.includes('master-sync') || c.path.includes('personalkollen')) {
      lastRun = lastSyncByProvider.personalkollen?.created_at ?? null
    }
    return {
      name:         c.name,
      path:         c.path,
      schedule:     c.schedule,
      last_run:     lastRun,
    }
  })

  return NextResponse.json({
    kpis: {
      total_customers:     orgs.length,
      active_customers:    active,
      trialing,
      at_risk:             atRisk,
      in_setup:            inSetup,
      churned,
      mrr_sek:             mrrSek,
      signups_this_week:   signupsThisWeek,
      signups_last_week:   signupsLastWeek,
      ai_queries_month:    aiQueriesThisMonth,
      ai_cost_usd_month:   aiCostEstimateUsd,
    },
    recent_signups:       recentSignups,
    recent_setup_requests: recentSetupRequests,
    critical_alerts:      criticalAlerts,
    cron_status:          cronStatus,
  })
}
