// app/api/inventory/recipes/search/route.ts
//
// GET — type-ahead search for the sub-recipe tab in the ingredient picker.
// Returns up to 20 recipes matching the query with their portions + a
// computed cost-per-portion so the picker can preview "0.5 portions of
// Tomato Sauce = 7.50 kr" before the owner commits.
//
// ?q=<query>&business_id=<uuid>&exclude_recipe_id=<uuid>
//   exclude_recipe_id excludes the recipe being edited from the picker
//   to prevent the obvious self-reference UX trap (the API would reject
//   it anyway with 409 but better to hide it).

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { computeRecipeCost, getProductLatestPrices, loadRecipeIndex, wouldCreateCycle } from '@/lib/inventory/recipe-cost'
import { loadFxIndex } from '@/lib/inventory/fx'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const businessId       = String(url.searchParams.get('business_id')        ?? '').trim()
  const query            = String(url.searchParams.get('q')                  ?? '').trim()
  const excludeRecipeId  = String(url.searchParams.get('exclude_recipe_id')  ?? '').trim() || null
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  let qB = db
    .from('recipes')
    .select('id, name, type, portions')
    .eq('business_id', businessId)
    .is('archived_at', null)
    .order('name')
    .limit(20)
  if (query) qB = qB.ilike('name', `%${query}%`)
  const { data: recipes, error } = await qB
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Cost each candidate. Same path as the list endpoint.
  const recipeIndex = await loadRecipeIndex(db, businessId)
  const allProductIds = new Set<string>()
  for (const e of recipeIndex.values()) {
    for (const ing of e.ingredients) if (ing.product_id) allProductIds.add(ing.product_id)
  }
  const fxIndex  = await loadFxIndex(db, ['EUR', 'USD', 'NOK', 'DKK', 'GBP'])
  const priceMap = await getProductLatestPrices(db, businessId, Array.from(allProductIds), fxIndex)

  const out = (recipes ?? [])
    .filter((r: any) => !excludeRecipeId || r.id !== excludeRecipeId)
    .map((r: any) => {
      const entry  = recipeIndex.get(r.id)
      const summary = computeRecipeCost(
        entry?.ingredients ?? [],
        priceMap,
        null,
        { recipeIndex, recipeId: r.id },
      )
      const perPortion = (r.portions > 0 ? summary.food_cost / r.portions : 0)
      // Flag recipes that would create a cycle if added to excludeRecipeId.
      const cycle = excludeRecipeId ? wouldCreateCycle(excludeRecipeId, r.id, recipeIndex) : false
      return {
        recipe_id:        r.id,
        name:             r.name,
        type:             r.type,
        portions:         r.portions,
        food_cost:        summary.food_cost,
        cost_per_portion: Math.round(perPortion * 100) / 100,
        would_cycle:      cycle,
      }
    })

  return NextResponse.json({ recipes: out }, { headers: { 'Cache-Control': 'no-store' } })
}
