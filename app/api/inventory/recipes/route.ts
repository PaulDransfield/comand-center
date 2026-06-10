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
import { resolveRecipePriceFields } from '@/lib/inventory/recipe-price'

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

  // Defensive: M124 (is_subrecipe column) may not be applied yet at
  // every business. If the column is missing, retry without it.
  let { data: recipes, error: rErr } = await db
    .from('recipes')
    .select('id, name, type, menu_price, selling_price_ex_vat, vat_rate, channel, portions, yield_amount, yield_unit, notes, method, portions_per_cover, is_subrecipe, image_url, glass_price, updated_at')
    .eq('business_id', businessId)
    .is('archived_at', null)
    .order('name')
  if (rErr && /is_subrecipe|image_url/.test(rErr.message)) {
    const retry = await db
      .from('recipes')
      .select('id, name, type, menu_price, selling_price_ex_vat, vat_rate, channel, portions, yield_amount, yield_unit, notes, method, portions_per_cover, updated_at')
      .eq('business_id', businessId)
      .is('archived_at', null)
      .order('name')
    recipes = retry.data as any; rErr = retry.error
  }
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

  // Promotion state (M089) — which recipes already have a catalogue
  // product (source_recipe_id) so the list can show "In inventory" and
  // the sub-recipe view can pre-mark them. One cheap query for the whole
  // business. A promoted sub-recipe is countable in stock-takes; its
  // value tracks the recipe's live cost (see getProductLatestPrices).
  const promotedByRecipe = new Map<string, string>()
  {
    const { data: promotedProducts } = await db
      .from('products')
      .select('id, source_recipe_id')
      .eq('business_id', businessId)
      .is('archived_at', null)
      .not('source_recipe_id', 'is', null)
    for (const p of promotedProducts ?? []) {
      if (p.source_recipe_id) promotedByRecipe.set(p.source_recipe_id, p.id)
    }
  }

  const enriched = recipes.map((r: any) => {
    const entry = recipeIndex.get(r.id)
    const ings  = entry?.ingredients ?? []
    // Margin denominator priority: ex-VAT (canonical truth post-M109) →
    // legacy menu_price (back-compat for rows where the owner hasn't
    // re-opened the recipe in the authoring tool yet). Don't derive ex-VAT
    // from a legacy menu_price here — we'd be guessing the rate.
    const marginBase =
      r.selling_price_ex_vat != null ? Number(r.selling_price_ex_vat)
      : r.menu_price != null         ? Number(r.menu_price)
      : null
    const summary = computeRecipeCost(
      ings,
      priceMap,
      marginBase,
      { recipeIndex, recipeId: r.id },
    )
    return {
      id:                   r.id,
      name:                 r.name,
      type:                 r.type,
      menu_price:           r.menu_price != null ? Number(r.menu_price) : null,
      selling_price_ex_vat: r.selling_price_ex_vat != null ? Number(r.selling_price_ex_vat) : null,
      vat_rate:             r.vat_rate != null ? Number(r.vat_rate) : null,
      channel:              r.channel ?? null,
      portions:             r.portions,
      notes:                r.notes,
      updated_at:           r.updated_at,
      food_cost:            summary.food_cost,
      food_pct:             summary.food_pct,
      gp_pct:               summary.gp_pct,
      gp_kr:                summary.gp_kr,
      ingredient_count:     ings.length,
      missing_prices:       summary.missing_prices,
      unit_mismatches:      summary.unit_mismatches,
      subrecipe_count:      ings.filter(i => i.subrecipe_id != null).length,
      is_subrecipe:         r.is_subrecipe === true,
      // M089 promotion — true when this recipe has a live catalogue
      // product, so it shows up in stock counts / items.
      promoted:             promotedByRecipe.has(r.id),
      product_id:           promotedByRecipe.get(r.id) ?? null,
      // M111 yield — drives whether a promoted sub-recipe can be counted
      // by weight/volume. mass/volume yield = weight-countable; no yield
      // (or count yield) = pieces only.
      has_yield:            r.yield_amount != null && r.yield_unit != null,
      yield_unit:           r.yield_unit ?? null,
      image_url:            r.image_url ?? null,
      // Single-product-ingredient recipes (every wine bottle, single-bottle
      // spirits, mineral water etc.) get a free header thumbnail from the
      // ingredient's supplier_article when no image_url is uploaded. We
      // surface the product_id here; the list page batch-fetches the URL.
      fallback_product_id:  (!r.image_url && ings.length === 1 && !ings[0].subrecipe_id && ings[0].product_id) ? ings[0].product_id : null,
      // Per-glass margin — bottle cost / portions, glass price inc-VAT
      // to ex-VAT via vat_rate. Triggered by `glass_price > 0` regardless
      // of `type`. M127 originally restricted to type='wine'; that gate
      // was too narrow — alcohol-free sparkling (e.g. Oddbird Spumante,
      // type='alcohol_free'), ciders sold both bottle + glass, and any
      // other dual-pour drink also need this. If the owner set a glass
      // price, the math applies. Type is metadata, not a precondition.
      glass_price:          r.glass_price != null ? Number(r.glass_price) : null,
      ...((() => {
        if (r.glass_price == null || Number(r.glass_price) <= 0 || !r.portions || r.portions <= 0) {
          return { glass_cost: null, glass_cost_pct: null, glass_gp_pct: null, glass_gp_kr: null }
        }
        const vat            = r.vat_rate != null ? Number(r.vat_rate) : 25
        const glassPriceEx   = Number(r.glass_price) / (1 + vat / 100)
        const glassCost      = summary.food_cost / r.portions
        const glassGpKr      = glassPriceEx - glassCost
        return {
          glass_cost:     glassCost,
          glass_cost_pct: glassPriceEx > 0 ? (glassCost / glassPriceEx) * 100 : null,
          glass_gp_pct:   glassPriceEx > 0 ? (glassGpKr / glassPriceEx) * 100 : null,
          glass_gp_kr:    glassGpKr,
        }
      })()),
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
  const portions   = body.portions   != null ? Math.max(1, Math.floor(Number(body.portions))) : 1
  const notes      = body.notes      ? String(body.notes).trim() : null
  const method     = body.method     ? String(body.method).trim().slice(0, 20000) : null
  const is_subrecipe = body.is_subrecipe === true
  const glass_price  = body.glass_price != null && Number.isFinite(Number(body.glass_price)) && Number(body.glass_price) >= 0
                       ? Number(body.glass_price) : null

  // Price-truth invariant: selling_price_ex_vat is the canonical stored value.
  // vat_rate and channel are independent owner-set fields (no inference
  // between them — VAT-misrouting lesson from lib/sweden/vat.ts). menu_price
  // is derived from ex_vat × (1 + vat_rate/100) so the two can never drift
  // out of sync. The body may pass either form; we resolve to ex_vat.
  const priceResolution = resolveRecipePriceFields(body)
  if (priceResolution.error) {
    return NextResponse.json({ error: priceResolution.error }, { status: 400 })
  }
  const { selling_price_ex_vat, vat_rate, channel, menu_price } = priceResolution

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!name)       return NextResponse.json({ error: 'name required' },        { status: 400 })
  if (name.length > 200) return NextResponse.json({ error: 'name too long (max 200)' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('id, org_id').eq('id', businessId).maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  const baseRow: any = {
    business_id: businessId,
    org_id:      biz.org_id,
    name,
    type,
    menu_price,                  // derived (or legacy passthrough if no ex_vat)
    selling_price_ex_vat,        // canonical truth
    vat_rate,
    channel,
    portions,
    notes,
    method,
    glass_price,
  }
  let { data, error } = await db
    .from('recipes')
    .insert({ ...baseRow, is_subrecipe })
    .select('id, name, type, menu_price, selling_price_ex_vat, vat_rate, channel, portions, yield_amount, yield_unit, notes, method, portions_per_cover, is_subrecipe, image_url, glass_price, updated_at')
    .single()
  // Defensive: M124 may not be applied yet (or PostgREST schema cache stale).
  if (error && /is_subrecipe/.test(error.message)) {
    const retry = await db
      .from('recipes')
      .insert(baseRow)
      .select('id, name, type, menu_price, selling_price_ex_vat, vat_rate, channel, portions, yield_amount, yield_unit, notes, method, portions_per_cover, updated_at')
      .single()
    data = retry.data as any; error = retry.error
  }
  if (error) {
    if ((error as any).code === '23505') {
      return NextResponse.json({ error: `A recipe called "${name}" already exists. Pick a different name.` }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, recipe: data }, { headers: { 'Cache-Control': 'no-store' } })
}

