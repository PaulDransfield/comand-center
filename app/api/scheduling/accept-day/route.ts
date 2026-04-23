// app/api/scheduling/accept-day/route.ts
//
// POST single-day accept of an AI schedule recommendation.
//
// Body: {
//   business_id:    string (uuid)
//   date:           'YYYY-MM-DD'
//   ai_hours:       number
//   ai_cost_kr:     number
//   current_hours:  number
//   current_cost_kr:number
//   est_revenue_kr?:number
// }

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { unstable_noStore } from 'next/cache'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const preferredRegion = 'fra1'

export async function POST(req: NextRequest) {
  unstable_noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({} as any))
  const { business_id, date, ai_hours, ai_cost_kr, current_hours, current_cost_kr, est_revenue_kr } = body ?? {}
  if (!business_id || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
    return NextResponse.json({ error: 'business_id + YYYY-MM-DD date required' }, { status: 400 })
  }

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('id, org_id').eq('id', business_id).maybeSingle()
  if (!biz || biz.org_id !== auth.orgId) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { data, error } = await db.from('schedule_acceptances').upsert({
    org_id:          biz.org_id,
    business_id:     biz.id,
    date,
    ai_hours:        Number(ai_hours ?? 0),
    ai_cost_kr:      Number(ai_cost_kr ?? 0),
    current_hours:   Number(current_hours ?? 0),
    current_cost_kr: Number(current_cost_kr ?? 0),
    est_revenue_kr:  est_revenue_kr != null ? Number(est_revenue_kr) : null,
    decided_by:      auth.userId,
    decided_at:      new Date().toISOString(),
    batch_id:        null,
  }, { onConflict: 'business_id,date' }).select('id, date').maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, id: data?.id, date: data?.date }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}

export async function DELETE(req: NextRequest) {
  unstable_noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const u = new URL(req.url)
  const business_id = u.searchParams.get('business_id')
  const date        = u.searchParams.get('date')
  if (!business_id || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
    return NextResponse.json({ error: 'business_id + date required' }, { status: 400 })
  }

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('id, org_id').eq('id', business_id).maybeSingle()
  if (!biz || biz.org_id !== auth.orgId) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { error } = await db.from('schedule_acceptances').delete()
    .eq('business_id', biz.id).eq('date', date!)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}
