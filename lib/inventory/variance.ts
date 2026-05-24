// lib/inventory/variance.ts
//
// THE VARIANCE LOOP. This is what makes the inventory data valuable.
// Computes theoretical product draw (POS sales × recipes) vs actual
// product draw (purchases − waste, optionally adjusted by stock counts)
// for a given (business, date range). Surfaces shrinkage / over-portion
// / theft signals to the owner.
//
// Inputs we need (all already in the DB):
//   - pos_sales × pos_menu_items.recipe_id × recipe_ingredients
//       → theoretical usage per base_unit per product
//   - supplier_invoice_lines (M078)         → purchases per product
//   - waste_log (M093)                       → wasted per product
//   - stock_count_lines (M092, optional)     → count deltas
//
// Output: array of per-product rows + summary KPIs.

import { loadRecipeIndex, type RecipeIndex } from './recipe-cost'
import { canonicalUnit, convertQuantity } from './unit-conversion'

export interface VarianceProductRow {
  product_id:         string
  product_name:       string | null
  category:           string | null
  base_unit:          string | null   // 'g' / 'ml' / 'st'
  /** Sum of ingredient consumption implied by POS sales × recipes. In base_unit. */
  theoretical_used:   number
  /** Sum of purchases (supplier_invoice_lines) over the range. In base_unit. */
  purchased:          number
  /** Sum of waste_log over the range. In base_unit. */
  wasted:             number
  /** purchased − wasted: the amount of stock that physically "entered usable inventory" in the range. */
  net_inflow:         number
  /** If a stock count exists before AND after the range, we can refine:
   *  consumed_physically = last_count + purchased − this_count − wasted.
   *  Else falls back to net_inflow (assumes nothing left in stock at period
   *  end — noisy, but the only signal we have without regular counts). */
  count_adjusted:     boolean
  /** consumed_physically (when counts available) OR net_inflow. */
  actual_used:        number
  /** actual_used − theoretical_used. Positive = SHRINKAGE (more drained
   *  than recipes account for). Negative = under-pull (over-counted, or
   *  recipes overstate the qty per portion). */
  variance_qty:       number
  variance_pct:       number | null     // |variance| / theoretical, capped at ±999%
  /** SEK value of the variance based on current product cost. */
  variance_value_sek: number | null
}

export interface VarianceSummary {
  range_from:       string
  range_to:         string
  products_total:   number
  /** Products where the absolute variance is over 10 % of theoretical. */
  products_warning: number
  total_theoretical_value_sek: number
  total_actual_value_sek:      number
  total_variance_value_sek:    number     // positive = net shrinkage in SEK
  /** True when we have at least one POS sale in the range. Without sales,
   *  theoretical_used will be zero across the board and the report is
   *  uninteresting. */
  has_sales:        boolean
}

export interface VarianceResult {
  summary:  VarianceSummary
  rows:     VarianceProductRow[]
}

const VARIANCE_WARNING_PCT = 0.10

// ─────────────────────────────────────────────────────────────────────
// Theoretical: POS sales × recipes → per-product base_unit consumption.
// ─────────────────────────────────────────────────────────────────────

/**
 * Recursively walk a recipe's ingredients. Sub-recipes are scaled by
 * (sold_qty / portions) at each level. Cycle detection via ancestor stack.
 */
function accumulateRecipeDraw(
  recipeId:    string,
  scale:       number,           // multiplier from caller (e.g. 10 sold ÷ 4 portions = 2.5)
  recipeIndex: RecipeIndex,
  out:         Map<string, number>,   // product_id → quantity (in product's invoice_unit, NOT yet base-unit-converted)
  ancestors:   Set<string>,
): void {
  if (ancestors.has(recipeId)) return     // cycle — silently skip
  const entry = recipeIndex.get(recipeId)
  if (!entry) return
  ancestors.add(recipeId)
  for (const ing of entry.ingredients) {
    if (ing.product_id) {
      const qty = Number(ing.quantity ?? 0) * scale
      out.set(ing.product_id, (out.get(ing.product_id) ?? 0) + qty)
    } else if (ing.subrecipe_id) {
      const sub = recipeIndex.get(ing.subrecipe_id)
      if (!sub) continue
      // Sub-recipe quantity is "portions of sub-recipe per portion of parent" by convention.
      const subScale = (Number(ing.quantity ?? 0) / Math.max(1, Number(sub.portions ?? 1))) * scale
      accumulateRecipeDraw(ing.subrecipe_id, subScale, recipeIndex, out, ancestors)
    }
  }
  ancestors.delete(recipeId)
}

