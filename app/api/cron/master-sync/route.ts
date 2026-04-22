// @ts-nocheck
// app/api/cron/master-sync/route.ts
// Master daily sync — runs all connected integrations for all orgs
// Runs at 06:00 UTC daily

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { runSync }                   from '@/lib/sync/engine'
import { checkCronSecret }           from '@/lib/admin/check-secret'
import { log }                       from '@/lib/log/structured'
import { withTimeout as sharedWithTimeout } from '@/lib/sync/with-timeout'

export const runtime    = 'nodejs'
export const preferredRegion = 'fra1'  // EU-only; Supabase is Frankfurt
export const dynamic    = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  // Accepts Authorization: Bearer, x-cron-secret header, or ?secret= query.
  // Previous hardcoded `'commandcenter123'` fallback removed — any dev with
  // the repo could trigger a master-sync against production.
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const runStarted = Date.now()
  const db = createAdminClient()

  // Get all connected integrations across all orgs
  const { data: integrations } = await db
    .from('integrations')
    .select('org_id, provider, id')
    .eq('status', 'connected')
    .in('provider', ['personalkollen', 'fortnox', 'ancon', 'swess', 'caspeco', 'inzii'])

  if (!integrations?.length) {
    log.info('master-sync: no active integrations', { route: 'cron/master-sync' })
    return NextResponse.json({ ok: true, message: 'No active integrations' })
  }

  log.info('master-sync start', {
    route:        'cron/master-sync',
    integrations: integrations.length,
  })

  // Sync last 90 days for daily runs
  const now      = new Date()
  const from90   = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0,10)
  const toDate   = now.toISOString().slice(0,10)

  // Per-integration timeout. Vercel's maxDuration for this route is 300s.
  // One hung upstream API (Personalkollen / Fortnox) used to eat the whole budget
  // sequentially, blocking every subsequent customer. 60s per integration is the
  // envelope most healthy sync runs fit in.
  const PER_INTEGRATION_TIMEOUT_MS = 60_000

  // Concurrency cap. At 10 parallel integrations we process ~1 customer's worth
  // of integrations at once without overloading the DB or blowing past Vercel's
  // concurrent-outbound-request limits.
  const CONCURRENCY = 10

  async function syncOne(integ: any) {
    try {
      const result = await sharedWithTimeout(
        runSync(integ.org_id, integ.provider, from90, toDate, integ.id),
        PER_INTEGRATION_TIMEOUT_MS,
        `${integ.provider}/${integ.id}`,
      )
      return { org_id: integ.org_id, provider: integ.provider, business_id: integ.business_id, integration_id: integ.id, ...result }
    } catch (e: any) {
      return { org_id: integ.org_id, provider: integ.provider, integration_id: integ.id, error: e.message }
    }
  }

  // Process in batches of CONCURRENCY — each batch fully settles before the next.
  const results: any[] = []
  for (let i = 0; i < integrations.length; i += CONCURRENCY) {
    const batch = integrations.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(batch.map(syncOne))
    results.push(...batchResults)
  }

  const errors    = results.filter(r => r.error)
  const timedOut  = errors.filter(r => /^timeout:/.test(r.error ?? ''))

  log.info('master-sync complete', {
    route:        'cron/master-sync',
    duration_ms:  Date.now() - runStarted,
    integrations: integrations.length,
    errors:       errors.length,
    timed_out:    timedOut.length,
    status:       errors.length === 0 ? 'success' : 'partial',
  })

  return NextResponse.json({
    ok: errors.length === 0,
    synced: results.length,
    errors: errors.length,
    timed_out: timedOut.length,
    date_range: `${from90} to ${toDate}`,
    concurrency: CONCURRENCY,
    results,
  })
}
