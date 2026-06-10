// app/api/inventory/recipes/promote-bulk/route.ts
//
// POST — bulk-promote (or un-promote) recipes to catalogue products in
//        one call, so the owner can select N sub-recipes on the recipes
//        page and "Add to inventory" without N round-trips.
//
// Body: { business_id, recipe_ids: string[], category?, action?: 'add'|'remove' }
//   action 'add'    — create a products row (source_recipe_id) per recipe.
//                     Idempotent: already-promoted recipes return 'already'.
//   action 'remove' — delete the linked product IF nothing references it,
//                     else report 'in_use' (same guard as the single DELETE).
//
// A promoted recipe becomes a countable catalogue item whose value tracks
// the recipe's LIVE cost (food_cost / portions, computed at read time by
// getProductLatestPrices). Stock counts snapshot that value at line-save
// time — so editing a sub-recipe changes the NEXT count, never a past one.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess, requireOperator } from '@/lib/auth/require-role'
import { packFieldsForPromotedRecipe } from '@/lib/inventory/promoted-product-pack'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VALID_CATS = ['food', 'beverage', 'alcohol', 'cleaning', 'takeaway_material', 'disposables', 'other']

type ResultRow = {
  recipe_id: string
  status: 'promoted' | 'already' | 'removed' | 'not_promoted' | 'in_use' | 'error'
  product_id?: string | null
  error?: string
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }

  const businessId = String(body.business_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const op = requireOperator(auth)
  if (op) return op
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const recipeIds: string[] = Array.isArray(body.recipe_ids)
    ? Array.from(new Set(body.recipe_ids.map((x: any) => String(x).trim()).filter(Boolean)))
    : []
  if (recipeIds.length === 0) return NextResponse.json({ error: 'recipe_ids required (non-empty array)' }, { status: 400 })
  if (recipeIds.length > 500) return NextResponse.json({ error: 'too many recipe_ids (max 500)' }, { status: 400 })

  const action = body.action === 'remove' ? 'remove' : 'add'
  const category = body.category ? String(body.category).trim() : 'food'
  if (action === 'add' && !VALID_CATS.includes(category)) {
    return NextResponse.json({ error: `category must be one of: ${VALID_CATS.join(', ')}` }, { status: 400 })
  }

  const db = createAdminClient()

  // Fetch the recipes — only ones that belong to this business get touched.
  // yield_* drives the weight/volume pack model (M111). Defensive retry
  // for very old schemas without the yield columns.
  let { data: recipes, error: rErr } = await db
    .from('recipes')
    .select('id, business_id, org_id, name, yield_amount, yield_unit')
    .eq('business_id', businessId)
    .in('id', recipeIds)
  if (rErr && /yield_amount|yield_unit/.test(rErr.message)) {
    const retry = await db
      .from('recipes')
      .select('id, business_id, org_id, name')
      .eq('business_id', businessId)
      .in('id', recipeIds)
    recipes = retry.data as any; rErr = retry.error
  }
  if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 })
  const recipeById = new Map<string, any>((recipes ?? []).map((r: any) => [r.id, r]))

  // Existing promotions for these recipes (one query).
  const { data: existingProducts } = await db
    .from('products')
    .select('id, source_recipe_id')
    .eq('business_id', businessId)
    .is('archived_at', null)
    .in('source_recipe_id', recipeIds)
  const productByRecipe = new Map<string, string>()
  for (const p of existingProducts ?? []) {
    if (p.source_recipe_id) productByRecipe.set(p.source_recipe_id, p.id)
  }

  const results: ResultRow[] = []

  for (const rid of recipeIds) {
    const recipe = recipeById.get(rid)
    if (!recipe) { results.push({ recipe_id: rid, status: 'error', error: 'recipe not found at this business' }); continue }

    if (action === 'remove') {
      const productId = productByRecipe.get(rid)
      if (!productId) { results.push({ recipe_id: rid, status: 'not_promoted' }); continue }
      // Guard: don't delete a product that other recipes reference.
      const { count } = await db
        .from('recipe_ingredients')
        .select('id', { count: 'exact', head: true })
        .eq('product_id', productId)
      if ((count ?? 0) > 0) { results.push({ recipe_id: rid, status: 'in_use', product_id: productId, error: `used in ${count} recipe ingredient(s)` }); continue }
      const { error } = await db.from('products').delete().eq('id', productId)
      if (error) { results.push({ recipe_id: rid, status: 'error', error: error.message }); continue }
      results.push({ recipe_id: rid, status: 'removed', product_id: productId })
      continue
    }

    // action === 'add'
    // Pack model — weight/volume when the recipe declares a yield (M111),
    // else pieces. Lets the stock count value physical weight of a sauce.
    const pack = packFieldsForPromotedRecipe({ yield_amount: recipe.yield_amount ?? null, yield_unit: recipe.yield_unit ?? null })

    const existingId = productByRecipe.get(rid)
    if (existingId) {
      // Re-sync the pack model so a yield set/changed after promotion
      // takes effect on the next count.
      await db.from('products')
        .update({ invoice_unit: pack.invoice_unit, pack_size: pack.pack_size, base_unit: pack.base_unit })
        .eq('id', existingId)
      results.push({ recipe_id: rid, status: 'already', product_id: existingId }); continue
    }

    // Cost downstream derives per-portion price from the live recipe via
    // source_recipe_id; pack_size/base_unit value physical weight.
    const insertRow: any = {
      org_id:           recipe.org_id,
      business_id:      recipe.business_id,
      name:             recipe.name,
      category,
      invoice_unit:     pack.invoice_unit,
      pack_size:        pack.pack_size,
      base_unit:        pack.base_unit,
      source_recipe_id: recipe.id,
      created_via:      'recipe_promotion',
    }
    const { data: prod, error } = await db
      .from('products')
      .insert(insertRow)
      .select('id')
      .single()
    if (error) {
      if ((error as any).code === '23505') {
        results.push({ recipe_id: rid, status: 'error', error: `A product called "${recipe.name}" already exists — rename the recipe or merge manually.` })
      } else {
        results.push({ recipe_id: rid, status: 'error', error: error.message })
      }
      continue
    }
    results.push({ recipe_id: rid, status: 'promoted', product_id: prod.id })
  }

  const tally = {
    promoted:     results.filter(r => r.status === 'promoted').length,
    already:      results.filter(r => r.status === 'already').length,
    removed:      results.filter(r => r.status === 'removed').length,
    not_promoted: results.filter(r => r.status === 'not_promoted').length,
    in_use:       results.filter(r => r.status === 'in_use').length,
    errors:       results.filter(r => r.status === 'error').length,
  }

  return NextResponse.json({ ok: true, action, results, tally }, { headers: { 'Cache-Control': 'no-store' } })
}
