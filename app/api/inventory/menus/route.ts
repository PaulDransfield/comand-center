// app/api/inventory/menus/route.ts
//
// GET — list set menus for a business, with computed food cost summary
// per menu (cost rolls up from each menu_item.recipe).
// POST — create a new set menu.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { computeRecipeCost, loadRecipeIndex, getProductLatestPrices } from '@/lib/inventory/recipe-cost'
import { loadFxIndex } from '@/lib/inventory/fx'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const businessId = String(url.searchParams.get('business_id') ?? '').trim()
  const typeParam  = url.searchParams.get('type')   // 'food' | 'drink' | null (all)
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  // Defensive SELECT: image_url is M134 which may not be applied yet.
  // First attempt includes it; on 42703 (column does not exist) we fall
  // back to the pre-M134 column set so the page still loads.
  const COLS_WITH_IMG = 'id, name, type, selling_price_ex_vat, menu_price, vat_rate, channel, notes, image_url, created_at, updated_at'
  const COLS_LEGACY   = 'id, name, type, selling_price_ex_vat, menu_price, vat_rate, channel, notes, created_at, updated_at'
  async function fetchMenus(cols: string) {
    let q = db.from('menus').select(cols)
      .eq('business_id', businessId).is('archived_at', null).order('updated_at', { ascending: false })
    if (typeParam === 'food' || typeParam === 'drink') q = q.eq('type', typeParam)
    return q
  }
  let { data: menus, error } = await fetchMenus(COLS_WITH_IMG)
  if (error && /image_url.*does not exist/i.test(error.message)) {
    const retry = await fetchMenus(COLS_LEGACY)
    menus = retry.data?.map((m: any) => ({ ...m, image_url: null })) ?? null
    error = retry.error
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!menus || menus.length === 0) {
    return NextResponse.json({ menus: [] }, { headers: { 'Cache-Control': 'no-store' } })
  }

  // Fetch items for all menus
  const menuIds = menus.map((m: any) => m.id)
  const { data: items } = await db.from('menu_items')
    .select('id, menu_id, recipe_id, course_position, qty')
    .in('menu_id', menuIds).order('course_position')
  const itemsByMenu = new Map<string, any[]>()
  for (const it of items ?? []) {
    if (!itemsByMenu.has(it.menu_id)) itemsByMenu.set(it.menu_id, [])
    itemsByMenu.get(it.menu_id)!.push(it)
  }

  // Compute per-recipe food cost (one-shot)
  const recipeIds = Array.from(new Set((items ?? []).map((it: any) => it.recipe_id)))
  const fxIndex = await loadFxIndex(db, ['EUR', 'USD', 'NOK', 'DKK', 'GBP'])
  const recipeIndex = await loadRecipeIndex(db, businessId)
  // Pre-fetch product prices for ALL leaf products referenced anywhere in the recipe tree.
  // RECURSE into sub-recipes — without this, the engine's sub-recipe branch
  // looks up products that aren't in priceMap and reports them as no_price,
  // making the menu falsely look "incomplete".
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
  const priceMap = await getProductLatestPrices(db, businessId, Array.from(productIds), fxIndex)

  const summaries = menus.map((m: any) => {
    const its = itemsByMenu.get(m.id) ?? []
    let foodCost = 0
    let incomplete = false
    let missingPrices = 0
    let unitMismatches = 0
    for (const it of its) {
      const entry = recipeIndex.get(it.recipe_id)
      if (!entry) { incomplete = true; continue }
      const ings = entry.ingredients ?? []
      const cost = computeRecipeCost(ings, priceMap, null, { recipeIndex, recipeId: it.recipe_id })
      foodCost += Number(cost.food_cost ?? 0) * Number(it.qty ?? 1)
      missingPrices  += Number(cost.missing_prices  ?? 0)
      unitMismatches += Number(cost.unit_mismatches ?? 0)
      if ((cost.missing_prices ?? 0) > 0 || (cost.unit_mismatches ?? 0) > 0) incomplete = true
    }
    // Margin denominator priority: explicit ex-VAT → derive from menu_price (inc-VAT) ÷ (1 + vat_rate/100).
    // Owner often only enters the inc-VAT menu price; we don't want Cost % / GP % to go blank for that.
    const explicitEx = m.selling_price_ex_vat != null ? Number(m.selling_price_ex_vat) : null
    const vatRate    = m.vat_rate != null ? Number(m.vat_rate) : null
    const derivedEx  = explicitEx == null && m.menu_price != null && vatRate != null && vatRate >= 0
      ? Math.round((Number(m.menu_price) / (1 + vatRate / 100)) * 100) / 100
      : null
    const ex = explicitEx ?? derivedEx
    const gpKr  = ex != null ? Math.round((ex - foodCost) * 100) / 100 : null
    const gpPct = ex != null && ex > 0 ? Math.round(((ex - foodCost) / ex) * 1000) / 10 : null
    const costPct = ex != null && ex > 0 ? Math.round((foodCost / ex) * 1000) / 10 : null
    return {
      ...m,
      item_count:      its.length,
      food_cost:       Math.round(foodCost * 100) / 100,
      gp_kr:           gpKr,
      gp_pct:          gpPct,
      cost_pct:        costPct,
      missing_prices:  missingPrices,
      unit_mismatches: unitMismatches,
      incomplete,
    }
  })

  return NextResponse.json({ menus: summaries }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  const businessId = String(body.business_id ?? '').trim()
  const name       = String(body.name ?? '').trim()
  const type       = body.type === 'drink' ? 'drink' : 'food'
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!name)       return NextResponse.json({ error: 'name required' }, { status: 400 })
  if (name.length > 200) return NextResponse.json({ error: 'name too long' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('org_id').eq('id', businessId).maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  // Sensible default VAT: food menus 12% dine_in, drink menus 25% (alcohol-default).
  const vatRate = type === 'drink' ? 25 : 12

  const { data, error } = await db.from('menus')
    .insert({
      business_id: businessId,
      org_id:      biz.org_id,
      name,
      type,
      vat_rate:    vatRate,
      channel:     'dine_in',
    })
    .select('id, name, type, vat_rate, channel, created_at')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ menu: data }, { headers: { 'Cache-Control': 'no-store' } })
}
