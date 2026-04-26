// app/api/fortnox/reextract/route.ts
//
// Re-runs the AI extraction on a previously-uploaded PDF using the CURRENT
// extract-worker code (latest prompts, classifier, schema). The PDF stays
// in storage — we just queue a new extraction job pointing at the same blob.
// No re-upload from the user's machine required.
//
// Use cases:
//   • Schema additions (depreciation/financial M028, revenue VAT split M029)
//     where the AI now produces fields old extractions didn't capture.
//   • Prompt improvements (few-shot example, validation retry loop) where
//     the same PDF re-extracted comes back more accurate.
//   • Recovering from a 'failed' status where the prior attempt died on a
//     transient error.
//
// Flow:
//   1. Validate user owns the upload.
//   2. Reset upload status to 'extracting' (keeps existing extracted_json
//      visible in the UI until the new one lands).
//   3. Reset/insert the extraction_jobs row for this upload — UPSERT pattern
//      because extraction_jobs.upload_id is UNIQUE (one row per upload).
//   4. Worker picks it up on the next pg_cron tick (≤20 s) or fast-path
//      via the dispatcher chain.
//   5. After extraction completes, the upload sits at 'extracted' with
//      fresh extracted_json. User reviews + clicks Apply to commit (which
//      uses the supersede chain inside applyMonthly so tracker_data
//      rebuilds cleanly).
//
// Status guard: only re-extracts uploads in {extracted, applied, failed}.
// 'rejected' and 'superseded' are terminal — re-extracting those would be
// surprising. Currently-extracting uploads are blocked to avoid racing
// with an in-flight worker.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { log } from '@/lib/log/structured'
import { waitUntil } from '@vercel/functions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const REEXTRACTABLE = new Set(['extracted', 'applied', 'failed'])

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { upload_id } = await req.json().catch(() => ({} as any))
  if (!upload_id) return NextResponse.json({ error: 'upload_id required' }, { status: 400 })

  const db = createAdminClient()

  const { data: upload, error: getErr } = await db
    .from('fortnox_uploads')
    .select('id, org_id, business_id, status, pdf_storage_path')
    .eq('id', upload_id)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (getErr || !upload) return NextResponse.json({ error: 'Upload not found' }, { status: 404 })

  if (!REEXTRACTABLE.has(upload.status)) {
    return NextResponse.json({
      error: `Cannot re-extract — upload is in '${upload.status}' state. Allowed: ${[...REEXTRACTABLE].join(', ')}.`,
    }, { status: 400 })
  }
  if (!upload.pdf_storage_path) {
    return NextResponse.json({ error: 'Upload has no stored PDF — cannot re-extract' }, { status: 400 })
  }

  // Mark as extracting. extracted_json stays so the UI shows the prior
  // result until the new one lands. error_message clears so any old
  // failure-noise is gone from the list view.
  const { error: upErr } = await db.from('fortnox_uploads').update({
    status:        'extracting',
    error_message: null,
  }).eq('id', upload.id)
  if (upErr) {
    log.error('reextract upload reset failed', { route: 'fortnox/reextract', upload_id, error: upErr.message })
    return NextResponse.json({ error: `Failed to reset upload status: ${upErr.message}` }, { status: 500 })
  }

  // UPSERT into extraction_jobs. The unique constraint on upload_id means
  // an UPDATE is more correct than INSERT for any upload that already has
  // a job row (the common case after the first extraction). Reset the
  // counter and clear the error so the worker treats this as a fresh run.
  const { error: jobErr } = await db.from('extraction_jobs').upsert({
    org_id:        upload.org_id,
    business_id:   upload.business_id,
    upload_id:     upload.id,
    status:        'pending',
    attempts:      0,
    started_at:    null,
    completed_at:  null,
    scheduled_for: new Date().toISOString(),
    error_message: null,
    progress:      { phase: 'queued', message: 'Re-extract requested', percent: 0 },
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'upload_id' })
  if (jobErr) {
    log.error('reextract job upsert failed', { route: 'fortnox/reextract', upload_id, error: jobErr.message })
    return NextResponse.json({ error: `Failed to queue extraction: ${jobErr.message}` }, { status: 500 })
  }

  log.info('fortnox-reextract queued', {
    route:       'fortnox/reextract',
    upload_id,
    org_id:      upload.org_id,
    business_id: upload.business_id,
    prior_status: upload.status,
  })

  // Fire the worker eagerly — pg_cron runs every 20s but kicking it now
  // gets the user's result back faster. waitUntil so we don't block on it.
  waitUntil((async () => {
    const base = process.env.NEXT_PUBLIC_APP_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    if (!base) return
    fetch(`${base}/api/fortnox/extract-worker`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
      },
      body: JSON.stringify({ trigger: 'reextract' }),
    }).catch(() => {})
  })())

  return NextResponse.json({
    ok: true,
    upload_id,
    message: 'Re-extraction queued. The new extracted_json will land within 20-60 seconds; click Apply to commit it.',
  })
}
