// app/api/fortnox/extract/route.ts
//
// Dispatcher. Upserts an extraction_jobs row (status='pending'), fires
// the worker endpoint via waitUntil so the outbound HTTP leaves even
// after we've returned, and responds to the browser in <100 ms.
//
// The worker has its own Vercel function invocation with its own 300 s
// budget. The sweeper cron (/api/cron/extraction-sweeper) retries any
// jobs the direct-invocation path misses. The browser polls to see the
// status change; it never blocks on the extraction itself.

import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { rateLimit } from '@/lib/middleware/rate-limit'

export const runtime     = 'nodejs'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const gate = rateLimit(auth.userId, { windowMs: 60 * 60_000, max: 60 })
  if (!gate.allowed) return NextResponse.json({ error: 'Too many extractions — try later' }, { status: 429 })

  const { upload_id } = await req.json().catch(() => ({} as any))
  if (!upload_id) return NextResponse.json({ error: 'upload_id required' }, { status: 400 })

  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Server misconfigured: CRON_SECRET not set' }, { status: 500 })
  }

  const db = createAdminClient()

  // Verify the upload exists, belongs to the caller's org, and isn't
  // already applied (applied rows are immutable for audit).
  const { data: upload, error: getErr } = await db
    .from('fortnox_uploads')
    .select('id, org_id, business_id, status')
    .eq('id', upload_id)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (getErr || !upload) return NextResponse.json({ error: 'Upload not found' }, { status: 404 })
  if (upload.status === 'applied') {
    return NextResponse.json({ error: 'Already applied — extraction not re-runnable' }, { status: 400 })
  }

  // Insert-or-re-arm the job. Concurrency-safe flow:
  //   1. Look up any existing job for this upload.
  //   2. If it's currently 'processing' or 'pending', reject the
  //      re-queue with 409 — a worker is either running it or
  //      about to. Clobbering the row would start a second worker
  //      and double-process (double AI cost, potential race in
  //      the fortnox_uploads write).
  //   3. Otherwise (failed / dead / completed / no row), upsert
  //      with status=pending and reset attempts/progress.
  const { data: existingJob } = await db
    .from('extraction_jobs')
    .select('id, status, attempts, started_at')
    .eq('upload_id', upload.id)
    .maybeSingle()

  if (existingJob) {
    const startedAgo = existingJob.started_at
      ? Date.now() - new Date(existingJob.started_at).getTime()
      : Infinity
    const STALE_MS = 10 * 60 * 1000

    // Only block if a worker is genuinely still running this job. A job
    // that's been 'processing' for more than 10 minutes is almost
    // certainly stuck (Vercel killed the function, cold-start crash,
    // Anthropic hang). The user's retry click is a valid signal to
    // reset — we'd rather over-run than leave a retry silently blocked.
    if (existingJob.status === 'processing' && startedAgo < STALE_MS) {
      return NextResponse.json({
        ok:     false,
        status: 'in_flight',
        error:  'Extraction is already in progress — wait for it to finish or click Cancel first.',
        job:    existingJob,
      }, { status: 409 })
    }
    // 'pending' jobs don't block the retry either — we upsert below and
    // the scheduled_for gets reset to now, so whatever backoff was in
    // play collapses and the worker picks it up immediately.
  }

  const { error: upErr } = await db.from('extraction_jobs').upsert({
    org_id:        upload.org_id,
    business_id:   upload.business_id,
    upload_id:     upload.id,
    status:        'pending',
    attempts:      0,
    scheduled_for: new Date().toISOString(),
    started_at:    null,
    completed_at:  null,
    error_message: null,
    progress:      { phase: 'queued', message: 'Queued for background extraction…' },
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'upload_id' })
  if (upErr) return NextResponse.json({ error: `Queue insert failed: ${upErr.message}` }, { status: 500 })

  // Mirror the status onto the upload row so the existing UI chip
  // already knows the extraction is queued. The worker/sweeper will
  // flip it through extracting → extracted/failed.
  await db.from('fortnox_uploads').update({
    status:        'extracting',
    error_message: 'Queued for background extraction…',
  }).eq('id', upload_id)

  // Fire the worker in the background. waitUntil keeps the function
  // alive long enough to send the outbound request, but the browser
  // has already received our 200.
  const base = process.env.NEXT_PUBLIC_APP_URL
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `https://${req.headers.get('host')}`)
  const workerUrl = `${base}/api/fortnox/extract-worker`

  const trigger = fetch(workerUrl, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.CRON_SECRET}`,
    },
    body: JSON.stringify({ trigger: 'dispatcher' }),
  }).then(async (r) => {
    if (!r.ok) console.error('[fortnox/extract] worker returned', r.status, await r.text().catch(() => ''))
  }).catch((e: any) => {
    console.error('[fortnox/extract] worker trigger failed:', e?.message ?? e)
  })
  waitUntil(trigger)

  return NextResponse.json({ ok: true, status: 'queued' })
}
