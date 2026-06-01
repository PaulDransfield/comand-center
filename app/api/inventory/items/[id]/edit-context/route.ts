// app/api/inventory/items/[id]/edit-context/route.ts
//
// GET — one-shot read for the Edit-Item modal. Returns the product, its
// latest cost, the price trend (or null = honest absence), the reliability
// signal, every active alias connected to it (with supplier + latest
// price), and every recipe that uses this product (direct AND transitive
// via sub-recipes).
//
// Designed so the modal opens with ONE round-trip rather than four
// sequential fetches — snappy open is a UX requirement at this surface.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import {
  getProductLatestPrices,
  getProductPriceTrend,
  getProductReliabilitySignal,
  loadRecipeIndex,
} from '@/lib/inventory/recipe-cost'
import { loadFxIndex } from '@/lib/inventory/fx'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: product, error: pErr } = await db
    .from('products')
    .select('id, business_id, org_id, name, category, invoice_unit, pack_size, base_unit, default_supplier_name, default_supplier_fortnox_number, price_override, price_override_currency, default_waste_pct, archived_at, created_at, updated_at')
    .eq('id', params.id)
    .maybeSingle()
  if (pErr)    return NextResponse.json({ error: pErr.message }, { status: 500 })
  if (!product) return NextResponse.json({ error: 'product not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, product.business_id)
  if (forbidden) return forbidden

  // Latest cost — same reader the recipe drawer uses, so the modal can
  // never show a different cost than what cost recipes are computed at.
  const fxIndex   = await loadFxIndex(db, ['EUR', 'USD', 'NOK', 'DKK', 'GBP'])
  const priceMap  = await getProductLatestPrices(db, product.business_id, [product.id], fxIndex)
  const latest    = priceMap.get(product.id) ?? null

  // Trend reader — null when too little history. UI MUST render that as
  // honest absence ("ingen prishistorik"), not "0.0% stable".
  const trend = await getProductPriceTrend(db, product.business_id, product.id, 7)

  // Reliability signal — first-class. If false, UI MUST show the reason
  // instead of a confident price.
  const reliability = await getProductReliabilitySignal(db, product.business_id, product.id)

  // Active aliases — the supplier-article connection layer. For each,
  // surface latest price + invoice_date so the owner can see which
  // article is feeding which price.
  const { data: aliases } = await db
    .from('product_aliases')
    .select('id, supplier_fortnox_number, supplier_name_snapshot, article_number, raw_description, normalised_description, unit, match_method, match_confidence, first_seen_at, last_seen_at, seen_count')
    .eq('business_id', product.business_id)
    .eq('product_id', product.id)
    .eq('is_active', true)
    .order('last_seen_at', { ascending: false })

  // For each alias, pull the most-recent matched line for "latest price
  // per alias" — useful when one product is fed by multiple suppliers and
  // their prices differ.
  let aliasesWithPrice: any[] = []
  if (aliases && aliases.length > 0) {
    const aliasIds = aliases.map(a => a.id)
    // One query batched across aliases — order by date desc + select first
    // per alias in JS, since PostgREST has no per-group LIMIT.
    const { data: lines } = await db
      .from('supplier_invoice_lines')
      .select('product_alias_id, invoice_date, quantity, price_per_unit, total_excl_vat, currency, fortnox_invoice_number')
      .eq('business_id', product.business_id)
      .eq('match_status', 'matched')
      .in('product_alias_id', aliasIds)
      .order('invoice_date', { ascending: false })
      .limit(500)
    const latestByAlias = new Map<string, any>()
    for (const l of lines ?? []) {
      if (!latestByAlias.has(l.product_alias_id)) latestByAlias.set(l.product_alias_id, l)
    }
    aliasesWithPrice = aliases.map(a => {
      const l = latestByAlias.get(a.id)
      const qty = Number(l?.quantity ?? 0)
      const tot = Number(l?.total_excl_vat ?? 0)
      const derivedPpu = Number.isFinite(qty) && qty > 0 && Number.isFinite(tot) && tot !== 0
        ? Math.round((tot / qty) * 100) / 100
        : (l?.price_per_unit != null ? Number(l.price_per_unit) : null)
      return {
        ...a,
        latest_price:    derivedPpu,
        latest_currency: l?.currency ?? 'SEK',
        latest_date:     l?.invoice_date ?? null,
        latest_invoice:  l?.fortnox_invoice_number ?? null,
      }
    })
  }

  // Used-in-recipes — direct + transitive via sub-recipes. loadRecipeIndex
  // builds the whole graph once; we walk it to find every recipe whose
  // ingredient tree contains this product. O(recipes × ingredients) — fine
  // at 500+ recipes per business.
  const recipeIndex = await loadRecipeIndex(db, product.business_id)
  const usedInRecipes: any[] = []
  // Build a recipe-name lookup since loadRecipeIndex doesn't carry names
  const { data: recipes } = await db
    .from('recipes')
    .select('id, name, type, menu_price, selling_price_ex_vat, portions, archived_at')
    .eq('business_id', product.business_id)
    .is('archived_at', null)
  const nameById = new Map((recipes ?? []).map((r: any) => [r.id, r]))

  for (const [recipeId, entry] of recipeIndex.entries()) {
    let directQty:    number | null = null
    let directUnit:   string | null = null
    let directWaste:  number | null = null
    let transitive   = false
    for (const ing of entry.ingredients) {
      if (ing.product_id === product.id) {
        directQty   = ing.quantity_stated ?? ing.quantity
        directUnit  = ing.unit
        directWaste = ing.waste_pct
      }
      if (ing.subrecipe_id) {
        // Walk transitively. Mark transitive=true if any descendant
        // contains this product. Bounded by recipe depth.
        const stack = [ing.subrecipe_id]
        const seen  = new Set<string>()
        while (stack.length > 0) {
          const cur = stack.pop()!
          if (seen.has(cur)) continue
          seen.add(cur)
          const subEntry = recipeIndex.get(cur)
          if (!subEntry) continue
          for (const subIng of subEntry.ingredients) {
            if (subIng.product_id === product.id) { transitive = true; break }
            if (subIng.subrecipe_id) stack.push(subIng.subrecipe_id)
          }
          if (transitive) break
        }
      }
    }
    if (directQty != null || transitive) {
      const r = nameById.get(recipeId) as any
      if (!r) continue
      usedInRecipes.push({
        recipe_id:    recipeId,
        name:         r.name,
        type:         r.type,
        portions:     r.portions,
        direct:       directQty != null,
        direct_qty:   directQty,
        direct_unit:  directUnit,
        direct_waste_pct: directWaste,
        transitive,
      })
    }
  }
  // Sort: direct usages first (highest impact), then transitive.
  usedInRecipes.sort((a, b) => {
    if (a.direct && !b.direct) return -1
    if (!a.direct && b.direct) return 1
    return String(a.name).localeCompare(String(b.name))
  })

  return NextResponse.json({
    product:    {
      ...product,
      default_waste_pct: product.default_waste_pct != null ? Number(product.default_waste_pct) : 0,
    },
    latest_cost: latest ? {
      unit_price:       latest.latest_price,
      latest_price_sek: latest.latest_price_sek,
      invoice_unit:     latest.invoice_unit,
      pack_size:        latest.pack_size,
      base_unit:        latest.base_unit,
      cost_per_base_unit: latest.pack_size && latest.pack_size > 0 && latest.latest_price_sek != null
        ? Math.round((latest.latest_price_sek / latest.pack_size) * 10000) / 10000
        : null,
      latest_date:      latest.latest_date,
      latest_currency:  latest.latest_currency,
      fx_rate_used:     latest.fx_rate_used,
    } : null,
    trend,
    reliability,
    aliases:    aliasesWithPrice,
    used_in_recipes: usedInRecipes,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
