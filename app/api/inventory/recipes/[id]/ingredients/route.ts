// app/api/inventory/recipes/[id]/ingredients/route.ts
//
// POST — add an ingredient (product_id + quantity + unit) to a recipe.
//
// Body: { product_id, quantity, unit?, notes? }
//
// UNIQUE(recipe_id, product_id) means re-POSTing the same product UPDATEs
// the existing row (sum-quantity? no — overwrite, owner expectation).
// Use PATCH on the specific ingredient id if you want to bump quantity
// instead of overwrite.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const productId = String(body.product_id ?? '').trim()
  const quantity  = Number(body.quantity ?? 0)
  const unit      = body.unit  ? String(body.unit).trim()  : null
  const notes     = body.notes ? String(body.notes).trim() : null
  if (!productId) return NextResponse.json({ error: 'product_id required' }, { status: 400 })
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

  // Verify the product belongs to the same business (defence in depth)
  const { data: product } = await db
    .from('products')
    .select('id, business_id, name, invoice_unit')
    .eq('id', productId)
    .maybeSingle()
  if (!product)                            return NextResponse.json({ error: 'product not found' }, { status: 404 })
  if (product.business_id !== recipe.business_id) {
    return NextResponse.json({ error: 'product belongs to a different business' }, { status: 403 })
  }

  // Determine next position (last + 1) — small query, recipes rarely have >50 ingredients.
  const { data: last } = await db
    .from('recipe_ingredients')
    .select('position')
    .eq('recipe_id', params.id)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()
  const nextPos = ((last as any)?.position ?? -1) + 1

  // SELECT-then-INSERT or UPDATE to honour UNIQUE(recipe_id, product_id).
  // upsert with onConflict 'recipe_id,product_id' is fine here — it's a
  // full unique constraint (not partial), unlike product_aliases.
  const { data, error } = await db
    .from('recipe_ingredients')
    .upsert({
      recipe_id:  params.id,
      product_id: productId,
      quantity,
      unit:       unit ?? product.invoice_unit,    // default to product's invoice unit
      notes,
      position:   nextPos,
    }, { onConflict: 'recipe_id,product_id' })
    .select('id, product_id, quantity, unit, notes, position')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, ingredient: data }, { headers: { 'Cache-Control': 'no-store' } })
}
