// app/api/scheduling/accept-all/route.ts
//
// Bulk accept for the whole visible schedule range.
//
// Body: {
//   business_id: string
//   from:        'YYYY-MM-DD'
//   to:          'YYYY-MM-DD'
//   rows: [{ date, ai_hours, ai_cost_kr, current_hours, current_cost_kr, est_revenue_kr? }]
// }
//
// All rows in the body are accepted with the same batch_id. DELETE with the
// same body accepts-then-undoes (used for the 10-second "Undo all" window).

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { unstable_noStore } from 'next/cache'
import { randomUUID } from 'node:crypto'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const preferredRegion = 'fra1'

export async function POST(req: NextRequest) {
  unstable_noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({} as any))
  const { business_id, rows } = body ?? {}
  if (!business_id || !Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'business_id + non-empty rows[] required' }, { status: 400 })
  }

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('id, org_id').eq('id', business_id).maybeSingle()
  if (!biz || biz.org_id !== auth.orgId) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const batchId = randomUUID()
  const nowIso  = new Date().toISOString()
  const upsertRows = rows
    .filter((r: any) => r?.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date))
    .map((r: any) => ({
      org_id:          biz.org_id,
      business_id:     biz.id,
      date:            r.date,
      ai_hours:        Number(r.ai_hours ?? 0),
      ai_cost_kr:      Number(r.ai_cost_kr ?? 0),
      current_hours:   Number(r.current_hours ?? 0),
      current_cost_kr: Number(r.current_cost_kr ?? 0),
      est_revenue_kr:  r.est_revenue_kr != null ? Number(r.est_revenue_kr) : null,
      decided_by:      auth.userId,
      decided_at:      nowIso,
      batch_id:        batchId,
    }))

  if (upsertRows.length === 0) {
    return NextResponse.json({ error: 'no valid rows in body' }, { status: 400 })
  }

  const { error } = await db.from('schedule_acceptances')
    .upsert(upsertRows, { onConflict: 'business_id,date' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, batch_id: batchId, accepted: upsertRows.length }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}

// Undo the most recent batch, OR a specific batch_id if provided.
export async function DELETE(req: NextRequest) {
  unstable_noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const u = new URL(req.url)
  const business_id = u.searchParams.get('business_id')
  const batch_id    = u.searchParams.get('batch_id')
  if (!business_id || !batch_id) {
    return NextResponse.json({ error: 'business_id + batch_id required' }, { status: 400 })
  }

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('id, org_id').eq('id', business_id).maybeSingle()
  if (!biz || biz.org_id !== auth.orgId) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { error, count } = await db.from('schedule_acceptances').delete({ count: 'exact' })
    .eq('business_id', biz.id).eq('batch_id', batch_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, undone: count ?? 0 }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}
