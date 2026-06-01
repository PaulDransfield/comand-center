// app/api/inventory/prep-list/route.ts
//
// POST { business_id, items: [{ recipe_id, qty }] }
//   → 200 { components: [...], products: [...], flags: [...] }
//
// Aggregates the expected production into a prep list with shared
// sub-recipes rolled up. See lib/inventory/prep-list.ts for the engine.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { loadRecipeIndex } from '@/lib/inventory/recipe-cost'
import { aggregatePrepRequirements, type PrepListInput } from '@/lib/inventory/prep-list'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
  business_id?: string
  items?: Array<{ recipe_id?: string; qty?: number }>
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: Body
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const businessId = String(body.business_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const rawItems = Array.isArray(body.items) ? body.items : []
  const items: PrepListInput[] = []
  for (const it of rawItems) {
    const rid = String(it?.recipe_id ?? '').trim()
    const qty = Number(it?.qty ?? 0)
    if (!rid || !Number.isFinite(qty) || qty <= 0) continue
    items.push({ recipe_id: rid, qty })
  }
  if (items.length === 0) {
    return NextResponse.json({
      components: [], products: [], flags: [],
    }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const db = createAdminClient()

  // Recipe index (graph + cycle-guard); name map for component display.
  const recipeIndex = await loadRecipeIndex(db, businessId)
  const { data: nameRows } = await db
    .from('recipes')
    .select('id, name')
    .eq('business_id', businessId)
    .is('archived_at', null)
  const recipeNames = new Map<string, string | null>()
  for (const r of nameRows ?? []) recipeNames.set(r.id, r.name ?? null)

  // Cross-tenant guard: every requested recipe_id must belong to the
  // business. Items the index doesn't know about are dropped here (not
  // engine-side, so we don't leak existence of foreign recipes).
  const safeItems = items.filter(i => recipeIndex.has(i.recipe_id))
  if (safeItems.length === 0) {
    return NextResponse.json({
      components: [], products: [], flags: [
        { recipe_id: '', reason: 'No recognised recipes in the request — nothing to aggregate.' },
      ],
    }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const result = aggregatePrepRequirements(safeItems, recipeIndex, recipeNames)

  // Fill product names. Single batch fetch.
  const productIds = result.products.map(p => p.product_id)
  if (productIds.length > 0) {
    const { data: prodRows } = await db
      .from('products')
      .select('id, name, category')
      .in('id', productIds)
    const nameByPid = new Map<string, { name: string | null; category: string | null }>()
    for (const p of prodRows ?? []) {
      nameByPid.set(p.id, { name: p.name ?? null, category: p.category ?? null })
    }
    result.products = result.products.map(p => ({
      ...p,
      name: nameByPid.get(p.product_id)?.name ?? null,
      // tack category on so the UI can group (food / beverage / etc.)
      // without an extra round-trip.
      category: nameByPid.get(p.product_id)?.category ?? null,
    } as any))
  }

  // Meta enrichment — mirrors what GET /api/inventory/prep-sessions/[id]
  // does so create-mode shows the same context (method, uses) as
  // prep-mode. The chef can write missing notes/method here BEFORE
  // hitting "Save & start prep" — writes target the underlying
  // recipes.method / recipe_ingredients.notes via the existing PATCH
  // endpoints, so every future prep list inherits them.
  // Component meta — method, notes (fallback when method is empty),
  // and the sub-recipe's own ingredient list (so the modal can show
  // editable per-ingredient prep notes even for yield-less subs whose
  // ingredients don't surface as separate product lines). Mirrors what
  // GET /api/inventory/prep-sessions/[id] does for the session view.
  const componentIds = result.components.map(c => c.subrecipe_id)
  const methodById = new Map<string, string | null>()
  const notesById  = new Map<string, string | null>()
  const subIngredientsByRecipe = new Map<string, Array<{ ingredient_id: string; product_id: string | null; product_name: string | null; quantity: number; unit: string | null; notes: string | null; position: number }>>()
  if (componentIds.length > 0) {
    const { data: rs } = await db
      .from('recipes')
      .select('id, method, notes')
      .in('id', componentIds)
    for (const r of rs ?? []) {
      methodById.set(r.id, (r as any).method ?? null)
      notesById.set(r.id, (r as any).notes ?? null)
    }
    const { data: subIngs } = await db
      .from('recipe_ingredients')
      .select('id, recipe_id, product_id, quantity, unit, notes, position, products(name)')
      .in('recipe_id', componentIds)
      .order('position')
    for (const i of subIngs ?? []) {
      const list = subIngredientsByRecipe.get((i as any).recipe_id) ?? []
      list.push({
        ingredient_id: (i as any).id,
        product_id:    (i as any).product_id,
        product_name:  ((i as any).products as any)?.name ?? null,
        quantity:      Number((i as any).quantity ?? 0),
        unit:          (i as any).unit ?? null,
        notes:         (i as any).notes ?? null,
        position:      Number((i as any).position ?? 0),
      })
      subIngredientsByRecipe.set((i as any).recipe_id, list)
    }
  }
  const usesByProductId = new Map<string, Array<{ ingredient_id: string; recipe_id: string; recipe_name: string | null; notes: string | null; quantity: number; unit: string | null }>>()
  if (productIds.length > 0) {
    const { data: ris } = await db
      .from('recipe_ingredients')
      .select('id, product_id, quantity, unit, notes, recipes!inner(id, name, business_id, archived_at)')
      .in('product_id', productIds)
      .eq('recipes.business_id', businessId)
      .is('recipes.archived_at', null)
    for (const r of ris ?? []) {
      const pid = (r as any).product_id as string
      const rec = (r as any).recipes
      if (!rec) continue
      const list = usesByProductId.get(pid) ?? []
      list.push({
        ingredient_id: (r as any).id,
        recipe_id:     rec.id,
        recipe_name:   rec.name ?? null,
        notes:         (r as any).notes ?? null,
        quantity:      Number((r as any).quantity ?? 0),
        unit:          (r as any).unit ?? null,
      })
      usesByProductId.set(pid, list)
    }
  }

  const enrichedComponents = result.components.map(c => ({
    ...c,
    meta: {
      method:      methodById.get(c.subrecipe_id) ?? null,
      notes:       notesById.get(c.subrecipe_id)  ?? null,
      ingredients: subIngredientsByRecipe.get(c.subrecipe_id) ?? [],
    },
  }))
  const enrichedProducts = result.products.map(p => ({
    ...p,
    meta: { uses: usesByProductId.get(p.product_id) ?? [] },
  } as any))

  return NextResponse.json({
    ...result,
    components: enrichedComponents,
    products:   enrichedProducts,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
