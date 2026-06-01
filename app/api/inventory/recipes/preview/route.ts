// app/api/inventory/recipes/preview/route.ts
//
// POST — live cost preview for an in-progress recipe edit.
//
// Used by the recipe-authoring tool. Takes the in-memory recipe state
// (no save) and returns the cost summary using the same `computeRecipeCost`
// engine the list / detail pages use — so the live margin can never
// disagree with what the save would produce.
//
// Key design decisions (per recipe-authoring-tool-prompt review):
//
//   - Caller passes `selling_price_ex_vat` as the margin denominator.
//     The engine treats `menuPrice` as the ex-VAT comparison base; we do
//     NOT infer VAT here. If the owner is mid-typing and has only entered
//     inc-VAT, the UI converts to ex-VAT (using owner-set vat_rate) before
//     calling this endpoint.
//
//   - For a recipe being EDITED (recipe_id present in body), we load the
//     full business RecipeIndex and replace that recipe's ingredients with
//     the in-progress set. This keeps sub-recipe context (the recipe might
//     reference a sub-recipe that's part of the index) and lets cycle
//     detection run against the LIVE edit, not the saved version.
//
//   - For a NEW recipe (no recipe_id), we still load the index so sub-
//     recipe references resolve. We use a temporary uuid placeholder for
//     the in-progress recipe's id so cycle detection has something to anchor.
//
//   - Waste inflation lives in `inflateForWaste` from recipe-cost.ts so the
//     engine itself doesn't change — the preview applies it before passing
//     ingredients in, just like loadRecipeIndex does for saved recipes.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import {
  computeRecipeCost,
  getProductLatestPrices,
  loadRecipeIndex,
  wouldCreateCycle,
  inflateForWaste,
  type IngredientForCosting,
  type RecipeContextEntry,
} from '@/lib/inventory/recipe-cost'
import { loadFxIndex } from '@/lib/inventory/fx'
import { randomUUID } from 'node:crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface PreviewIngredient {
  product_id?:   string | null
  subrecipe_id?: string | null
  quantity:      number
  unit?:         string | null
  waste_pct?:    number
  notes?:        string | null
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }

  const businessId  = String(body.business_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const recipeId      = typeof body.recipe_id === 'string' && body.recipe_id ? body.recipe_id : null
  const sellingExVat  = body.selling_price_ex_vat != null ? Number(body.selling_price_ex_vat) : null
  const portions      = Math.max(1, Number(body.portions ?? 1))
  const ingredientsIn: PreviewIngredient[] = Array.isArray(body.ingredients) ? body.ingredients : []

  const db = createAdminClient()

  // ── Load context: full RecipeIndex + product prices ─────────────────
  const recipeIndex = await loadRecipeIndex(db, businessId)

  // Build the in-progress IngredientForCosting[] from the input. Apply
  // waste inflation here (same pattern as loadRecipeIndex), so the engine
  // sees inflated quantities and computes the realistic cost.
  const draftIngredients: IngredientForCosting[] = ingredientsIn.map((i, idx) => {
    const stated   = Number(i.quantity ?? 0)
    const wastePct = clampWaste(i.waste_pct ?? 0)
    return {
      id:              `draft-${idx}`,
      product_id:      i.product_id ?? null,
      product_name:    null,           // resolved below if product_id is set
      category:        null,
      quantity:        inflateForWaste(stated, wastePct),
      quantity_stated: stated,
      waste_pct:       wastePct,
      unit:            i.unit ?? null,
      notes:           i.notes ?? null,
      position:        idx,
      subrecipe_id:    i.subrecipe_id ?? null,
      subrecipe_name:  null,
    }
  })

  // Hydrate product_name for any product_id refs (cost engine doesn't strictly
  // need name, but the response includes it so the UI can show "INVALID
  // product id" when the picker hands a bad id).
  const refProductIds = Array.from(new Set(draftIngredients.map(d => d.product_id).filter((x): x is string => !!x)))
  if (refProductIds.length > 0) {
    const { data: prods } = await db
      .from('products')
      .select('id, name, category')
      .in('id', refProductIds)
    const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))
    for (const d of draftIngredients) {
      if (d.product_id) {
        const p = byId.get(d.product_id)
        if (p) { d.product_name = p.name; d.category = p.category }
      }
    }
  }

  // Inject the in-progress recipe into the RecipeIndex so cost recursion
  // + cycle detection works correctly. Use the actual recipe_id when
  // editing; a stable placeholder for new recipes.
  const draftRecipeId = recipeId ?? `draft-${randomUUID()}`
  const draftEntry: RecipeContextEntry = {
    id:           draftRecipeId,
    portions,
    // M111 — preview only needs the in-progress recipe's COST, not its
    // yield; the yield only matters when this recipe is consumed AS a
    // sub-recipe by another. Leave null; never affects preview output.
    yield_amount: null,
    yield_unit:   null,
    ingredients:  draftIngredients,
  }
  recipeIndex.set(draftRecipeId, draftEntry)

  // Cycle pre-check on each subrecipe reference — engine will also catch
  // cycles via ancestor tracking, but a clear flag in the response is
  // easier for the UI to display.
  const cycleWarnings: string[] = []
  for (const ing of draftIngredients) {
    if (ing.subrecipe_id) {
      if (ing.subrecipe_id === draftRecipeId) {
        cycleWarnings.push('A recipe cannot reference itself as an ingredient.')
        continue
      }
      if (wouldCreateCycle(draftRecipeId, ing.subrecipe_id, recipeIndex)) {
        cycleWarnings.push(`Sub-recipe "${ing.subrecipe_name ?? ing.subrecipe_id.slice(0, 8)}" would create a cycle.`)
      }
    }
  }

  // Latest prices for every product anywhere in the dependency tree.
  const allProductIds = new Set<string>()
  for (const e of recipeIndex.values()) {
    for (const ing of e.ingredients) if (ing.product_id) allProductIds.add(ing.product_id)
  }
  const fxIndex  = await loadFxIndex(db, ['EUR', 'USD', 'NOK', 'DKK', 'GBP'])
  const priceMap = await getProductLatestPrices(db, businessId, Array.from(allProductIds), fxIndex)

  const summary = computeRecipeCost(
    draftIngredients,
    priceMap,
    sellingExVat,                              // engine uses this as the ex-VAT comparison base
    { recipeIndex, recipeId: draftRecipeId },
  )

  return NextResponse.json({
    ok:               true,
    food_cost:        summary.food_cost,
    food_pct:         summary.food_pct,         // null when selling_price_ex_vat is null/0
    gp_kr:            summary.gp_kr,
    gp_pct:           summary.gp_pct,
    missing_prices:   summary.missing_prices,
    unit_mismatches:  summary.unit_mismatches,
    cycle_warnings:   cycleWarnings,
    ingredients:      summary.ingredients,      // CostedIngredient[] — UI uses per-line cost + flags
    // Convenience derived for the UI:
    is_complete:      summary.missing_prices === 0 && summary.unit_mismatches === 0 && cycleWarnings.length === 0,
  })
}

// Mirrors clampWastePct in recipe-cost.ts (not exported because of historical
// kebab-case-vs-camel inconsistency; duplicated here for clarity, identical
// logic — if the bound changes there, change here).
const MAX_WASTE_PCT = 95
function clampWaste(raw: any): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (n >= MAX_WASTE_PCT) return MAX_WASTE_PCT
  return n
}
