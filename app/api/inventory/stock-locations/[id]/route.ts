// app/api/inventory/stock-locations/[id]/route.ts
//
// PATCH  { name?, sort_order? } — rename / reorder
// DELETE — soft-archive (counts referencing it keep working)

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function loadAndAuth(req: NextRequest, id: string) {
  const auth = await getRequestAuth(req)
  if (!auth) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const db = createAdminClient()
  const { data: loc } = await db.from('stock_locations').select('id, business_id').eq('id', id).maybeSingle()
  if (!loc) return { error: NextResponse.json({ error: 'location not found' }, { status: 404 }) }
  const forbidden = requireBusinessAccess(auth, loc.business_id)
  if (forbidden) return { error: forbidden }
  return { db, loc }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const r = await loadAndAuth(req, params.id)
  if ('error' in r) return r.error
  const { db } = r

  let body: any
  try { body = await req.json() } catch { body = {} }
  const patch: any = {}
  if (typeof body.name === 'string') {
    const v = body.name.trim()
    if (!v) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    patch.name = v
  }
  if (typeof body.sort_order === 'number') patch.sort_order = body.sort_order
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'no editable fields' }, { status: 400 })

  const { data, error } = await db
    .from('stock_locations')
    .update(patch)
    .eq('id', params.id)
    .select('id, name, sort_order')
    .single()
  if (error) {
    if ((error as any).code === '23505') return NextResponse.json({ error: 'name already in use' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, location: data })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const r = await loadAndAuth(req, params.id)
  if ('error' in r) return r.error
  const { db } = r
  const { error } = await db
    .from('stock_locations')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
