// app/api/sync/now/route.ts
//
// POST — owner-triggered "sync everything now". Fires runSync for every
// connected integration the caller's org has. Used primarily by the
// cold-start banner on /dashboard so a freshly-signed-up customer
// doesn't have to wait until 04:00 UTC to see their first data load.
//
// Per-integration timeout 60s, all integrations run in parallel up to
// CONCURRENCY=5 (lower than master-sync because this fires interactively).
// Returns { ok, synced_count, errors[], post_aggregated, business_ids[] }.

import { NextRequest, NextResponse }    from 'next/server'
import { unstable_noStore as noStore }  from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { runSync }                      from '@/lib/sync/engine'
import { withTimeout as sharedWithTimeout } from '@/lib/sync/with-timeout'
import { filterEligible }               from '@/lib/sync/eligibility'
import { log }                          from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

const CONCURRENCY = 5
const PER_INTEGRATION_TIMEOUT_MS = 60_000

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const t0 = Date.now()

  // Same eligibility filter master-sync uses — connected + needs_reauth probes
  const { data: rawIntegrations } = await db
    .from('integrations')
    .select('org_id, provider, id, business_id, status, reauth_notified_at')
    .eq('org_id', auth.orgId)
    .in('status', ['connected', 'needs_reauth', 'error'])
    .in('provider', ['personalkollen', 'fortnox', 'ancon', 'swess', 'caspeco', 'inzii'])
  const integrations = filterEligible(rawIntegrations ?? [])

  if (!integrations.length) {
    return NextResponse.json({
      ok: false,
      reason: 'no_integrations',
      message: 'Connect at least one integration before triggering a sync.',
    })
  }

  // 90-day window matches master-sync. Per-call this is enough for fresh
  // customers to see their first 3 months of data.
  const now    = new Date()
  const from90 = new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10)
  const toDate = now.toISOString().slice(0, 10)

  async function syncOne(integ: any) {
    try {
      const result = await sharedWithTimeout(
        runSync(integ.org_id, integ.provider, from90, toDate, integ.id),
        PER_INTEGRATION_TIMEOUT_MS,
        `${integ.provider}/${integ.id}`,
      )
      return { provider: integ.provider, business_id: integ.business_id, ok: true, ...result }
    } catch (e: any) {
      return { provider: integ.provider, business_id: integ.business_id, ok: false, error: e.message }
    }
  }

  const results: any[] = []
  for (let i = 0; i < integrations.length; i += CONCURRENCY) {
    const batch = integrations.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(batch.map(syncOne))
    results.push(...batchResults)
  }

  const errors    = results.filter(r => !r.ok)
  const uniqueBiz = new Set<string>()
  for (const r of results) if (r.business_id) uniqueBiz.add(r.business_id)

  // Aggregate metrics for every business that synced. Same pattern as
  // master-sync — each business holds its own aggregation_lock so the
  // parallel run is safe.
  let postAggregated = 0
  let postAggErrors  = 0
  if (uniqueBiz.size > 0) {
    const { aggregateMetrics } = await import('@/lib/sync/aggregate')
    const bizList = Array.from(uniqueBiz)
    for (let i = 0; i < bizList.length; i += 5) {
      const slice = bizList.slice(i, i + 5)
      const batchResults = await Promise.allSettled(slice.map(b =>
        aggregateMetrics(auth.orgId, b, from90, toDate),
      ))
      for (const r of batchResults) {
        if (r.status === 'fulfilled') postAggregated++; else postAggErrors++
      }
    }
  }

  log.info('sync/now complete', {
    route:       'sync/now',
    duration_ms: Date.now() - t0,
    org_id:      auth.orgId,
    integrations: integrations.length,
    synced:      results.length - errors.length,
    errors:      errors.length,
    post_aggregated: postAggregated,
  })

  return NextResponse.json({
    ok:                errors.length === 0,
    synced_count:      results.length - errors.length,
    error_count:       errors.length,
    business_ids:      Array.from(uniqueBiz),
    post_aggregated:   postAggregated,
    post_agg_errors:   postAggErrors,
    duration_ms:       Date.now() - t0,
    results,
  })
}
