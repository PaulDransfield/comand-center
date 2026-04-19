// @ts-nocheck
// app/api/cron/hot-sync/route.ts
//
// Every 15 min: pull TODAY ONLY from every connected integration and
// re-aggregate today's daily_metrics row. Keeps the dashboard feeling
// live without the 90-day full sync that master-sync does at 05:00 UTC.
//
// Separate from master-sync so:
//   - Rate limits stay bounded (today = ~30 POS rows, ~30 shift rows per biz)
//   - A transient upstream failure doesn't trigger the full 90-day backfill
//   - Failure mode is obvious: only today's number is stale, history unaffected

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { runSync }                   from '@/lib/sync/engine'
import { checkCronSecret }           from '@/lib/admin/check-secret'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

// 15s per integration is tight but adequate — today-only fetches are small.
// If an upstream API is slow we'd rather fail fast and try again in 15 min
// than block the queue.
const PER_INTEGRATION_TIMEOUT_MS = 15_000
const CONCURRENCY                = 10

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${label} exceeded ${ms}ms`)), ms)
    p.then(v => { clearTimeout(t); resolve(v) },
           e => { clearTimeout(t); reject(e) })
  })
}

export async function GET(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createAdminClient()

  const { data: integrations } = await db
    .from('integrations')
    .select('id, org_id, provider, business_id')
    .eq('status', 'connected')
    .in('provider', ['personalkollen', 'inzii', 'ancon', 'swess', 'onslip'])
    // Excluded fortnox — invoices post on a different cadence, nightly is fine.

  if (!integrations?.length) {
    return NextResponse.json({ ok: true, message: 'No active integrations', synced: 0 })
  }

  const today = new Date().toISOString().slice(0, 10)

  async function syncOne(integ: any) {
    const start = Date.now()
    try {
      const result = await withTimeout(
        runSync(integ.org_id, integ.provider, today, today, integ.id),
        PER_INTEGRATION_TIMEOUT_MS,
        `${integ.provider}/${integ.id}`,
      )
      return { provider: integ.provider, integration_id: integ.id, duration_ms: Date.now() - start, ...result }
    } catch (e: any) {
      return { provider: integ.provider, integration_id: integ.id, duration_ms: Date.now() - start, error: e.message }
    }
  }

  const results: any[] = []
  for (let i = 0; i < integrations.length; i += CONCURRENCY) {
    const batch = integrations.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(batch.map(syncOne))
    results.push(...batchResults)
  }

  const errors = results.filter(r => r.error)

  return NextResponse.json({
    ok:         errors.length === 0,
    date:       today,
    synced:     results.length,
    errors:     errors.length,
    total_ms:   results.reduce((s, r) => s + (r.duration_ms ?? 0), 0),
    results,
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}
