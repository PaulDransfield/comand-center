// app/api/admin/voucher-cache/warm/route.ts
//
// Admin force-warm for the M080 Fortnox voucher cache. Takes an explicit
// (business_id, from_date, to_date) and refreshes that range — used for
// broken-fiscal-year customers where the daily cron's current+previous
// month sweep doesn't reach the FY start.
//
// Auth: requires ADMIN_SECRET as Bearer OR a logged-in admin user.
//
// POST /api/admin/voucher-cache/warm
//   Body: { business_id, from_date, to_date }
//   Returns: { cached_count, fortnox_calls, duration_ms, fetched_at }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { getCachedVouchersForRange } from '@/lib/fortnox/voucher-cache'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 800

export async function POST(req: NextRequest) {
  noStore()

  const adminSecret = process.env.ADMIN_SECRET
  const cronSecret  = process.env.CRON_SECRET
  const auth = req.headers.get('authorization') ?? ''
  const okAdmin = adminSecret && auth === `Bearer ${adminSecret}`
  const okCron  = cronSecret  && auth === `Bearer ${cronSecret}`
  if (!okAdmin && !okCron) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: any
  try { body = await req.json() } catch { body = {} }
  const bizId    = String(body.business_id ?? '').trim()
  const fromDate = String(body.from_date   ?? '').trim()
  const toDate   = String(body.to_date     ?? '').trim()

  if (!bizId)    return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) return NextResponse.json({ error: 'from_date YYYY-MM-DD required' }, { status: 400 })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate))   return NextResponse.json({ error: 'to_date YYYY-MM-DD required' },   { status: 400 })

  const db = createAdminClient()
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id, name')
    .eq('id', bizId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  const started = Date.now()
  try {
    const result = await getCachedVouchersForRange({
      db,
      orgId:           biz.org_id,
      businessId:      bizId,
      fromDate,
      toDate,
      refreshCurrent:  true,
    })
    return NextResponse.json({
      ok:             true,
      business:       biz.name,
      from_date:      fromDate,
      to_date:        toDate,
      cached_count:   result.vouchers.length,
      duration_ms:    Date.now() - started,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json({
      error:   'warm_failed',
      message: String(e?.message ?? e),
    }, { status: 502 })
  }
}
