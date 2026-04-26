// app/api/fortnox/reextract-all/route.ts
//
// Bulk re-extract for an entire business or whole org. Useful after a
// schema/prompt upgrade (M028 depreciation, M029 revenue VAT split) when
// you want every historical PDF re-run with the latest extractor without
// clicking 29 individual buttons.
//
// Resets each eligible upload to 'extracting' and queues a fresh
// extraction_jobs row. The pg_cron worker drains the queue (3 jobs/min
// at the default cadence) so a 30-PDF re-extract completes in ~10 min.
//
// User-scoped: only re-extracts uploads belonging to the caller's org.
// Optional business_id filter. Skips uploads in {pending, extracting,
// rejected, superseded} — matches the single-shot endpoint's REEXTRACTABLE
// allowlist.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { log } from '@/lib/log/structured'
import { waitUntil } from '@vercel/functions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const REEXTRACTABLE = ['extracted', 'applied', 'failed']

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({} as any))
  const businessId = body.business_id as string | undefined

  const db = createAdminClient()

  let q = db
    .from('fortnox_uploads')
    .select('id, business_id, status, pdf_storage_path, period_year, period_month')
    .eq('org_id', auth.orgId)
    .in('status', REEXTRACTABLE)
    .not('pdf_storage_path', 'is', null)

  if (businessId) q = q.eq('business_id', businessId)

  const { data: uploads, error: listErr } = await q
  if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 })
  if (!uploads?.length) {
    return NextResponse.json({ ok: true, queued: 0, message: 'No eligible uploads found.' })
  }

  // Batch the resets so a slow per-row update doesn't blow Vercel's 60 s
  // budget at 30+ uploads. One UPDATE then one UPSERT, both touching the
  // full set in a single Supabase call each.
  const ids = uploads.map(u => u.id)

  const { error: upErr } = await db.from('fortnox_uploads')
    .update({ status: 'extracting', error_message: null })
    .in('id', ids)
  if (upErr) {
    log.error('reextract-all upload reset failed', { route: 'fortnox/reextract-all', error: upErr.message, count: ids.length })
    return NextResponse.json({ error: `Failed to reset uploads: ${upErr.message}` }, { status: 500 })
  }

  const now = new Date().toISOString()
  const jobRows = uploads.map(u => ({
    org_id:        auth.orgId,
    business_id:   u.business_id,
    upload_id:     u.id,
    status:        'pending',
    attempts:      0,
    started_at:    null,
    completed_at:  null,
    scheduled_for: now,
    error_message: null,
    progress:      { phase: 'queued', message: 'Bulk re-extract requested', percent: 0 },
    updated_at:    now,
  }))

  const { error: jobErr } = await db.from('extraction_jobs').upsert(jobRows, { onConflict: 'upload_id' })
  if (jobErr) {
    log.error('reextract-all job upsert failed', { route: 'fortnox/reextract-all', error: jobErr.message, count: jobRows.length })
    return NextResponse.json({ error: `Failed to queue jobs: ${jobErr.message}` }, { status: 500 })
  }

  log.info('fortnox-reextract-all queued', {
    route:       'fortnox/reextract-all',
    org_id:      auth.orgId,
    business_id: businessId ?? null,
    queued:      uploads.length,
  })

  // Kick the worker — pg_cron will catch up anyway but this halves the
  // first-result latency for the user.
  waitUntil((async () => {
    const base = process.env.NEXT_PUBLIC_APP_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    if (!base) return
    fetch(`${base}/api/fortnox/extract-worker`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
      },
      body: JSON.stringify({ trigger: 'reextract-all' }),
    }).catch(() => {})
  })())

  // Estimated drain time at pg_cron's 20s cadence + sequential worker.
  // Real throughput is faster because each worker chains the next job
  // when it finishes, but ~20s/PDF is a safe upper bound to quote.
  const eta_seconds = uploads.length * 20

  return NextResponse.json({
    ok: true,
    queued: uploads.length,
    eta_seconds,
    business_id: businessId ?? null,
    message: `Re-extraction queued for ${uploads.length} PDF(s). Drain ETA ~${Math.ceil(eta_seconds / 60)} min. Each upload will need to be Apply'd individually after extraction lands.`,
  })
}
