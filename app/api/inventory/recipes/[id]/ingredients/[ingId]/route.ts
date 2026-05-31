// app/api/inventory/recipes/[id]/ingredients/[ingId]/route.ts
//
// PATCH  — edit quantity / unit / notes on a single ingredient
// DELETE — remove ingredient from recipe

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: { id: string; ingId: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }

  const patch: Record<string, any> = {}
  if (body.quantity !== undefined) {
    const q = Number(body.quantity)
    if (!Number.isFinite(q) || q <= 0) return NextResponse.json({ error: 'quantity must be > 0' }, { status: 400 })
    patch.quantity = q
  }
  if (body.waste_pct !== undefined) {
    // null clears to default 0; numeric must be 0..<100 (DB CHECK + clamp belt-and-braces)
    if (body.waste_pct === null) patch.waste_pct = 0
    else {
      const w = Number(body.waste_pct)
      if (!Number.isFinite(w) || w < 0 || w >= 100) {
        return NextResponse.json({ error: 'waste_pct must be between 0 and < 100' }, { status: 400 })
      }
      patch.waste_pct = w
    }
  }
  if (body.unit !== undefined)  patch.unit  = body.unit  ? String(body.unit).trim()  : null
  if (body.notes !== undefined) patch.notes = body.notes ? String(body.notes).trim() : null
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'no editable fields supplied' }, { status: 400 })

  const db = createAdminClient()
  // Auth via recipe
  const { data: r } = await db.from('recipes').select('id, business_id').eq('id', params.id).maybeSingle()
  if (!r) return NextResponse.json({ error: 'recipe not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, r.business_id)
  if (forbidden) return forbidden

  const { data, error } = await db
    .from('recipe_ingredients')
    .update(patch)
    .eq('id', params.ingId)
    .eq('recipe_id', params.id)   // defence: don't let a request edit another recipe's ingredient
    .select('id, product_id, subrecipe_id, quantity, waste_pct, unit, notes, position')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, ingredient: data }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string; ingId: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: r } = await db.from('recipes').select('id, business_id').eq('id', params.id).maybeSingle()
  if (!r) return NextResponse.json({ error: 'recipe not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, r.business_id)
  if (forbidden) return forbidden

  const { error } = await db
    .from('recipe_ingredients')
    .delete()
    .eq('id', params.ingId)
    .eq('recipe_id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}
