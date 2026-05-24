// app/api/inventory/pos-menu-items/[id]/route.ts
//
// PATCH { recipe_id?, name?, price_inc_vat? } → update a menu item
// DELETE                                      → archive (soft delete)

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }

  const db = createAdminClient()
  const { data: item } = await db
    .from('pos_menu_items')
    .select('id, business_id')
    .eq('id', params.id)
    .maybeSingle()
  if (!item) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, item.business_id)
  if (forbidden) return forbidden

  const patch: Record<string, any> = {}
  if (body.name        !== undefined) patch.name          = String(body.name).trim()
  if (body.recipe_id   !== undefined) patch.recipe_id     = body.recipe_id ? String(body.recipe_id).trim() : null
  if (body.price_inc_vat !== undefined) patch.price_inc_vat = body.price_inc_vat == null ? null : Number(body.price_inc_vat)
  if (Object.keys(patch).length === 0) return NextResponse.json({ ok: true, noop: true })

  const { data, error } = await db
    .from('pos_menu_items')
    .update(patch)
    .eq('id', params.id)
    .select('id, name, recipe_id, price_inc_vat')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, item: data })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: item } = await db
    .from('pos_menu_items')
    .select('id, business_id')
    .eq('id', params.id)
    .maybeSingle()
  if (!item) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, item.business_id)
  if (forbidden) return forbidden

  // Soft-delete; preserves historical pos_sales linkage for variance
  // back-reporting on archived items.
  const { error } = await db
    .from('pos_menu_items')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
