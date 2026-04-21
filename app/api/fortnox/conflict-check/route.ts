// app/api/fortnox/conflict-check/route.ts
//
// Returns the existing tracker_data row (if any) for a candidate apply, so
// the review modal can show a diff between manual data and the Fortnox
// extraction BEFORE the user commits.
//
// Silent overwrite was the risk: /api/fortnox/apply upserts on the
// (org,biz,year,month) unique index, and the old manual entry just
// disappears.  The audit row (fortnox_upload_id) is fine for forensics but
// the owner doesn't see it.  This endpoint closes that gap.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const uploadId = new URL(req.url).searchParams.get('upload_id')
  if (!uploadId) return NextResponse.json({ error: 'upload_id required' }, { status: 400 })

  const db = createAdminClient()

  const { data: upload } = await db
    .from('fortnox_uploads')
    .select('business_id, doc_type, period_year, period_month')
    .eq('id', uploadId)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (!upload) return NextResponse.json({ error: 'Upload not found' }, { status: 404 })

  // Annual docs don't hit tracker_data monthly rows — no conflict possible.
  if (upload.doc_type === 'pnl_annual' || !upload.period_month) {
    return NextResponse.json({ existing: null, has_conflict: false })
  }

  const { data: existing } = await db
    .from('tracker_data')
    .select('id, revenue, food_cost, staff_cost, other_cost, rent_cost, net_profit, margin_pct, source, fortnox_upload_id, updated_at')
    .eq('org_id', auth.orgId)
    .eq('business_id', upload.business_id)
    .eq('period_year', upload.period_year)
    .eq('period_month', upload.period_month)
    .maybeSingle()

  if (!existing) return NextResponse.json({ existing: null, has_conflict: false })

  // Re-apply of the same Fortnox PDF is not a "conflict" worth flagging —
  // it's idempotent overwrite.  Only flag when the existing row came from
  // a different source OR from a different upload.
  const has_conflict =
    existing.source !== 'fortnox_pdf' ||
    (existing.fortnox_upload_id && existing.fortnox_upload_id !== uploadId)

  return NextResponse.json({
    existing,
    has_conflict,
    existing_source: existing.source,
  })
}
