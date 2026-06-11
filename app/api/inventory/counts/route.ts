// app/api/inventory/counts/route.ts
//
// GET  ?business_id=… → list past counts (with totals + line counts)
// POST { business_id, count_date?, location_id?, notes? } → create header (in-progress)

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { countDuration } from '@/lib/inventory/count-duration'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const businessId = String(new URL(req.url).searchParams.get('business_id') ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  const { data, error } = await db
    .from('stock_counts')
    .select('id, count_date, location_id, notes, started_at, completed_at, active_seconds, total_value_at_count, total_lines, location:stock_locations(name)')
    .eq('business_id', businessId)
    .is('archived_at', null)
    .order('count_date', { ascending: false })
    .order('started_at', { ascending: false })
    .limit(100)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const out = (data ?? []).map((c: any) => {
    // Time to count = active counting time (preferred) or, for pre-tracking
    // counts, the created->completed wall-clock. See count-duration.ts.
    const durationSeconds = countDuration(c)
    return {
      id:                   c.id,
      count_date:           c.count_date,
      location_id:          c.location_id,
      location_name:        (c.location as any)?.name ?? null,
      notes:                c.notes,
      started_at:           c.started_at,
      completed_at:         c.completed_at,
      duration_seconds:     durationSeconds,
      total_value_at_count: c.total_value_at_count != null ? Number(c.total_value_at_count) : null,
      total_lines:          c.total_lines ?? 0,
      in_progress:          !c.completed_at,
    }
  })

  return NextResponse.json({ counts: out }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('org_id').eq('id', businessId).maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  const insertRow: any = {
    business_id: businessId,
    org_id:      biz.org_id,
    count_date:  body.count_date ? String(body.count_date) : undefined,   // default to CURRENT_DATE
    location_id: body.location_id ? String(body.location_id) : null,
    notes:       body.notes ? String(body.notes).trim() : null,
    // auth shape is { userId, orgId, ... } — there is no `.user.id`, so the
    // old `(auth as any).user?.id` was always null and no count recorded who
    // ran it. Use auth.userId so the Excel export can name the counter.
    created_by:  auth.userId ?? null,
  }
  const { data, error } = await db
    .from('stock_counts')
    .insert(insertRow)
    .select('id, count_date, location_id, notes')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, count: data })
}
