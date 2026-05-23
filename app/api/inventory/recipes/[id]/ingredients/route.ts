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

  const row = {
    recipe_id:    params.id,
    product_id:   productId,
    subrecipe_id: subrecipeId,
    quantity,
    unit:         unit ?? defaultUnit,
    notes,
    position:     nextPos,
  }
  // Upserts target the matching partial unique index. Both indexes are
  // single-column (recipe_id + the one non-null id field) so the right
  // onConflict spec depends on which path we're on.
  const onConflict = productId ? 'recipe_id,product_id' : 'recipe_id,subrecipe_id'
  const { data, error } = await db
    .from('recipe_ingredients')
    .upsert(row, { onConflict })
    .select('id, product_id, subrecipe_id, quantity, unit, notes, position')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, ingredient: data }, { headers: { 'Cache-Control': 'no-store' } })
}
