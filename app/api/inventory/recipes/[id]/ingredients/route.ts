// app/api/inventory/recipes/[id]/ingredients/route.ts
//
// POST — add an ingredient to a recipe. Accepts EITHER a product OR a
//        sub-recipe (mutually exclusive per DB CHECK).
//
// Body: { product_id?, subrecipe_id?, quantity, unit?, notes? }
//
// Cycle prevention: if subrecipe_id transitively contains the parent
// recipe id, returns 409 with a useful message.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { loadRecipeIndex, wouldCreateCycle } from '@/lib/inventory/recipe-cost'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const productId    = body.product_id    ? String(body.product_id).trim()    : null
  const subrecipeId  = body.subrecipe_id  ? String(body.subrecipe_id).trim()  : null
  const quantity     = Number(body.quantity ?? 0)
  const unit         = body.unit  ? String(body.unit).trim()  : null
  const notes        = body.notes ? String(body.notes).trim() : null
  // Per-line waste %. CHECK constraint enforces 0..<100 at the DB; clamp
  // defensively here too. Default 0 = no-op (no yield-loss inflation).
  const wastePctRaw  = body.waste_pct
  let wastePct       = 0
  if (wastePctRaw !== undefined && wastePctRaw !== null) {
    const w = Number(wastePctRaw)
    if (!Number.isFinite(w) || w < 0 || w >= 100) {
      return NextResponse.json({ error: 'waste_pct must be between 0 and < 100' }, { status: 400 })
    }
    wastePct = w
  }

  if ((!productId && !subrecipeId) || (productId && subrecipeId)) {
    return NextResponse.json({ error: 'exactly one of product_id or subrecipe_id required' }, { status: 400 })
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return NextResponse.json({ error: 'quantity must be > 0' }, { status: 400 })
  }

  const db = createAdminClient()

  // Auth + business check via recipe
  const { data: recipe } = await db
    .from('recipes')
    .select('id, business_id')
    .eq('id', params.id)
    .maybeSingle()
  if (!recipe) return NextResponse.json({ error: 'recipe not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, recipe.business_id)
  if (forbidden) return forbidden

  let defaultUnit: string | null = null

  if (productId) {
    const { data: product } = await db
      .from('products')
      .select('id, business_id, name, invoice_unit')
      .eq('id', productId)
      .maybeSingle()
    if (!product) return NextResponse.json({ error: 'product not found' }, { status: 404 })
    if (product.business_id !== recipe.business_id) {
      return NextResponse.json({ error: 'product belongs to a different business' }, { status: 403 })
    }
    defaultUnit = product.invoice_unit
  } else {
    // subrecipeId — verify same business + no cycle
    if (subrecipeId === params.id) {
      return NextResponse.json({ error: 'A recipe cannot include itself.' }, { status: 409 })
    }
    const { data: sub } = await db
      .from('recipes')
      .select('id, business_id, name')
      .eq('id', subrecipeId!)
      .maybeSingle()
    if (!sub) return NextResponse.json({ error: 'sub-recipe not found' }, { status: 404 })
    if (sub.business_id !== recipe.business_id) {
      return NextResponse.json({ error: 'sub-recipe belongs to a different business' }, { status: 403 })
    }
    const idx = await loadRecipeIndex(db, recipe.business_id)
    if (wouldCreateCycle(params.id, subrecipeId!, idx)) {
      return NextResponse.json({
        error: `Cannot add "${sub.name}" — it would create a recipe cycle (this recipe is already used inside it, directly or transitively).`,
      }, { status: 409 })
    }
    defaultUnit = 'portion'
  }

  // Position = last + 1
  const { data: last } = await db
    .from('recipe_ingredients')
    .select('position')
    .eq('recipe_id', params.id)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()
  const nextPos = ((last as any)?.position ?? -1) + 1

  // SELECT-then-INSERT-or-UPDATE.
  //
  // We can't .upsert({ onConflict: 'recipe_id,product_id' }) because
  // after M086 BOTH unique indexes on recipe_ingredients are PARTIAL
  // (WHERE product_id IS NOT NULL / WHERE subrecipe_id IS NOT NULL),
  // and PostgREST rejects partial indexes as ON CONFLICT targets even
  // on a row that wouldn't conflict. Same class as the product_aliases
  // matcher bug — partial uniques still enforce dedup at the DB layer,
  // we just drive them via select + insert.

  const existingQuery = productId
    ? db.from('recipe_ingredients')
        .select('id')
        .eq('recipe_id', params.id)
        .eq('product_id', productId)
        .is('subrecipe_id', null)
        .maybeSingle()
    : db.from('recipe_ingredients')
        .select('id')
        .eq('recipe_id', params.id)
        .eq('subrecipe_id', subrecipeId!)
        .is('product_id', null)
        .maybeSingle()

  const { data: existing } = await existingQuery

  const row = {
    recipe_id:    params.id,
    product_id:   productId,
    subrecipe_id: subrecipeId,
    quantity,
    waste_pct:    wastePct,
    unit:         unit ?? defaultUnit,
    notes,
    position:     nextPos,
  }

  let data: any
  if (existing?.id) {
    // Update existing row — quantity/waste_pct/unit/notes overwrite; position keeps its slot.
    const { data: upd, error } = await db
      .from('recipe_ingredients')
      .update({ quantity, waste_pct: wastePct, unit: unit ?? defaultUnit, notes })
      .eq('id', existing.id)
      .select('id, product_id, subrecipe_id, quantity, waste_pct, unit, notes, position')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    data = upd
  } else {
    const { data: ins, error } = await db
      .from('recipe_ingredients')
      .insert(row)
      .select('id, product_id, subrecipe_id, quantity, waste_pct, unit, notes, position')
      .single()
    if (error) {
      // 23505 = race lost vs concurrent insert. Re-SELECT then UPDATE.
      if ((error as any).code === '23505') {
        const { data: winner } = await existingQuery
        if (winner?.id) {
          const { data: upd, error: uErr } = await db
            .from('recipe_ingredients')
            .update({ quantity, waste_pct: wastePct, unit: unit ?? defaultUnit, notes })
            .eq('id', winner.id)
            .select('id, product_id, subrecipe_id, quantity, waste_pct, unit, notes, position')
            .single()
          if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })
          data = upd
        } else {
          return NextResponse.json({ error: error.message }, { status: 500 })
        }
      } else {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
    } else {
      data = ins
    }
  }

  return NextResponse.json({ ok: true, ingredient: data }, { headers: { 'Cache-Control': 'no-store' } })
}
