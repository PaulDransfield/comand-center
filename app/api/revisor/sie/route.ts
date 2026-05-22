// app/api/revisor/sie/route.ts
//
// SIE 4 download endpoint. Phase R2 of REVISOR-COMPLIANCE-PLAN.md.
//
// GET /api/revisor/sie?business_id=X&year=YYYY&month=M
//   → application/x-sie; charset=ISO-8859-1
//   → Content-Disposition: attachment; filename="ORGNR_PERIOD.se"
//
// Auth: any role that can see the business (owner/manager/viewer/
//       revisor). Same gate as /api/revisor/data.
//
// Flow:
//   1. Validate inputs
//   2. Load business header (legal_name, org_number, legal_city, etc.)
//   3. Fetch Fortnox vouchers for the period via fetchVouchersForRange
//   4. Generate the SIE 4 file content (pure compute in
//      lib/revisor/sie-export.ts)
//   5. Stream bytes back with correct headers

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { canAccessBusiness }                 from '@/lib/auth/permissions'
import { getCachedVouchersForRange }         from '@/lib/fortnox/voucher-cache'
import { generateSie4 }                      from '@/lib/revisor/sie-export'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
// Voucher fetch can take 30-60s for a busy month — sit comfortably
// inside Vercel Pro's 800s function cap.
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

  // ── Load business header ─────────────────────────────────────────
  const { data: biz, error: bizErr } = await db
    .from('businesses')
    .select('id, org_id, name, legal_name, city, legal_city, country, org_number')
    .eq('id', bizId)
    .maybeSingle()
  if (bizErr) return NextResponse.json({ error: bizErr.message }, { status: 500 })
  if (!biz)   return NextResponse.json({ error: 'Business not found' }, { status: 404 })
  if (!biz.org_number) {
    return NextResponse.json({
      error:   'org_number_missing',
      message: 'Org.nr saknas — kör Sync identity från admin-verktygen först.',
    }, { status: 400 })
  }

  // ── Fetch Fortnox vouchers for the period ────────────────────────
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`
  const monthEnd   = (() => {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
    return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`
  })()

  let voucherFetch
  try {
    voucherFetch = await getCachedVouchersForRange({
      db,
      orgId:      biz.org_id,
      businessId: bizId,
      fromDate:   monthStart,
      toDate:     monthEnd,
    })
  } catch (e: any) {
    return NextResponse.json({
      error:   'fortnox_voucher_fetch_failed',
      message: String(e?.message ?? e),
    }, { status: 502 })
  }

  // ── Generate SIE 4 ───────────────────────────────────────────────
  const legalName = (biz.legal_name?.trim() || biz.name) as string
  const legalCity = (biz.legal_city?.trim() || biz.city) ?? null

  const result = generateSie4({
    business: {
      organisation_number: biz.org_number,
      legal_name:          legalName,
      address:             null,                          // not yet captured in our schema
      postal_code:         null,
      city:                legalCity,
      country:             biz.country ?? null,
    },
    period_year:  year,
    period_month: month,
    vouchers:     voucherFetch.vouchers,
    generated_by: auth.userId,
  })

  // ── Stream back ──────────────────────────────────────────────────
  return new NextResponse(result.bytes as any, {
    status: 200,
    headers: {
      'Content-Type':        'application/x-sie; charset=ISO-8859-1',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Content-Length':       String(result.bytes.length),
      // Best-effort surfacing of warnings so the caller can show
      // the owner if vouchers didn't balance (rare; Fortnox should
      // always emit balanced vouchers).
      'X-Sie-Voucher-Count':  String(result.voucher_count),
      'X-Sie-Trans-Count':    String(result.trans_count),
      'X-Sie-Unbalanced':     String(result.unbalanced_vouchers.length),
      'X-Sie-Warnings':       result.warnings.join(' · '),
      'Cache-Control':        'no-store, max-age=0, must-revalidate',
    },
  })
}
