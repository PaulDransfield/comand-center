// app/api/inventory/recipes/[id]/route.ts
//
// GET    — recipe detail with ingredients + per-line cost
// PATCH  — update header (name / type / menu_price / portions / notes)
// DELETE — soft-delete (archived_at = now); ingredients stay so undo is possible

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { computeRecipeCost, getProductLatestPrices, type IngredientForCosting } from '@/lib/inventory/recipe-cost'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: r, error: rErr } = await db
    .from('recipes')
    .select('id, business_id, name, type, menu_price, portions, notes, updated_at')
    .eq('id', params.id)
    .maybeSingle()
  if (rErr)  return NextResponse.json({ error: rErr.message }, { status: 500 })
  if (!r)    return NextResponse.json({ error: 'recipe not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, r.business_id)
  if (forbidden) return forbidden

  const { data: rawIngs, error: iErr } = await db
    .from('recipe_ingredients')
    .select('id, product_id, quantity, unit, notes, position, products!inner(name, category)')
    .eq('recipe_id', r.id)
    .order('position')
  if (iErr) return NextResponse.json({ error: `ingredients lookup: ${iErr.message}` }, { status: 500 })

  const ings: IngredientForCosting[] = (rawIngs ?? []).map((i: any) => ({
    id:           i.id,
    product_id:   i.product_id,
    product_name: i.products?.name ?? '?',
    category:     i.products?.category ?? null,
    quantity:     Number(i.quantity),
    unit:         i.unit,
    notes:        i.notes,
    position:     i.position,
  }))

  const productIds = ings.map(i => i.product_id)
  const priceMap   = await getProductLatestPrices(db, r.business_id, productIds)
  const summary    = computeRecipeCost(ings, priceMap, r.menu_price != null ? Number(r.menu_price) : null)

  return NextResponse.json({
    recipe: {
      ...r,
      menu_price: r.menu_price != null ? Number(r.menu_price) : null,
    },
    summary,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }

  const patch: Record<string, any> = {}
  if (typeof body.name === 'string') {
    const v = body.name.trim()
    if (!v) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    if (v.length > 200) return NextResponse.json({ error: 'name too long (max 200)' }, { status: 400 })
    patch.name = v
  }
  if (body.type !== undefined)       patch.type       = body.type ? String(body.type).trim() : null
  if (body.notes !== undefined)      patch.notes      = body.notes ? String(body.notes).trim() : null
  if (body.menu_price !== undefined) {
    if (body.menu_price === null) patch.menu_price = null
    else {
      const mp = Number(body.menu_price)
      if (!Number.isFinite(mp) || mp < 0) return NextResponse.json({ error: 'menu_price must be a non-negative number' }, { status: 400 })
      patch.menu_price = mp
    }
  }
  if (body.portions !== undefined) {
    const pt = Math.max(1, Math.floor(Number(body.portions)))
    if (!Number.isFinite(pt)) return NextResponse.json({ error: 'portions must be a positive integer' }, { status: 400 })
    patch.portions = pt
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no editable fields supplied' }, { status: 400 })
  }

  const db = createAdminClient()
  const { data: existing } = await db
    .from('recipes')
    .select('id, business_id')
    .eq('id', params.id)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'recipe not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, existing.business_id)
  if (forbidden) return forbidden

  const { data, error } = await db
    .from('recipes')
    .update(patch)
    .eq('id', params.id)
    .select('id, name, type, menu_price, portions, notes, updated_at')
    .single()
  if (error) {
    if ((error as any).code === '23505') {
      return NextResponse.json({ error: `A recipe called "${patch.name}" already exists.` }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, recipe: data }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: r } = await db
    .from('recipes')
    .select('id, business_id')
    .eq('id', params.id)
    .maybeSingle()
  if (!r) return NextResponse.json({ error: 'recipe not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, r.business_id)
  if (forbidden) return forbidden

  const { error } = await db
    .from('recipes')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}
