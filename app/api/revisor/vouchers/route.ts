// app/api/revisor/vouchers/route.ts
//
// Phase R3 of REVISOR-COMPLIANCE-PLAN.md — verifikationslista data
// source. Returns every voucher in the month, flat, ready for the
// VerifikationsList UI component to render.
//
// Why separate from /api/revisor/data:
//   - Voucher fetch is slow (30-90s for a busy month via Fortnox).
//   - The main /data response should arrive fast so the page renders
//     immediately; this endpoint streams in the background and the
//     verifikationslista shows a loading state until it lands.
//
// GET /api/revisor/vouchers?business_id=X&year=YYYY&month=M
//   → JSON { vouchers: [{ series, number, date, description, rows: [{ account, debit, credit, description, account_description }] }], voucher_count, trans_count }
//
// Auth: any role that can see the business — same gate as
// /api/revisor/data + /api/revisor/sie.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { canAccessBusiness }                 from '@/lib/auth/permissions'
import { fetchVouchersForRange }             from '@/lib/fortnox/api/vouchers'
import { basAccountDescription }             from '@/lib/revisor/bas-chart'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

interface VoucherRowDto {
  account:             number
  account_description: string
  debit:               number
  credit:              number
  description:         string | null
}
interface VoucherDto {
  series:        string
  number:        number
  date:          string                   // YYYY-MM-DD
  description:   string | null
  rows:          VoucherRowDto[]
  debit_total:   number
  credit_total:  number
}

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

  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`
  const monthEnd   = (() => {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
    return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`
  })()

  let fetchResult
  try {
    fetchResult = await fetchVouchersForRange({
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

  // Filter to this exact month + sort by date / series / number
  const inMonth = fetchResult.vouchers.filter(v => {
    const d = String(v.TransactionDate ?? '').slice(0, 10)
    return d >= monthStart && d <= monthEnd
  })
  inMonth.sort((a, b) => {
    const da = String(a.TransactionDate ?? '')
    const db2 = String(b.TransactionDate ?? '')
    if (da !== db2) return da.localeCompare(db2)
    if (a.VoucherSeries !== b.VoucherSeries) return a.VoucherSeries.localeCompare(b.VoucherSeries)
    return Number(a.VoucherNumber) - Number(b.VoucherNumber)
  })

  const vouchers: VoucherDto[] = []
  let transCount = 0
  for (const v of inMonth) {
    const rows: VoucherRowDto[] = []
    let debitTotal = 0, creditTotal = 0
    for (const r of (v.VoucherRows ?? [])) {
      if (r.Removed) continue
      const debit  = Number(r.Debit)  || 0
      const credit = Number(r.Credit) || 0
      const desc   = (r.TransactionInformation ?? r.Description ?? '').trim() || null
      rows.push({
        account:             Number(r.Account),
        account_description: r.AccountDescription ?? basAccountDescription(r.Account),
        debit,
        credit,
        description:         desc,
      })
      debitTotal  += debit
      creditTotal += credit
      transCount  += 1
    }
    if (rows.length === 0) continue
    vouchers.push({
      series:       v.VoucherSeries,
      number:       Number(v.VoucherNumber),
      date:         String(v.TransactionDate ?? '').slice(0, 10),
      description:  v.Description ?? null,
      rows,
      debit_total:  debitTotal,
      credit_total: creditTotal,
    })
  }

  return NextResponse.json({
    vouchers,
    voucher_count: vouchers.length,
    trans_count:   transCount,
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}
