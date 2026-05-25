// app/api/cron/extraction-sweeper/route.ts
//
// Runs every 2 minutes (see vercel.json) on Vercel Pro. Two responsibilities:
//
//  1. Reset stale jobs — any extraction_jobs row stuck in 'processing'
//     for more than 10 minutes is assumed to have crashed (Vercel
//     killed the worker, OOM, transient error). Calls the
//     reset_stale_extraction_jobs() RPC which flips them back to
//     'pending' so the retry path picks them up.
//
//  2. Fire worker for ready jobs — lists up to 10 pending jobs whose
//     scheduled_for is in the past, and invokes the worker once per
//     job (the worker's atomic claim RPC ensures no duplicate work).
//     This covers the case where the dispatcher's fire-and-forget
//     trigger didn't land (cold-start race, network partition, etc.).
//
// Also serves as the backoff executor — a worker that rescheduled a
// job with scheduled_for=now+30s sleeps until this sweeper wakes it.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { checkCronSecret }   from '@/lib/admin/check-secret'
import { log }               from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const preferredRegion = 'fra1'  // EU-only; Supabase is Frankfurt
export const maxDuration = 30

export async function GET(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  const db = createAdminClient()

  // Step 1 — reset anything stuck in 'processing' for too long.
  const { data: resetCount, error: resetErr } = await db.rpc('reset_stale_extraction_jobs')
  if (resetErr) log.error('sweeper reset rpc failed', { route: 'cron/extraction-sweeper', error: resetErr.message })

  // Step 2 — list jobs ready to fire.
  const { data: ready, error: listErr } = await db.rpc('list_ready_extraction_jobs', { max_jobs: 10 })
  if (listErr) {
    // Returning 500 here used to make Vercel infinite-retry the cron in
    // tight succession; if the RPC failure was transient (DB blip) a
    // second sweep would land while the first was still in-flight,
    // causing job-claim races. Log + return 200 — the cron fires every
    // 2 minutes anyway, so the next regular tick will retry naturally.
    log.error('sweeper list rpc failed', { route: 'cron/extraction-sweeper', error: listErr.message })
    return NextResponse.json({
      ok: false,
      reset_count: resetCount ?? 0,
      error: listErr.message,
      will_retry_on_next_cron: true,
    })
  }
  const jobs = Array.isArray(ready) ? ready : []

  const base = process.env.NEXT_PUBLIC_APP_URL
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  if (!base) {
    log.error('sweeper no base url', { route: 'cron/extraction-sweeper' })
    return NextResponse.json({
      ok: false,
      reset_count: resetCount ?? 0,
      error: 'No base URL available for worker fire',
      will_retry_on_next_cron: true,
    })
  }

  const fires = jobs.map(() =>
    fetch(`${base}/api/fortnox/extract-worker`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.CRON_SECRET}`,
      },
      body: JSON.stringify({ trigger: 'sweeper' }),
    }).then(r => ({ status: r.status })).catch((e: any) => ({ error: e?.message ?? 'fire failed' })),
  )
  const fireResults = await Promise.all(fires)

  log.info('sweeper run complete', {
    route:       'cron/extraction-sweeper',
    duration_ms: Date.now() - started,
    reset_count: resetCount ?? 0,
    queued:      jobs.length,
  })

  return NextResponse.json({
    ok:           true,
    reset_count:  resetCount ?? 0,
    queued:       jobs.length,
    fire_results: fireResults,
  })
}
