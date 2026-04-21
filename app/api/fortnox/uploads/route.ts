// app/api/fortnox/uploads/route.ts
//
// List + delete uploads for the /overheads page.  Keeps the upload/extract/
// apply endpoints separated so the UI can poll for status without hitting
// the heavier extraction path.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const u          = new URL(req.url)
  const businessId = u.searchParams.get('business_id')
  const statusOnly = u.searchParams.get('status')
  const limit      = Math.min(Number(u.searchParams.get('limit') ?? 50), 200)

  const db = createAdminClient()
  // Join the extraction_jobs queue row so the UI sees the live progress
  // JSON (phase, message, percent) alongside the upload status chip.
  let q = db
    .from('fortnox_uploads')
    .select('id, business_id, doc_type, period_year, period_month, pdf_filename, pdf_size_bytes, status, error_message, extracted_at, applied_at, created_at, extracted_json, extraction_jobs(status, attempts, max_attempts, scheduled_for, progress, error_message)')
    .eq('org_id', auth.orgId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (businessId) q = q.eq('business_id', businessId)
  if (statusOnly) q = q.eq('status', statusOnly)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Stale-extraction auto-reset. If a row has been stuck in extracting/
  // pending for more than 5 minutes, the extract function almost certainly
  // died (Vercel 504, cold-start OOM, network blip) and will never write
  // back. Flip it to 'failed' so the UI unblocks and the user can Retry
  // or Discard instead of polling forever.
  const STALE_MS = 5 * 60 * 1000
  const now      = Date.now()
  const stale    = (data ?? []).filter(r =>
    (r.status === 'extracting' || r.status === 'pending') &&
    r.created_at && (now - new Date(r.created_at).getTime()) > STALE_MS,
  )
  if (stale.length) {
    await db.from('fortnox_uploads').update({
      status:        'failed',
      error_message: 'Extraction timed out — the server did not respond within 5 minutes. Click Retry to try again.',
    }).in('id', stale.map(r => r.id))
    for (const r of stale) { r.status = 'failed'; r.error_message = 'Extraction timed out — the server did not respond within 5 minutes. Click Retry to try again.' }
  }

  // Strip the heavy extracted_json unless explicitly requested.  The listing
  // UI only needs the summary fields to render status chips.
  const includeJson = u.searchParams.get('include_json') === '1'
  const rows = (data ?? []).map(r => includeJson ? r : ({ ...r, extracted_json: null }))

  return NextResponse.json({ uploads: rows })
}

export async function DELETE(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const u  = new URL(req.url)
  const id = u.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const db = createAdminClient()

  // Only let the user delete uploads in non-applied states — once a PDF has
  // been applied to tracker_data the audit trail has to stick.
  const { data: row, error: getErr } = await db
    .from('fortnox_uploads')
    .select('id, org_id, pdf_storage_path, status')
    .eq('id', id)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (getErr || !row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (row.status === 'applied') {
    return NextResponse.json({ error: 'Applied uploads cannot be deleted — reject first' }, { status: 400 })
  }

  // Storage first, then DB row.  If storage fails we still want the DB
  // record gone so the UI isn't blocked on an orphan file.
  await db.storage.from('fortnox-pdfs').remove([row.pdf_storage_path]).catch(() => {})
  const { error: delErr } = await db.from('fortnox_uploads').delete().eq('id', id).eq('org_id', auth.orgId)
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
