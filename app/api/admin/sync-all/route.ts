// @ts-nocheck
// app/api/admin/sync-all/route.ts
// Admin-only: sync every connected integration across all orgs.
// Used by the admin health page "Sync all now" button.
// Unlike /api/cron/master-sync this is triggered on demand and surfaces
// per-integration results so the operator can see what succeeded/failed.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { runSync }                   from '@/lib/sync/engine'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { withTimeout }               from '@/lib/sync/with-timeout'
import { log }                       from '@/lib/log/structured'

export const dynamic     = 'force-dynamic'
export const maxDuration = 300

const PER_INTEGRATION_TIMEOUT_MS = 60_000
const CONCURRENCY = 5

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req)
  if ('ok' in guard === false) return guard as NextResponse

  const db      = createAdminClient()
  const started = Date.now()

  const { data: integrations } = await db
    .from('integrations')
    .select('id, org_id, business_id, provider, status')
    .eq('status', 'connected')
    .in('provider', ['personalkollen', 'fortnox', 'inzii', 'ancon', 'swess', 'caspeco', 'onslip'])

  if (!integrations?.length) {
    return NextResponse.json({ ok: true, message: 'No connected integrations found', synced: 0, errors: 0 })
  }

  const now   = new Date()
  const from7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const to    = now.toISOString().slice(0, 10)

  const results: any[] = []
  for (let i = 0; i < integrations.length; i += CONCURRENCY) {
    const batch = integrations.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(batch.map(async (integ: any) => {
      try {
        const result = await withTimeout(
          runSync(integ.org_id, integ.provider, from7, to, integ.id),
          PER_INTEGRATION_TIMEOUT_MS,
          `${integ.provider}/${integ.id}`,
        )
        return { provider: integ.provider, business_id: integ.business_id, integration_id: integ.id, ...result }
      } catch (e: any) {
        return { provider: integ.provider, business_id: integ.business_id, integration_id: integ.id, error: e.message }
      }
    }))
    results.push(...batchResults)
  }

  // Post-aggregate for each business that had a successful sync
  const uniqueBiz = new Map<string, { orgId: string; businessId: string }>()
  for (const r of results) {
    if (r.business_id && !r.error) {
      uniqueBiz.set(`${r.org_id ?? ''}|${r.business_id}`, { orgId: r.org_id ?? '', businessId: r.business_id })
    }
  }
  if (uniqueBiz.size) {
    const { aggregateMetrics } = await import('@/lib/sync/aggregate')
    for (const { orgId, businessId } of uniqueBiz.values()) {
      try { await aggregateMetrics(orgId, businessId, from7, to) } catch { /* best-effort */ }
    }
  }

  const errors = results.filter(r => r.error).length
  log.info('admin sync-all complete', {
    route: 'admin/sync-all',
    duration_ms: Date.now() - started,
    synced: results.length,
    errors,
  })

  return NextResponse.json({
    ok:     errors === 0,
    synced: results.length - errors,
    errors,
    date_range: `${from7} to ${to}`,
    detail: results.map(r => ({
      provider:        r.provider,
      business_id:     r.business_id,
      integration_id:  r.integration_id,
      error:           r.error ?? null,
      records_synced:  r.revenue_days ?? r.shifts ?? null,
    })),
  })
}
