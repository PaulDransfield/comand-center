// app/api/inventory/menus/[id]/items/[item_id]/route.ts
//
// PATCH  — update qty / position / note for a course.
// DELETE — remove a course.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: { id: string; item_id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: menu } = await db.from('menus').select('business_id').eq('id', params.id).maybeSingle()
  if (!menu) return NextResponse.json({ error: 'menu not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, menu.business_id)
  if (forbidden) return forbidden

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  const patch: Record<string, any> = {}
  if (body.qty !== undefined) {
    const v = Number(body.qty)
    if (!Number.isFinite(v) || v <= 0) return NextResponse.json({ error: 'qty must be > 0' }, { status: 400 })
    patch.qty = v
  }
  if (body.course_position !== undefined) {
    const v = Number(body.course_position)
    if (!Number.isFinite(v) || v < 0) return NextResponse.json({ error: 'course_position must be >= 0' }, { status: 400 })
    patch.course_position = Math.floor(v)
  }
  if (body.note !== undefined) {
    if (body.note === null || body.note === '') patch.note = null
    else {
      const n = String(body.note)
      if (n.length > 500) return NextResponse.json({ error: 'note max 500 chars' }, { status: 400 })
      patch.note = n
    }
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'no fields to patch' }, { status: 400 })

  const { error } = await db.from('menu_items')
    .update(patch).eq('id', params.item_id).eq('menu_id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string; item_id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: menu } = await db.from('menus').select('business_id').eq('id', params.id).maybeSingle()
  if (!menu) return NextResponse.json({ error: 'menu not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, menu.business_id)
  if (forbidden) return forbidden

  const { error } = await db.from('menu_items').delete()
    .eq('id', params.item_id).eq('menu_id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
