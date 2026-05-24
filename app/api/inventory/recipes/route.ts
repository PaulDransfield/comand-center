// app/api/inventory/recipes/route.ts
//
// GET — list every recipe for a business with computed cost / food %
//       / GP. One batch fetch of latest prices keeps the list fast even
//       at 50+ recipes.
// POST — create a new recipe header (ingredients added separately).

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { computeRecipeCost, getProductLatestPrices, loadRecipeIndex } from '@/lib/inventory/recipe-cost'
import { loadFxIndex } from '@/lib/inventory/fx'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const businessId = String(url.searchParams.get('business_id') ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  const { data: recipes, error: rErr } = await db
    .from('recipes')
    .select('id, name, type, menu_price, portions, notes, updated_at')
    .eq('business_id', businessId)
    .is('archived_at', null)
    .order('name')
  if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 })
  if (!recipes || recipes.length === 0) {
    return NextResponse.json({
      recipes: [],
      summary: { count: 0, avg_gp_pct: null, low_gp_count: 0, avg_menu_price: null },
    }, { headers: { 'Cache-Control': 'no-store' } })
  }

  // Load the full recipe index so the cost computer can recurse through
  // sub-recipe references. Two batched queries; cheap even at 500+ recipes.
  const recipeIndex = await loadRecipeIndex(db, businessId)

  // Distinct product IDs across the WHOLE business (so sub-recipe leaf
  // products price too, not just the ones in the top-level recipes).
  const allProductIds = new Set<string>()
  for (const entry of recipeIndex.values()) {
    for (const ing of entry.ingredients) {
      if (ing.product_id) allProductIds.add(ing.product_id)
    }
  }
  const fxIndex  = await loadFxIndex(db, ['EUR', 'USD', 'NOK', 'DKK', 'GBP'])
  const priceMap = await getProductLatestPrices(db, businessId, Array.from(allProductIds), fxIndex)

  const enriched = recipes.map((r: any) => {
    const entry = recipeIndex.get(r.id)
    const ings  = entry?.ingredients ?? []
    const summary = computeRecipeCost(
      ings,
      priceMap,
      r.menu_price != null ? Number(r.menu_price) : null,
      { recipeIndex, recipeId: r.id },
    )
    return {
      id:         r.id,
      name:       r.name,
      type:       r.type,
      menu_price: r.menu_price != null ? Number(r.menu_price) : null,
      portions:   r.portions,
      notes:      r.notes,
      updated_at: r.updated_at,
      food_cost:       summary.food_cost,
      food_pct:        summary.food_pct,
      gp_pct:          summary.gp_pct,
      gp_kr:           summary.gp_kr,
      ingredient_count: ings.length,
      missing_prices:  summary.missing_prices,
      unit_mismatches: summary.unit_mismatches,
      subrecipe_count: ings.filter(i => i.subrecipe_id != null).length,
    }
  })

  // Summary row for the KPI strip
  const withGp = enriched.filter(r => r.gp_pct != null) as any[]
  const avgGp  = withGp.length ? withGp.reduce((s, r) => s + r.gp_pct, 0) / withGp.length : null
  const lowGp  = withGp.filter(r => r.gp_pct < 65).length
  const withPrice = enriched.filter(r => r.menu_price != null && r.menu_price > 0) as any[]
  const avgPrice  = withPrice.length ? withPrice.reduce((s, r) => s + r.menu_price, 0) / withPrice.length : null

  return NextResponse.json({
    recipes: enriched,
    summary: {
      count:           enriched.length,
      avg_gp_pct:      avgGp != null ? Math.round(avgGp * 10) / 10 : null,
      low_gp_count:    lowGp,
      avg_menu_price:  avgPrice != null ? Math.round(avgPrice) : null,
    },
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  const name       = String(body.name        ?? '').trim()
  const type       = body.type       ? String(body.type).trim() : null
  const menuPrice  = body.menu_price != null ? Number(body.menu_price) : null
  const portions   = body.portions   != null ? Math.max(1, Math.floor(Number(body.portions))) : 1
  const notes      = body.notes      ? String(body.notes).trim() : null

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!name)       return NextResponse.json({ error: 'name required' },        { status: 400 })
  if (name.length > 200) return NextResponse.json({ error: 'name too long (max 200)' }, { status: 400 })
  if (menuPrice != null && (!Number.isFinite(menuPrice) || menuPrice < 0)) {
    return NextResponse.json({ error: 'menu_price must be a non-negative number' }, { status: 400 })
  }
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('id, org_id').eq('id', businessId).maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  const { data, error } = await db
    .from('recipes')
    .insert({
      business_id: businessId,
      org_id:      biz.org_id,
      name,
      type,
      menu_price:  menuPrice,
      portions,
      notes,
    })
    .select('id, name, type, menu_price, portions, notes, updated_at')
    .single()
  if (error) {
    if ((error as any).code === '23505') {
      return NextResponse.json({ error: `A recipe called "${name}" already exists. Pick a different name.` }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, recipe: data }, { headers: { 'Cache-Control': 'no-store' } })
}
