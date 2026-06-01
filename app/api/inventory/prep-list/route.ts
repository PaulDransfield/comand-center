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

  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
