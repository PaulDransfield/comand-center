// app/api/inventory/items/route.ts
//
// GET — full inventory catalogue for one business with price-tracking
// derivatives. For each product:
//   - latest observed price (price_per_unit on the most recent matched line)
//   - count of observations
//   - prior-window median price (30-90 days before latest)
//   - change_pct vs prior median
//   - latest supplier
//
// Used by /inventory/items list page and (eventually) the price-creep cron.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface CatalogueItem {
  product_id:           string
  name:                 string
  category:             string
  default_supplier:     string | null
  latest_price:         number | null
  latest_unit:          string | null
  latest_supplier:      string | null
  latest_date:          string | null
  prior_median_price:   number | null
  change_pct:           number | null     // (latest - prior_median) / prior_median
  observation_count:    number
  is_recipe_sourced:    boolean           // M089 — true when this product is a promoted recipe
  source_recipe_id:     string | null
}

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const businessId = String(url.searchParams.get('business_id') ?? '').trim()
  const categoryFilter = String(url.searchParams.get('category') ?? 'all').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // 1. Pull every product for this business.
  let qProducts = db
    .from('products')
    .select('id, name, category, default_supplier_fortnox_number, default_supplier_name, source_recipe_id')
    .eq('business_id', businessId)
    .is('archived_at', null)
    .order('name')
  if (categoryFilter !== 'all') qProducts = qProducts.eq('category', categoryFilter)

  const { data: products, error: pErr } = await qProducts
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 })

  if (!products || products.length === 0) {
    return NextResponse.json({
      counts: {},
      items: [],
      message: 'Catalogue is empty. Either PDF extraction is still running, or the matcher hasn\'t had inventory lines to dedupe yet.',
    }, { headers: { 'Cache-Control': 'no-store' } })
  }

  // 2. Pull every matched supplier_invoice_lines row for this business in
  //    one paginated sweep. For Chicce-scale (~3 k lines) this is cheap;
  //    a future migration to a Postgres view would speed up larger orgs.
  const allLines: any[] = []
  let from = 0
  while (true) {
    const { data, error } = await db
      .from('supplier_invoice_lines')
      .select('product_alias_id, price_per_unit, quantity, unit, invoice_date, supplier_name_snapshot, fortnox_invoice_number')
      .eq('business_id', businessId)
      .eq('match_status', 'matched')
      .not('product_alias_id', 'is', null)
      .order('invoice_date', { ascending: false })
      .range(from, from + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data || data.length === 0) break
    allLines.push(...data)
    if (data.length < 1000) break
    from += 1000
    if (from > 50_000) break
  }

  // 3. Resolve product_alias_id → product_id via product_aliases.
  const aliasIds = Array.from(new Set(allLines.map(l => l.product_alias_id).filter(Boolean)))
  const aliasToProduct = new Map<string, string>()
  if (aliasIds.length > 0) {
    // pg has a limit on .in() — chunk in batches of 500.
    for (let i = 0; i < aliasIds.length; i += 500) {
      const slice = aliasIds.slice(i, i + 500)
      const { data: aliases } = await db
        .from('product_aliases')
        .select('id, product_id')
        .in('id', slice)
      for (const a of aliases ?? []) aliasToProduct.set(a.id, a.product_id)
    }
  }

  // 4. Aggregate per product.
  const NOW = Date.now()
  const NINETY_DAYS_MS = 90 * 86_400_000
  const linesByProduct = new Map<string, any[]>()
  for (const l of allLines) {
    const pid = aliasToProduct.get(l.product_alias_id)
    if (!pid) continue
    if (!linesByProduct.has(pid)) linesByProduct.set(pid, [])
    linesByProduct.get(pid)!.push(l)
  }

  const items: CatalogueItem[] = products.map((p: any) => {
    const lines = (linesByProduct.get(p.id) ?? []).slice().sort((a, b) =>
      (b.invoice_date ?? '').localeCompare(a.invoice_date ?? '')
    )
    if (lines.length === 0) {
      return {
        product_id:         p.id,
        name:               p.name,
        category:           p.category,
        default_supplier:   p.default_supplier_name,
        latest_price:       null,
        latest_unit:        null,
        latest_supplier:    null,
        latest_date:        null,
        prior_median_price: null,
        change_pct:         null,
        observation_count:  0,
        is_recipe_sourced:  !!p.source_recipe_id,
        source_recipe_id:   p.source_recipe_id ?? null,
      }
    }
    const latest = lines[0]
    // prior-median: lines older than the latest, within 90 days before the latest
    const latestTs = new Date(latest.invoice_date).getTime()
    const cutoffTs = latestTs - NINETY_DAYS_MS
    const priorPrices = lines.slice(1)
      .filter(l => {
        const t = new Date(l.invoice_date).getTime()
        return t < latestTs && t >= cutoffTs && l.price_per_unit != null
      })
      .map(l => Number(l.price_per_unit))
    const priorMedian = priorPrices.length > 0
      ? median(priorPrices)
      : null
    const changePct = priorMedian != null && priorMedian !== 0 && latest.price_per_unit != null
      ? (Number(latest.price_per_unit) - priorMedian) / priorMedian
      : null
    return {
      product_id:         p.id,
      name:               p.name,
      category:           p.category,
      default_supplier:   p.default_supplier_name,
      latest_price:       latest.price_per_unit != null ? Number(latest.price_per_unit) : null,
      latest_unit:        latest.unit,
      latest_supplier:    latest.supplier_name_snapshot,
      latest_date:        latest.invoice_date,
      prior_median_price: priorMedian,
      change_pct:         changePct,
      observation_count:  lines.length,
      is_recipe_sourced:  !!p.source_recipe_id,
      source_recipe_id:   p.source_recipe_id ?? null,
    }
  })

  // Recipe-sourced products won't have supplier_invoice_lines, so their
  // latest_price slot is currently null. Fill from the linked recipes'
  // current cost-per-portion (food_cost / portions). Single batched
  // query for all linked recipes.
  const recipeIds = items.filter(i => i.is_recipe_sourced && i.source_recipe_id).map(i => i.source_recipe_id!) as string[]
  if (recipeIds.length > 0) {
    // Pull each recipe's food_cost via the cost helper. To avoid pulling
    // every recipe in the business twice, we'll compute inline.
    const { loadRecipeIndex, getProductLatestPrices, computeRecipeCost } = await import('@/lib/inventory/recipe-cost')
    const { loadFxIndex } = await import('@/lib/inventory/fx')
    const fxIndex = await loadFxIndex(db, ['EUR', 'USD', 'NOK', 'DKK', 'GBP'])
    const recipeIndex = await loadRecipeIndex(db, businessId)
    const allLeafProductIds = new Set<string>()
    for (const entry of recipeIndex.values()) {
      for (const ing of entry.ingredients) if (ing.product_id) allLeafProductIds.add(ing.product_id)
    }
    const priceMap = await getProductLatestPrices(db, businessId, Array.from(allLeafProductIds), fxIndex)
    for (const it of items) {
      if (!it.is_recipe_sourced || !it.source_recipe_id) continue
      const entry = recipeIndex.get(it.source_recipe_id)
      if (!entry) continue
      const summary = computeRecipeCost(entry.ingredients, priceMap, null, {
        recipeIndex, recipeId: it.source_recipe_id,
      })
      const portions = Math.max(1, entry.portions)
      it.latest_price = Math.round((summary.food_cost / portions) * 100) / 100
      it.latest_unit  = 'portion'
    }
  }

  // Counts by category for filter tabs
  const counts: Record<string, number> = { all: items.length }
  for (const i of items) counts[i.category] = (counts[i.category] ?? 0) + 1

  return NextResponse.json({
    counts,
    items,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}
