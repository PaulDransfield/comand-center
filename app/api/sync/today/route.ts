// @ts-nocheck
// app/api/sync/today/route.ts
//
// On-demand "today only" sync. Dashboard / staff / tracker pages fire this
// on mount (fire-and-forget). Syncs only today for the selected business and
// re-aggregates today's daily_metrics row.
//
// Throttled: if an integration synced in the last 10 minutes, we skip it and
// return cached freshness info. Page views never spawn more than 1 sync per
// 10 min per integration even if Paul refreshes 50 times.
//
// Auth: normal session (getRequestAuth) — only members of the org can trigger
// a sync for their own business. No admin secret needed.
//
// Why this shape (vs a cron): Hobby plan crons are daily-only. On-demand
// triggering from page-views gets the same "live feel" for active users
// without needing intra-day cron capability.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { runSync }                           from '@/lib/sync/engine'
import { filterEligible }                    from '@/lib/sync/eligibility'

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

// Integrations are only re-synced on-demand if their last_sync_at is older than this.
const THROTTLE_MS = 10 * 60_000  // 10 min

// Hard limit per request so a bad call can't wedge the page.
const PER_INTEGRATION_TIMEOUT_MS = 12_000

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${label} exceeded ${ms}ms`)), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

export async function POST(req: NextRequest) {
  noStore()

  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })

  const bizId = req.nextUrl.searchParams.get('business_id')
  if (!bizId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()

  // Confirm the caller's org owns this business — prevents cross-tenant sync.
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id')
    .eq('id', bizId)
    .maybeSingle()
  if (!biz || biz.org_id !== auth.orgId) {
    return NextResponse.json({ error: 'not your business' }, { status: 403 })
  }

  // Fetch all live integrations for this business that benefit from intraday
  // sync. Includes needs_reauth ones whose probe backoff has elapsed (see
  // lib/sync/eligibility.ts) so a transient PK 401 can self-heal on next
  // page load rather than waiting for manual reconnect.
  const { data: rawIntegrations } = await db
    .from('integrations')
    .select('id, provider, last_sync_at, status, reauth_notified_at')
    .in('status', ['connected', 'needs_reauth', 'error'])
    .eq('business_id', bizId)
    .in('provider', ['personalkollen', 'inzii', 'ancon', 'swess', 'onslip'])

  const integrations = filterEligible(rawIntegrations ?? [])

  if (!integrations?.length) {
    return NextResponse.json({ ok: true, synced: 0, skipped: 0, reason: 'no connected integrations' }, {
      headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
    })
  }

  const today     = new Date().toISOString().slice(0, 10)
  // Window = today + yesterday. "Today only" was lossy: if the morning cron
  // hit PK before yesterday's evening sales finalised, we'd never backfill
  // until the NEXT morning's master-sync. A 2-day window keeps page-load
  // triggers self-healing — worst case is yesterday's late data is picked
  // up within minutes of the owner opening the app.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const cutoff    = Date.now() - THROTTLE_MS

  const results: any[] = []
  for (const integ of integrations) {
    const lastSyncMs = integ.last_sync_at ? new Date(integ.last_sync_at).getTime() : 0
    if (lastSyncMs > cutoff) {
      results.push({ provider: integ.provider, skipped: true, reason: 'throttled', last_sync_at: integ.last_sync_at })
      continue
    }
    const start = Date.now()
    try {
      const out = await withTimeout(
        runSync(auth.orgId, integ.provider, yesterday, today, integ.id),
        PER_INTEGRATION_TIMEOUT_MS,
        `${integ.provider}/${integ.id}`,
      )
      results.push({ provider: integ.provider, duration_ms: Date.now() - start, ...out })
    } catch (e: any) {
      results.push({ provider: integ.provider, duration_ms: Date.now() - start, error: e.message })
    }
  }

  return NextResponse.json({
    ok:      results.every(r => !r.error),
    date:    today,
    synced:  results.filter(r => !r.skipped && !r.error).length,
    skipped: results.filter(r => r.skipped).length,
    errors:  results.filter(r => r.error).length,
    results,
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}
