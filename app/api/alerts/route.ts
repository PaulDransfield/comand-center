// app/api/alerts/route.ts
// GET   — fetch active alerts for the org
// PATCH — mark as read, dismiss, confirm (real anomaly), or reject (false alarm)
//
// confirm/reject — added 2026-05-09 for Piece 0 of the prediction system v3.1.
// "Confirmed" alerts mean the operator validated this was a real one-off
// event; the prediction system's reconciler in Piece 1 will exclude that
// day's actuals from baseline computations to keep its averages from
// being polluted by extreme but real days. "Rejected" means the operator
// classified the alert as a false alarm; the day stays in baselines.
// See PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md Appendix Z (Stream D).

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

const getAuth = getRequestAuth

export async function GET(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const includeRead          = searchParams.get('include_read') === 'true'
  const confirmationFilter   = searchParams.get('confirmation_status')  // 'pending' | 'confirmed' | 'rejected' | 'auto_resolved' | null

  const db = createAdminClient()
  let q = db
    .from('anomaly_alerts')
    .select('*, businesses(name, city)')
    .eq('org_id', auth.orgId)
    .eq('is_dismissed', false)
    .order('created_at', { ascending: false })
    .limit(50)

  if (!includeRead) q = q.eq('is_read', false)
  if (confirmationFilter && confirmationFilter !== 'all') {
    q = q.eq('confirmation_status', confirmationFilter)
  }

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  // FIXES §0bb (Sprint 1.5) — bounded SWR; PATCH route below is uncached.
  return NextResponse.json(data ?? [], {
    headers: { 'Cache-Control': 'private, max-age=15, stale-while-revalidate=60' },
  })
}

export async function PATCH(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json()
  const { id, action, notes } = body ?? {}
  if (!id || !action) return NextResponse.json({ error: 'id and action required' }, { status: 400 })

  const db = createAdminClient()
  let update: Record<string, any> | null = null

  if (action === 'dismiss')   update = { is_dismissed: true }
  if (action === 'mark_read') update = { is_read: true }
  if (action === 'confirm' || action === 'reject') {
    update = {
      confirmation_status: action === 'confirm' ? 'confirmed' : 'rejected',
      confirmed_at:        new Date().toISOString(),
      confirmed_by:        auth.userId,
      confirmation_notes:  typeof notes === 'string' && notes.trim().length > 0 ? notes.trim().slice(0, 500) : null,
    }
  }

  if (!update) return NextResponse.json({ error: 'Unknown action' }, { status: 400 })

  const { error } = await db
    .from('anomaly_alerts')
    .update(update)
    .eq('id', id)
    .eq('org_id', auth.orgId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