// ─────────────────────────────────────────────────────────────────────
// Public entry — compute the full report.
// ─────────────────────────────────────────────────────────────────────

export async function computeVariance(
  db:         any,
  businessId: string,
  fromIso:    string,    // YYYY-MM-DD inclusive
  toIso:      string,    // YYYY-MM-DD inclusive
): Promise<VarianceResult> {
  // 1. POS sales in range, joined to menu items with recipe links.
  const { data: sales } = await db
    .from('pos_sales')
    .select(`
      quantity,
      pos_item:pos_menu_items ( id, recipe_id )
    `)
    .eq('business_id', businessId)
    .gte('sold_date', fromIso)
    .lte('sold_date', toIso)

  // Aggregate sales by recipe_id (only mapped items contribute to theoretical).
  const soldByRecipe = new Map<string, number>()
  for (const row of (sales ?? [])) {
    const item = (row as any).pos_item
    const recipeId = item?.recipe_id
    if (!recipeId) continue
    const q = Number((row as any).quantity ?? 0)
    if (!Number.isFinite(q) || q <= 0) continue
    soldByRecipe.set(recipeId, (soldByRecipe.get(recipeId) ?? 0) + q)
  }

  const hasSales = soldByRecipe.size > 0

  // 2. Expand recipes → per-product theoretical draw (in invoice_unit).
  const recipeIndex = await loadRecipeIndex(db, businessId)
  const theoreticalByProduct = new Map<string, number>()
  for (const [recipeId, soldQty] of soldByRecipe) {
    const entry = recipeIndex.get(recipeId)
    if (!entry) continue
    const scale = soldQty / Math.max(1, Number(entry.portions ?? 1))
    accumulateRecipeDraw(recipeId, scale, recipeIndex, theoreticalByProduct, new Set())
  }

  // 3. Load every product in scope: any product referenced in a recipe
  //    OR purchased in the range OR wasted in the range. Get
  //    pack_size + base_unit + latest cost in one shot.
  const productIds = new Set<string>(theoreticalByProduct.keys())

  // Pull purchases in range.
  const { data: purchases } = await db
    .from('supplier_invoice_lines')
    .select('product_id, quantity, unit, total_excl_vat, price_per_unit, invoice_date')
    .eq('business_id', businessId)
    .not('product_id', 'is', null)
    .gte('invoice_date', fromIso)
    .lte('invoice_date', toIso)
  for (const row of (purchases ?? [])) productIds.add((row as any).product_id)

  // Pull waste in range.
  const { data: wastes } = await db
    .from('waste_log')
    .select('product_id, quantity, unit, unit_price_at_entry')
    .eq('business_id', businessId)
    .not('product_id', 'is', null)
    .gte('waste_date', fromIso)
    .lte('waste_date', toIso)
  for (const row of (wastes ?? [])) productIds.add((row as any).product_id)

  if (productIds.size === 0) {
    return {
      summary: {
        range_from: fromIso, range_to: toIso,
        products_total: 0, products_warning: 0,
        total_theoretical_value_sek: 0,
        total_actual_value_sek:      0,
        total_variance_value_sek:    0,
        has_sales: hasSales,
      },
      rows: [],
    }
  }

  // 4. Load product metadata (pack_size, base_unit, latest unit cost).
  const { data: prodRows } = await db
    .from('products')
    .select('id, name, category, invoice_unit, pack_size, base_unit, latest_price, latest_price_sek')
    .in('id', Array.from(productIds))
  const prodById = new Map<string, any>()
  for (const p of (prodRows ?? [])) prodById.set(p.id, p)

  // 5. Sum purchases & waste per product, in base_unit when possible.
  const purchasedByProduct = new Map<string, number>()
  for (const row of (purchases ?? [])) {
    const r: any = row
    const p = prodById.get(r.product_id)
    if (!p) continue
    const baseQty = toBaseUnit(Number(r.quantity ?? 0), r.unit, p)
    if (baseQty == null) continue
    purchasedByProduct.set(r.product_id, (purchasedByProduct.get(r.product_id) ?? 0) + baseQty)
  }
  const wastedByProduct = new Map<string, number>()
  for (const row of (wastes ?? [])) {
    const r: any = row
    const p = prodById.get(r.product_id)
    if (!p) continue
    const baseQty = toBaseUnit(Number(r.quantity ?? 0), r.unit, p)
    if (baseQty == null) continue
    wastedByProduct.set(r.product_id, (wastedByProduct.get(r.product_id) ?? 0) + baseQty)
  }

  // 6. Optional count-delta refinement. Skip in v1 — counts are sporadic
  //    and the math gets noisy. Owner can add this later when there's a
  //    cadence of weekly counts to anchor against.
  const countAdjusted = false

  // 7. Assemble rows.
  const rows: VarianceProductRow[] = []
  let totalTheoreticalValueSek = 0
  let totalActualValueSek      = 0
  for (const productId of productIds) {
    const p = prodById.get(productId)
    if (!p) continue

    // Convert theoretical from invoice_unit to base_unit if we have pack info.
    const theoreticalInvoiceUnit = theoreticalByProduct.get(productId) ?? 0
    const theoreticalBase = theoreticalInvoiceUnit * (Number(p.pack_size) || 1)

    const purchased = purchasedByProduct.get(productId) ?? 0
    const wasted    = wastedByProduct.get(productId) ?? 0
    const netInflow = purchased - wasted
    const actual    = netInflow   // v1: no count adjustment

    const variance = actual - theoreticalBase
    const variancePct = theoreticalBase > 0
      ? Math.min(9.99, Math.max(-9.99, variance / theoreticalBase))
      : null

    // Per-base-unit cost from product.latest_price_sek / pack_size.
    let costPerBaseUnit: number | null = null
    if (p.latest_price_sek != null && p.pack_size && Number(p.pack_size) > 0) {
      costPerBaseUnit = Number(p.latest_price_sek) / Number(p.pack_size)
    } else if (p.latest_price != null && p.pack_size && Number(p.pack_size) > 0) {
      costPerBaseUnit = Number(p.latest_price) / Number(p.pack_size)
    }
    const varianceValue   = costPerBaseUnit != null ? variance * costPerBaseUnit         : null
    const theoreticalVal  = costPerBaseUnit != null ? theoreticalBase * costPerBaseUnit  : null
    const actualVal       = costPerBaseUnit != null ? actual * costPerBaseUnit           : null
    if (theoreticalVal != null) totalTheoreticalValueSek += theoreticalVal
    if (actualVal      != null) totalActualValueSek      += actualVal

    rows.push({
      product_id:         productId,
      product_name:       p.name ?? null,
      category:           p.category ?? null,
      base_unit:          p.base_unit ?? null,
      theoretical_used:   theoreticalBase,
      purchased,
      wasted,
      net_inflow:         netInflow,
      count_adjusted:     countAdjusted,
      actual_used:        actual,
      variance_qty:       variance,
      variance_pct:       variancePct,
      variance_value_sek: varianceValue,
    })
  }

  // Sort by abs SEK variance descending — biggest signals on top.
  rows.sort((a, b) => Math.abs(b.variance_value_sek ?? 0) - Math.abs(a.variance_value_sek ?? 0))

  const productsWarning = rows.filter(r => r.variance_pct != null && Math.abs(r.variance_pct) >= VARIANCE_WARNING_PCT).length

  return {
    summary: {
      range_from: fromIso,
      range_to:   toIso,
      products_total:   rows.length,
      products_warning: productsWarning,
      total_theoretical_value_sek: totalTheoreticalValueSek,
      total_actual_value_sek:      totalActualValueSek,
      total_variance_value_sek:    totalActualValueSek - totalTheoreticalValueSek,
      has_sales:        hasSales,
    },
    rows,
  }
}

/**
 * Convert a (quantity, unit) pair into the product's base_unit. Returns
 * null when the conversion can't be done (different unit family, no pack
 * info to convert 'st' invoice unit to base_unit grams, etc.).
 */
function toBaseUnit(qty: number, unit: string | null, product: any): number | null {
  if (!Number.isFinite(qty)) return null
  const baseUnit = product.base_unit as string | null
  if (!baseUnit) return null
  const u = canonicalUnit(unit ?? '')

  // Same family (g↔kg, ml↔l): use convertQuantity directly.
  const direct = convertQuantity(qty, u, baseUnit)
  if (direct != null) return direct

  // Cross-family via pack_size: invoice qty is 'st' but base_unit is 'g'.
  // E.g. 2 st × 1000 g/st = 2000 g.
  if (product.pack_size && Number(product.pack_size) > 0) {
    return qty * Number(product.pack_size)
  }
  return null
}
