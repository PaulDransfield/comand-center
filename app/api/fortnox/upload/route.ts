// app/api/fortnox/upload/route.ts
//
// Bulk PDF upload for the /overheads page.
// Accepts multiple PDFs in a single request, stores each in the private
// `fortnox-pdfs` bucket under {orgId}/{business_id}/{filename}, and creates
// one `fortnox_uploads` row per file with status='pending'. Returns the
// array of created upload IDs so the client can kick off extraction.
//
// The extraction itself happens in a separate endpoint (/api/fortnox/extract)
// so the upload request stays snappy even when the user drops five PDFs at
// once. Each extraction is per-upload and runs independently.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { rateLimit } from '@/lib/middleware/rate-limit'

export const runtime     = 'nodejs'
export const maxDuration = 60

const MAX_FILES      = 20
const MAX_FILE_BYTES = 10 * 1024 * 1024  // 10 MB — matches the bucket limit

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Per-user rate limit: 30 uploads/hour.  Each upload triggers a Claude call
  // downstream, so this caps both storage growth and AI spend.
  const gate = rateLimit(auth.userId, { windowMs: 60 * 60_000, max: 30 })
  if (!gate.allowed) {
    return NextResponse.json({ error: 'Too many uploads — try later' }, { status: 429 })
  }

  let form: FormData
  try { form = await req.formData() }
  catch { return NextResponse.json({ error: 'Invalid form data' }, { status: 400 }) }

  const businessId = String(form.get('business_id') ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const files = form.getAll('files').filter((f): f is File => f instanceof File)
  if (!files.length)          return NextResponse.json({ error: 'No files' }, { status: 400 })
  if (files.length > MAX_FILES) return NextResponse.json({ error: `Max ${MAX_FILES} files per upload` }, { status: 400 })

  // Verify business belongs to this org — otherwise users could create
  // fortnox_uploads rows against businesses they don't own.
  const db = createAdminClient()
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id')
    .eq('id', businessId)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 })

  const uploads: Array<{ id: string; filename: string; status: string; error?: string }> = []

  for (const file of files) {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (ext !== 'pdf') {
      uploads.push({ id: '', filename: file.name, status: 'failed', error: 'Only PDF files accepted' })
      continue
    }
    if (file.size > MAX_FILE_BYTES) {
      uploads.push({ id: '', filename: file.name, status: 'failed', error: 'File exceeds 10 MB limit' })
      continue
    }

    const safeName  = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    // Path layout: {org_id}/{business_id}/{timestamp}-{filename}.
    // Storage RLS uses the first folder segment (org_id) as the tenancy key.
    const storagePath = `${auth.orgId}/${businessId}/${Date.now()}-${safeName}`

    try {
      const buffer  = Buffer.from(await file.arrayBuffer())
      const { error: upErr } = await db.storage
        .from('fortnox-pdfs')
        .upload(storagePath, buffer, { contentType: 'application/pdf', upsert: false })

      if (upErr) throw upErr

      // Default doc_type to 'pnl_monthly' — the extraction endpoint refines
      // this once Claude has read the PDF (annual vs monthly P&L, invoice,
      // etc). period_year / period_month left null; filled in on extract.
      const { data: inserted, error: insErr } = await db
        .from('fortnox_uploads')
        .insert({
          org_id:           auth.orgId,
          business_id:      businessId,
          doc_type:         'pnl_monthly',
          pdf_storage_path: storagePath,
          pdf_filename:     file.name,
          pdf_size_bytes:   file.size,
          status:           'pending',
          created_by:       auth.userId,
        })
        .select('id')
        .single()

      if (insErr || !inserted) {
        // Orphan upload in storage — delete it so we don't leak.
        await db.storage.from('fortnox-pdfs').remove([storagePath]).catch(() => {})
        throw insErr ?? new Error('Insert returned no row')
      }

      uploads.push({ id: inserted.id, filename: file.name, status: 'pending' })
    } catch (e: any) {
      uploads.push({ id: '', filename: file.name, status: 'failed', error: e.message ?? 'Upload failed' })
    }
  }

  const ok     = uploads.filter(u => u.status === 'pending').length
  const failed = uploads.length - ok

  return NextResponse.json({
    uploaded: ok,
    failed,
    uploads,
  })
}
