// app/api/inventory/menus/[id]/route.ts
//
// GET    — full menu with items + computed per-course costs and rollup.
// PATCH  — update name / price / VAT / channel / notes / type.
// DELETE — soft-archive (sets archived_at).

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { computeRecipeCost, loadRecipeIndex, getProductLatestPrices } from '@/lib/inventory/recipe-cost'
import { loadFxIndex } from '@/lib/inventory/fx'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: menu, error } = await db.from('menus')
    .select('id, business_id, name, type, selling_price_ex_vat, menu_price, vat_rate, channel, notes, created_at, updated_at')
    .eq('id', params.id).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!menu)  return NextResponse.json({ error: 'menu not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, menu.business_id)
  if (forbidden) return forbidden

  const { data: items } = await db.from('menu_items')
    .select('id, recipe_id, course_position, qty, note, created_at')
    .eq('menu_id', menu.id).order('course_position').order('created_at')

  // Fetch recipe metadata for the picker display + cost calc.
  const recipeIds = (items ?? []).map((it: any) => it.recipe_id)
  const recipesMeta = new Map<string, any>()
  if (recipeIds.length > 0) {
    for (let i = 0; i < recipeIds.length; i += 100) {
      const slice = recipeIds.slice(i, i + 100)
      const { data: rs } = await db.from('recipes')
        .select('id, name, type, portions, image_url')
        .in('id', slice)
      for (const r of rs ?? []) recipesMeta.set(r.id, r)
    }
  }

  const fxIndex = await loadFxIndex(db, ['EUR', 'USD', 'NOK', 'DKK', 'GBP'])
  const recipeIndex = await loadRecipeIndex(db, menu.business_id)
  // Collect EVERY leaf product the menu's recipes (and their sub-recipes)
  // depend on. Top-level-only collection drops sub-recipe leaves and the
  // engine then reports them as no_price → false "Incomplete cost" flag.
  const productIds = new Set<string>()
  function collectLeaves(rid: string, seen: Set<string>) {
    if (seen.has(rid)) return
    seen.add(rid)
    const r = recipeIndex.get(rid); if (!r) return
    for (const ing of r.ingredients ?? []) {
      if (ing.product_id)   productIds.add(ing.product_id)
      if (ing.subrecipe_id) collectLeaves(ing.subrecipe_id, seen)
    }
  }
  const seen = new Set<string>()
  for (const rid of recipeIds) collectLeaves(rid, seen)
  const priceMap = await getProductLatestPrices(db, menu.business_id, Array.from(productIds), fxIndex)

  const enrichedItems = (items ?? []).map((it: any) => {
    const meta  = recipesMeta.get(it.recipe_id)
    const entry = recipeIndex.get(it.recipe_id)
    const ings  = entry?.ingredients ?? []
    const cost  = computeRecipeCost(ings, priceMap, null, { recipeIndex, recipeId: it.recipe_id })
    const perPortion = Number(cost?.food_cost ?? 0)
    const incomplete = (cost?.missing_prices ?? 0) > 0 || (cost?.unit_mismatches ?? 0) > 0
    return {
      ...it,
      recipe_name:   meta?.name ?? '?',
      recipe_type:   meta?.type ?? null,
      recipe_image:  meta?.image_url ?? null,
      food_cost_per_portion: Math.round(perPortion * 100) / 100,
      line_food_cost:        Math.round(perPortion * Number(it.qty ?? 1) * 100) / 100,
      missing_prices:        cost?.missing_prices ?? 0,
      unit_mismatches:       cost?.unit_mismatches ?? 0,
      incomplete,
    }
  })

  const totalFoodCost = enrichedItems.reduce((s, it) => s + Number(it.line_food_cost ?? 0), 0)
  const ex = menu.selling_price_ex_vat != null ? Number(menu.selling_price_ex_vat) : null
  const summary = {
    item_count:      enrichedItems.length,
    food_cost:       Math.round(totalFoodCost * 100) / 100,
    gp_kr:           ex != null ? Math.round((ex - totalFoodCost) * 100) / 100 : null,
    gp_pct:          ex != null && ex > 0 ? Math.round(((ex - totalFoodCost) / ex) * 1000) / 10 : null,
    cost_pct:        ex != null && ex > 0 ? Math.round((totalFoodCost / ex) * 1000) / 10 : null,
    missing_prices:  enrichedItems.reduce((s, it) => s + (it.missing_prices ?? 0), 0),
    unit_mismatches: enrichedItems.reduce((s, it) => s + (it.unit_mismatches ?? 0), 0),
    incomplete:      enrichedItems.some(it => it.incomplete),
  }

  return NextResponse.json({ menu, items: enrichedItems, summary }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
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
  if (body.name !== undefined) {
    const n = String(body.name).trim()
    if (!n || n.length > 200) return NextResponse.json({ error: 'name 1..200 chars' }, { status: 400 })
    patch.name = n
  }
  if (body.type !== undefined) {
    if (body.type !== 'food' && body.type !== 'drink') return NextResponse.json({ error: "type must be 'food' or 'drink'" }, { status: 400 })
    patch.type = body.type
  }
  if (body.selling_price_ex_vat !== undefined) {
    if (body.selling_price_ex_vat === null || body.selling_price_ex_vat === '') {
      patch.selling_price_ex_vat = null
    } else {
      const v = Number(body.selling_price_ex_vat)
      if (!Number.isFinite(v) || v < 0) return NextResponse.json({ error: 'price must be >= 0' }, { status: 400 })
      patch.selling_price_ex_vat = v
    }
  }
  if (body.menu_price !== undefined) {
    if (body.menu_price === null || body.menu_price === '') {
      patch.menu_price = null
    } else {
      const v = Number(body.menu_price)
      if (!Number.isFinite(v) || v < 0) return NextResponse.json({ error: 'menu_price must be >= 0' }, { status: 400 })
      patch.menu_price = v
    }
  }
  if (body.vat_rate !== undefined) {
    const v = Number(body.vat_rate)
    if (!Number.isFinite(v) || v < 0 || v > 100) return NextResponse.json({ error: 'vat_rate must be 0..100' }, { status: 400 })
    patch.vat_rate = v
  }
  if (body.channel !== undefined) {
    if (body.channel !== 'dine_in' && body.channel !== 'takeaway') return NextResponse.json({ error: "channel must be 'dine_in' or 'takeaway'" }, { status: 400 })
    patch.channel = body.channel
  }
  if (body.notes !== undefined) {
    if (body.notes === null || body.notes === '') patch.notes = null
    else {
      const n = String(body.notes)
      if (n.length > 2000) return NextResponse.json({ error: 'notes max 2000 chars' }, { status: 400 })
      patch.notes = n
    }
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'no fields to patch' }, { status: 400 })

  const { data, error } = await db.from('menus').update(patch).eq('id', params.id).select('id').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, id: data.id }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: menu } = await db.from('menus').select('business_id').eq('id', params.id).maybeSingle()
  if (!menu) return NextResponse.json({ error: 'menu not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, menu.business_id)
  if (forbidden) return forbidden

  const { error } = await db.from('menus').update({ archived_at: new Date().toISOString() }).eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
