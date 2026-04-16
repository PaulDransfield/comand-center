// app/api/alerts/route.ts
// GET  — fetch active alerts for the org
// PATCH — mark as read or dismiss

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

const getAuth = getRequestAuth

export async function GET(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const includeRead = searchParams.get('include_read') === 'true'

  const db = createAdminClient()
  let q = db
    .from('anomaly_alerts')
    .select('*, businesses(name, city)')
    .eq('org_id', auth.orgId)
    .eq('is_dismissed', false)
    .order('created_at', { ascending: false })
    .limit(50)

  if (!includeRead) q = q.eq('is_read', false)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}

export async function PATCH(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { id, action } = await req.json()
  if (!id || !action) return NextResponse.json({ error: 'id and action required' }, { status: 400 })

  const db     = createAdminClient()
  const update = action === 'dismiss'   ? { is_dismissed: true }
               : action === 'mark_read' ? { is_read: true }
               : null

  if (!update) return NextResponse.json({ error: 'Unknown action' }, { status: 400 })

  const { error } = await db
    .from('anomaly_alerts')
    .update(update)
    .eq('id', id)
    .eq('org_id', auth.orgId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
