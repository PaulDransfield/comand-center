// app/api/fortnox/extract/route.ts
//
// Thin dispatcher. Flips the upload row to status='extracting', kicks
// off the actual Anthropic extraction as a background Vercel function
// invocation (/api/fortnox/extract-worker with CRON_SECRET auth), and
// returns immediately to the browser. The worker writes its result
// straight into fortnox_uploads; the UI polls /api/fortnox/uploads to
// see the status flip to 'extracted' or 'failed'.
//
// Why a separate worker: Sonnet/Haiku on a 12-month Fortnox PDF can
// push past Vercel's 300s function timeout when it's tied to the
// browser request cycle. Splitting dispatcher and worker gives each
// its own time budget and lets the user close the tab mid-extraction.

import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { rateLimit } from '@/lib/middleware/rate-limit'

export const runtime     = 'nodejs'
export const maxDuration = 30     // dispatcher is fast — auth + DB flip + fire fetch

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const gate = rateLimit(auth.userId, { windowMs: 60 * 60_000, max: 60 })
  if (!gate.allowed) return NextResponse.json({ error: 'Too many extractions — try later' }, { status: 429 })

  const { upload_id } = await req.json().catch(() => ({} as any))
  if (!upload_id) return NextResponse.json({ error: 'upload_id required' }, { status: 400 })

  const db = createAdminClient()

  const { data: upload, error: getErr } = await db
    .from('fortnox_uploads')
    .select('id, org_id, status')
    .eq('id', upload_id)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (getErr || !upload) return NextResponse.json({ error: 'Upload not found' }, { status: 404 })
  if (upload.status === 'applied') {
    return NextResponse.json({ error: 'Already applied — extraction not re-runnable' }, { status: 400 })
  }

  // Flip to 'extracting' so the UI chip + progress text update immediately.
  await db.from('fortnox_uploads').update({
    status:        'extracting',
    error_message: 'Queued for background extraction…',
  }).eq('id', upload_id)

  // Resolve the absolute URL we call the worker at. VERCEL_URL is set on
  // every deployment; NEXT_PUBLIC_APP_URL works for local dev. The
  // fallback to req headers covers preview deploys without VERCEL_URL.
  const base = process.env.NEXT_PUBLIC_APP_URL
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    ?? `https://${req.headers.get('host')}`
  const workerUrl = `${base}/api/fortnox/extract-worker`

  if (!process.env.CRON_SECRET) {
    console.error('[fortnox/extract] CRON_SECRET missing — cannot trigger worker')
    await db.from('fortnox_uploads').update({
      status: 'failed',
      error_message: 'Server misconfigured: CRON_SECRET not set.',
    }).eq('id', upload_id)
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  // Fire-and-forget. waitUntil keeps the function process alive long
  // enough for the outbound HTTP request to leave, even though the
  // response to the browser has already been sent.
  const trigger = fetch(workerUrl, {
    method:  'POST',
    headers: {
      'Content-Type':   'application/json',
      'Authorization':  `Bearer ${process.env.CRON_SECRET}`,
    },
    body: JSON.stringify({ upload_id, org_id: auth.orgId }),
  }).then(async (r) => {
    // If the worker immediately failed (e.g. 500 before doing any work),
    // surface that so the row doesn't sit in 'extracting' until stale.
    if (!r.ok) {
      console.error('[fortnox/extract] worker returned', r.status, await r.text().catch(() => ''))
    }
  }).catch((e: any) => {
    console.error('[fortnox/extract] worker trigger failed:', e?.message ?? e)
  })

  waitUntil(trigger)

  return NextResponse.json({ ok: true, status: 'queued' })
}
