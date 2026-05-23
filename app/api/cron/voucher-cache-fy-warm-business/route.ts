// app/api/cron/voucher-cache-fy-warm-business/route.ts
//
// Single-business pre-warm for the M080 Fortnox voucher cache. Invoked
// from the Fortnox OAuth callback the moment a customer connects, so
// the first /revisor balance sheet load is instant. Also callable as
// an admin tool for individual businesses (e.g. when a previously
// connected customer's cache went stale).
//
// POST /api/cron/voucher-cache-fy-warm-business
//   Body: { business_id, refresh_all?: boolean }
// Auth: CRON_SECRET or ADMIN_SECRET as Bearer.
//
// Wall-clock cap 600 s (the maxDuration). On-connect runs are typically
// 2-10 min for a fully cold customer; budget covers it with headroom.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { warmFiscalYearMissing } from '@/lib/fortnox/voucher-cache-fy-warm'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 600

export async function POST(req: NextRequest) {
  noStore()

  const cronSecret  = process.env.CRON_SECRET
  const adminSecret = process.env.ADMIN_SECRET
  const auth = req.headers.get('authorization') ?? ''
  if (!(cronSecret && auth === `Bearer ${cronSecret}`) &&
      !(adminSecret && auth === `Bearer ${adminSecret}`)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  const refreshAll = body.refresh_all === true
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id, name')
    .eq('id', businessId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  try {
    const result = await warmFiscalYearMissing({
      db,
      orgId:      biz.org_id,
      businessId,
      budgetMs:   550_000,                                // leave 50 s slack under maxDuration
      refreshAll,
      log:        (msg, fields) => console.log(JSON.stringify({ at: msg, ...fields })),
    })
    return NextResponse.json({
      business: biz.name,
      ...result,
    }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
  } catch (e: any) {
    return NextResponse.json({
      error:   'warm_failed',
      message: String(e?.message ?? e),
    }, { status: 502 })
  }
}
