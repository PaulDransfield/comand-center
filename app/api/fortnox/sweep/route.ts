// app/api/fortnox/sweep/route.ts
//
// User-scoped sweep for the Fortnox extraction queue. Exists because
// on the Hobby plan the sweeper cron only runs daily (06:00 UTC) — if
// a dispatcher's fire-and-forget fetch to the worker fails for any
// reason (cold start timing, network blip, upstream 5xx), the job
// sits in 'pending' until the next morning's cron tick.
//
// Calling this endpoint from /overheads/upload while the user is
// actively waiting for an extraction gives them a near-real-time
// retry path without the $20/month Vercel Pro upgrade.
//
// POST (no body) — finds any 'pending' or stale-'processing' jobs
// for the caller's org and fires the worker for each. Admin client
// for the query, user-session auth for the gate.

import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { log } from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Server misconfigured: CRON_SECRET not set' }, { status: 500 })
  }

  const db = createAdminClient()

  // Find jobs belonging to the caller's org that need kicking.
  // Two buckets:
  //   1. 'pending' jobs whose scheduled_for is now-or-past
  //   2. 'processing' jobs older than 10 minutes (stuck worker)
  const { data: ready } = await db
    .from('extraction_jobs')
    .select('id, upload_id, status, scheduled_for, started_at')
    .eq('org_id', auth.orgId)
    .in('status', ['pending', 'processing'])
    .order('scheduled_for', { ascending: true })
    .limit(25)

  const now = Date.now()
  const tenMinMs = 10 * 60_000
  const toKick = (ready ?? []).filter(j => {
    if (j.status === 'pending') {
      const sched = j.scheduled_for ? new Date(j.scheduled_for).getTime() : 0
      return sched <= now
    }
    // 'processing': kick if stuck for >10 min (same logic as the
    // sweeper cron's reset_stale_extraction_jobs() RPC)
    const started = j.started_at ? new Date(j.started_at).getTime() : 0
    return started > 0 && now - started > tenMinMs
  })

  if (!toKick.length) {
    return NextResponse.json({ ok: true, kicked: 0, message: 'No jobs waiting' })
  }

  // Reset any stale-processing jobs back to pending first, then fire
  // the worker. Sweeper's reset RPC handles the whole batch.
  const staleIds = toKick.filter(j => j.status === 'processing').map(j => j.id)
  if (staleIds.length) {
    await db.from('extraction_jobs').update({
      status:     'pending',
      started_at: null,
      updated_at: new Date().toISOString(),
    }).in('id', staleIds)
  }

  // Fire the worker once per job. The worker's atomic claim RPC means
  // firing N times yields at most N claims — if the worker runs faster
  // than we fire, extra firings become harmless no-ops.
  const base = process.env.NEXT_PUBLIC_APP_URL
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `https://${req.headers.get('host')}`)

  const fires = toKick.map(() =>
    fetch(`${base}/api/fortnox/extract-worker`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.CRON_SECRET}`,
      },
      body: JSON.stringify({ trigger: 'user_sweep' }),
    }).catch((e: any) => {
      log.warn('user-sweep fire failed', {
        route: 'fortnox/sweep',
        org_id: auth.orgId,
        error:  e?.message ?? 'fire error',
      })
    }),
  )
  // waitUntil keeps the function alive until outbound fires leave
  waitUntil(Promise.all(fires))

  log.info('fortnox-sweep triggered', {
    route:   'fortnox/sweep',
    org_id:  auth.orgId,
    user_id: auth.userId,
    kicked:  toKick.length,
    stale:   staleIds.length,
    status:  'success',
  })

  return NextResponse.json({
    ok:     true,
    kicked: toKick.length,
    stale_reset: staleIds.length,
  })
}
