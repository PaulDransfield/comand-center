// app/api/revisor/momsrapport/route.ts
//
// R5 — Momsrapport (Skatteverket SKV 4700 VAT report).
// Returns the structured VAT report for a (business, year, month).
// Computed on demand from the M080 voucher cache (instant after the
// verifikationslista has been viewed once).
//
// GET /api/revisor/momsrapport?business_id=X&year=YYYY&month=M
//   → JSON MomsrapportResult (see lib/revisor/momsrapport.ts)

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { canAccessBusiness }                 from '@/lib/auth/permissions'
import { computeMomsrapport }                from '@/lib/revisor/momsrapport'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  noStore()

  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const subject = {
    role:              auth.role as any,
    business_ids:      (auth as any).businessIds ?? null,
    can_view_finances: true,
  }

  const url   = new URL(req.url)
  const bizId = (url.searchParams.get('business_id') ?? '').trim()
  const year  = parseInt(url.searchParams.get('year')  ?? '', 10)
  const month = parseInt(url.searchParams.get('month') ?? '', 10)

  if (!bizId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: 'year + month required (year=YYYY, month=1-12)' }, { status: 400 })
  }
  if (!canAccessBusiness(subject, bizId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const db = createAdminClient()
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id')
    .eq('id', bizId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 })

  let result
  try {
    result = await computeMomsrapport(db, biz.org_id, bizId, year, month)
  } catch (e: any) {
    return NextResponse.json({
      error:   'momsrapport_compute_failed',
      message: String(e?.message ?? e),
    }, { status: 502 })
  }

  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}
