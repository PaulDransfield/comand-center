// app/api/inventory/recipes/[id]/promote/route.ts
//
// POST   — promote a recipe to a catalogue item. Creates a products
//          row with source_recipe_id pointing back at the recipe.
//          Idempotent: returns the existing product_id if already promoted.
// DELETE — un-promote: delete the linked product row IF no recipe or
//          line refers to it (otherwise return 409 + suggest archive).

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
  const category = body.category ? String(body.category).trim() : 'food'
  const validCats = ['food', 'beverage', 'alcohol', 'cleaning', 'takeaway_material', 'disposables', 'other']
  if (!validCats.includes(category)) {
    return NextResponse.json({ error: `category must be one of: ${validCats.join(', ')}` }, { status: 400 })
  }

  const db = createAdminClient()
  const { data: r, error: rErr } = await db
    .from('recipes')
    .select('id, business_id, org_id, name')
    .eq('id', params.id)
    .maybeSingle()
  if (rErr)  return NextResponse.json({ error: rErr.message }, { status: 500 })
  if (!r)    return NextResponse.json({ error: 'recipe not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, r.business_id)
  if (forbidden) return forbidden

  // Idempotent: if already promoted, return that product.
  const { data: existing } = await db
    .from('products')
    .select('id, name, category')
    .eq('business_id', r.business_id)
    .eq('source_recipe_id', r.id)
    .maybeSingle()
  if (existing?.id) {
    return NextResponse.json({ ok: true, product_id: existing.id, already_promoted: true })
  }

  // Build the product row. Pack model for prep recipes:
  //   invoice_unit = 'portion' (cosmetic display)
  //   pack_size    = 1
  //   base_unit    = 'st' (CHECK only allows g/ml/st; portion ≈ st semantically)
  // Cost calc downstream uses source_recipe_id to derive the actual
  // price per portion from the live recipe.
  const insertRow: any = {
    org_id:         r.org_id,
    business_id:     r.business_id,
    name:            r.name,
    category,
    invoice_unit:    'portion',
    pack_size:       1,
    base_unit:       'st',
    source_recipe_id: r.id,
    created_via:     'recipe_promotion',
  }

  // Try insert; on UNIQUE(business_id, name) collision, return 409 — owner
  // either renamed an existing product to clash with this recipe, or has
  // a duplicate name they need to resolve.
  const { data: prod, error } = await db
    .from('products')
    .insert(insertRow)
    .select('id, name')
    .single()
  if (error) {
    if ((error as any).code === '23505') {
      return NextResponse.json({
        error: `A product called "${r.name}" already exists. Rename the recipe before promoting, or merge with the existing product manually.`,
      }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    product_id: prod.id,
    already_promoted: false,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: r } = await db.from('recipes').select('id, business_id').eq('id', params.id).maybeSingle()
  if (!r) return NextResponse.json({ error: 'recipe not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, r.business_id)
  if (forbidden) return forbidden

  const { data: prod } = await db
    .from('products')
    .select('id')
    .eq('business_id', r.business_id)
    .eq('source_recipe_id', r.id)
    .maybeSingle()
  if (!prod) return NextResponse.json({ ok: true, message: 'not promoted' })

  // Check usage: any recipe_ingredients referencing this product?
  const { count } = await db
    .from('recipe_ingredients')
    .select('id', { count: 'exact', head: true })
    .eq('product_id', prod.id)
  if ((count ?? 0) > 0) {
    return NextResponse.json({
      error: `Can't un-promote — this catalogue item is used in ${count} recipe ingredient(s). Remove those references first.`,
    }, { status: 409 })
  }

  const { error } = await db.from('products').delete().eq('id', prod.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
