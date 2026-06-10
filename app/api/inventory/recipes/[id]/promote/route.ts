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
import { packFieldsForPromotedRecipe } from '@/lib/inventory/promoted-product-pack'

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
  // Pull yield so the catalogue product can be counted by weight/volume
  // (M111). Defensive: yield columns may be absent on very old schemas.
  let { data: r, error: rErr } = await db
    .from('recipes')
    .select('id, business_id, org_id, name, yield_amount, yield_unit')
    .eq('id', params.id)
    .maybeSingle()
  if (rErr && /yield_amount|yield_unit/.test(rErr.message)) {
    const retry = await db
      .from('recipes')
      .select('id, business_id, org_id, name')
      .eq('id', params.id)
      .maybeSingle()
    r = retry.data as any; rErr = retry.error
  }
  if (rErr)  return NextResponse.json({ error: rErr.message }, { status: 500 })
  if (!r)    return NextResponse.json({ error: 'recipe not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, r.business_id)
  if (forbidden) return forbidden

  // Pack model — weight/volume when the recipe declares a yield, else
  // pieces. See lib/inventory/promoted-product-pack.ts for the math.
  const pack = packFieldsForPromotedRecipe({ yield_amount: (r as any).yield_amount ?? null, yield_unit: (r as any).yield_unit ?? null })

  // Idempotent: if already promoted, re-sync its pack model (so a yield
  // set/changed after the first promotion flows through) and return it.
  const { data: existing } = await db
    .from('products')
    .select('id, name, category')
    .eq('business_id', r.business_id)
    .eq('source_recipe_id', r.id)
    .maybeSingle()
  if (existing?.id) {
    await db.from('products')
      .update({ invoice_unit: pack.invoice_unit, pack_size: pack.pack_size, base_unit: pack.base_unit })
      .eq('id', existing.id)
    return NextResponse.json({ ok: true, product_id: existing.id, already_promoted: true, count_mode: pack.count_mode })
  }

  // Build the product row. Cost calc downstream uses source_recipe_id to
  // derive the live price per portion; pack_size/base_unit let the stock
  // count value physical weight (e.g. 2 kg of sauce).
  const insertRow: any = {
    org_id:         r.org_id,
    business_id:     r.business_id,
    name:            r.name,
    category,
    invoice_unit:    pack.invoice_unit,
    pack_size:       pack.pack_size,
    base_unit:       pack.base_unit,
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
    count_mode: pack.count_mode,
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
