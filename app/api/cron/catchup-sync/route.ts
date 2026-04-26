// @ts-nocheck
// app/api/cron/catchup-sync/route.ts
//
// Self-healing catchup cron. Runs multiple times during business hours and
// re-syncs only the LAST 7 DAYS for every active integration. Exists because:
//
//  - The master-sync at 05:00 UTC pulls 90 days, but if Personalkollen / any
//    POS hasn't finalised yesterday's sales yet at that exact moment, the
//    data is silently missed for the whole day.
//  - A single timeout or transient 5xx on an upstream API used to mean
//    yesterday's data was blank until the NEXT morning's master-sync — a
//    24-hour outage on the freshest, most important day.
//  - This cron keeps the recent window tight + refreshed so late-landing
//    rows, timezone-edge sales, and any previously-failed sync are picked
//    up within hours, not days.
//
// Idempotent by design — every sync path upserts on natural keys. Running
// this multiple times a day is cheap (≤ 7 days × N integrations, each
// capped at 60s). Scheduled every 4h during business hours (10/14/18 UTC).
//
// Protected by CRON_SECRET header.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkCronSecret }           from '@/lib/admin/check-secret'
import { runSync }                   from '@/lib/sync/engine'
import { log }                       from '@/lib/log/structured'
import { withTimeout as sharedWithTimeout } from '@/lib/sync/with-timeout'
import { filterEligible }            from '@/lib/sync/eligibility'

export const runtime     = 'nodejs'
export const preferredRegion = 'fra1'  // EU-only; Supabase is Frankfurt
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

async function handle(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const runStarted = Date.now()
  const db = createAdminClient()

  // Includes connected + due-for-probe needs_reauth (lib/sync/eligibility.ts).
  const { data: rawIntegrations } = await db
    .from('integrations')
    .select('id, org_id, business_id, provider, status, reauth_notified_at')
    .in('status', ['connected', 'needs_reauth', 'error'])

  const integrations = filterEligible(rawIntegrations ?? [])

  if (!integrations?.length) {
    log.info('catchup-sync: no active integrations', { route: 'cron/catchup-sync' })
    return NextResponse.json({ ok: true, message: 'No active integrations' })
  }

  const probes = integrations.filter(i => i.status === 'needs_reauth').length
  if (probes > 0) {
    log.info('catchup-sync probing needs_reauth integrations', {
      route: 'cron/catchup-sync', probes,
    })
  }

  // Last 7 days keeps the payload small + the PK API happy. The master-sync
  // handles deeper backfills at 05:00 UTC. Stale-biz detection below extends
  // the window to 30 days for any business that's missing yesterday's row.
  const now    = new Date()
  const toDate = now.toISOString().slice(0, 10)
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const from7  = new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const from30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  // Gap detection: find businesses whose daily_metrics is missing yesterday's data.
  // If a business hasn't been aggregated for >1 day, extend the sync window to 30
  // days so the catch-up pull covers whatever the master-sync missed.
  const { data: freshnesRows } = await db
    .from('daily_metrics')
    .select('business_id, date')
    .gte('date', from7)
    .order('date', { ascending: false })

  const latestByBiz: Record<string, string> = {}
  for (const r of freshnesRows ?? []) {
    if (!latestByBiz[r.business_id]) latestByBiz[r.business_id] = r.date
  }

  // A business is "stale" if its newest daily_metrics row is before yesterday.
  const staleBizIds = new Set(
    Object.entries(latestByBiz)
      .filter(([, latest]) => latest < yesterday)
      .map(([bizId]) => bizId),
  )
  // Also flag businesses with no daily_metrics at all in last 7 days.
  for (const integ of integrations) {
    if (integ.business_id && !(integ.business_id in latestByBiz)) {
      staleBizIds.add(integ.business_id)
    }
  }

  const staleCount = staleBizIds.size
  if (staleCount > 0) {
    log.warn('catchup-sync: stale businesses detected — extending to 30-day window', {
      route: 'cron/catchup-sync',
      stale_count: staleCount,
      stale_biz_ids: [...staleBizIds],
    })
  }

  const PER_INTEGRATION_TIMEOUT_MS = 60_000
  const CONCURRENCY = 10

  async function syncOne(integ: any) {
    // Use 30-day window for stale businesses so we recover any gap.
    const fromDate = (integ.business_id && staleBizIds.has(integ.business_id)) ? from30 : from7
    try {
      const result = await sharedWithTimeout(
        runSync(integ.org_id, integ.provider, fromDate, toDate, integ.id),
        PER_INTEGRATION_TIMEOUT_MS,
        `${integ.provider}/${integ.id}`,
      )
      return { org_id: integ.org_id, provider: integ.provider, business_id: integ.business_id, integration_id: integ.id, ...result }
    } catch (e: any) {
      return { org_id: integ.org_id, provider: integ.provider, integration_id: integ.id, error: e.message }
    }
  }

  const results: any[] = []
  for (let i = 0; i < integrations.length; i += CONCURRENCY) {
    const batch = integrations.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(batch.map(syncOne))
    results.push(...batchResults)
  }

  const errors    = results.filter(r => r.error)
  const timedOut  = errors.filter(r => /^timeout:/.test(r.error ?? ''))
  const skipped   = results.filter(r => r.skipped).length

  // Post-aggregate safety net — see master-sync for rationale. Catches
  // late-arriving POS data that landed after a no-op sync skipped aggregate.
  const uniqueBiz = new Map<string, { orgId: string; businessId: string }>()
  for (const r of results) {
    if (!r.business_id) continue
    uniqueBiz.set(`${r.org_id}|${r.business_id}`, { orgId: r.org_id, businessId: r.business_id })
  }
  let postAggregated = 0
  let postAggErrors  = 0
  if (uniqueBiz.size) {
    const { aggregateMetrics } = await import('@/lib/sync/aggregate')
    for (const { orgId, businessId } of uniqueBiz.values()) {
      try {
        await aggregateMetrics(orgId, businessId, from7, toDate)
        postAggregated++
      } catch (e: any) {
        postAggErrors++
        log.warn('catchup-sync post-aggregate failed', {
          route: 'cron/catchup-sync', org_id: orgId, business_id: businessId, error: e?.message,
        })
      }
    }
  }

  log.info('catchup-sync complete', {
    route:        'cron/catchup-sync',
    duration_ms:  Date.now() - runStarted,
    integrations: integrations.length,
    errors:       errors.length,
    timed_out:    timedOut.length,
    skipped,
    post_aggregated: postAggregated,
    post_agg_errors: postAggErrors,
    status:       errors.length === 0 ? 'success' : 'partial',
  })

  return NextResponse.json({
    ok:         errors.length === 0,
    kind:       'catchup-sync',
    synced:     results.length,
    errors:     errors.length,
    timed_out:  timedOut.length,
    skipped,
    date_range: `${from7} to ${toDate}`,
    error_detail: errors.slice(0, 10).map(e => ({ provider: e.provider, integration_id: e.integration_id, error: e.error })),
  })
}

// Vercel Cron dispatches GET; accept both for manual triggering.
export const GET  = handle
export const POST = handle
