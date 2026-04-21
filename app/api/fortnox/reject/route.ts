// app/api/fortnox/reject/route.ts
// Flip a fortnox_upload to status='rejected' and keep the PDF in storage
// so the audit trail survives.  If the upload had already been applied,
// we also roll back the tracker_data + line_items for that period.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { upload_id } = await req.json().catch(() => ({} as any))
  if (!upload_id) return NextResponse.json({ error: 'upload_id required' }, { status: 400 })

  const db = createAdminClient()

  const { data: upload, error: getErr } = await db
    .from('fortnox_uploads')
    .select('id, org_id, business_id, period_year, period_month, status, doc_type')
    .eq('id', upload_id)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (getErr || !upload) return NextResponse.json({ error: 'Upload not found' }, { status: 404 })

  // If it was applied, unwind the data: drop line items for that period,
  // reset the tracker_data row if it came from this upload.
  if (upload.status === 'applied') {
    const monthKey = upload.doc_type === 'pnl_annual' ? 0 : upload.period_month
    await db.from('tracker_line_items')
      .delete()
      .eq('business_id', upload.business_id)
      .eq('period_year', upload.period_year)
      .eq('period_month', monthKey)
      .eq('source_upload_id', upload.id)

    // Only clear the tracker_data row if it actually came from this upload.
    // Prior manual entries stay untouched.
    if (upload.doc_type !== 'pnl_annual' && upload.period_month) {
      await db.from('tracker_data')
        .update({ source: 'manual', fortnox_upload_id: null, other_cost: 0 })
        .eq('fortnox_upload_id', upload.id)
    }
  }

  await db.from('fortnox_uploads').update({
    status: 'rejected',
    applied_at: null,
  }).eq('id', upload.id)

  return NextResponse.json({ ok: true })
}
