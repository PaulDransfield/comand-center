// lib/data-quality/score.ts
//
// A1.9 — Data quality engine. Single 0-100 score per business + a
// breakdown across five dimensions. Owners use this to decide whether
// to trust the numbers BEFORE acting on a forecast, budget, or AI
// recommendation. Each dimension is a percentage 0-100; the overall
// score is the equal-weighted mean.
//
// Honest-incomplete rule: when a dimension has zero in-scope items
// (no recipes yet, no products in food/bev/alcohol, etc.) its
// `total` is 0 and the dimension drops out of the overall mean
// rather than being scored as 100 % or 0 %. The UI surfaces it as
// "not applicable yet" + a CTA.
//
// Dimensions:
//   closed_pl         — % of last 12 closed months with non-provisional tracker_data
//   products_costed   — % of food/bev/alcohol products with at least one priced supplier line
//   recipes_priced    — % of priced dishes whose cost computes without missing_prices/unit_mismatches
//   lines_matched     — % of inventory-eligible supplier_invoice_lines with match_status='matched'
//   products_classified — M137 — % of food/bev/alcohol products with a sub_category set
//
// Pure-compute. Caller passes in a Supabase admin client (RLS bypass)
// and a business_id; engine runs the five reads in parallel and returns
// the score object.

import type { SupabaseClient } from '@supabase/supabase-js'

export interface DimensionResult {
  key:           DimensionKey
  label:         string
  score:         number | null    // 0..100, or null when total === 0 ("not applicable yet")
  count:         number           // numerator
  total:         number           // denominator (0 means n/a)
  hint:          string           // owner-facing one-liner
  action_label:  string           // CTA text
  action_href:   string           // CTA target
}

export type DimensionKey =
  | 'closed_pl'
  | 'products_costed'
  | 'recipes_priced'
  | 'lines_matched'
  | 'products_classified'

export interface DataQualityScore {
  business_id:     string
  overall_score:   number | null         // 0..100, equal-weighted mean of applicable dimensions
  applicable:      number                // count of dimensions where total > 0
  dimensions:      DimensionResult[]
  computed_at:     string                // ISO timestamp
}

const PRODUCT_CATEGORIES = ['food', 'beverage', 'alcohol']

export async function computeDataQualityScore(
  db:         SupabaseClient,
  businessId: string,
): Promise<DataQualityScore> {
  // Run the five dimension reads in parallel — each is independent.
  const [closedPl, costed, priced, matched, classified] = await Promise.all([
    scoreClosedPl(db, businessId),
    scoreProductsCosted(db, businessId),
    scoreRecipesPriced(db, businessId),
    scoreLinesMatched(db, businessId),
    scoreProductsClassified(db, businessId),
  ])

  const dimensions = [closedPl, costed, priced, matched, classified]
  const applicable = dimensions.filter(d => d.total > 0 && d.score !== null)
  const overall_score = applicable.length === 0
    ? null
    : Math.round(applicable.reduce((s, d) => s + (d.score ?? 0), 0) / applicable.length)

  return {
    business_id:    businessId,
    overall_score,
    applicable:     applicable.length,
    dimensions,
    computed_at:    new Date().toISOString(),
  }
}

// ── Dimension 1 — closed P&L months ──────────────────────────────────
// Looks at the last 12 completed months (today's month is excluded —
// it's still open). A month "counts" if tracker_data has a row with
// is_provisional null/false. Aggregator-written rows are not
// provisional by default; manual P&L tracker also writes
// is_provisional=false on save.
async function scoreClosedPl(db: SupabaseClient, businessId: string): Promise<DimensionResult> {
  const now = new Date()
  // Window: previous 12 completed months. e.g. on 2026-06-08 we count
  // 2025-06 through 2026-05 (12 entries). Current month excluded.
  const months: Array<{ year: number; month: number }> = []
  for (let i = 1; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1 })
  }
  const startYear  = months[months.length - 1].year
  const startMonth = months[months.length - 1].month
  const endYear    = months[0].year
  const endMonth   = months[0].month

  // Single read: any tracker_data rows in the window for this business.
  // is_provisional filter mirrors tracker_data_provisional_filter memory
  // (or `null`/`false`).
  const { data, error } = await db
    .from('tracker_data')
    .select('period_year, period_month, is_provisional')
    .eq('business_id', businessId)
    .or(`and(period_year.eq.${startYear},period_month.gte.${startMonth}),and(period_year.gt.${startYear},period_year.lt.${endYear}),and(period_year.eq.${endYear},period_month.lte.${endMonth})`)
    .limit(48)

  if (error) {
    return {
      key:          'closed_pl',
      label:        'Closed monthly P&L',
      score:        null,
      count:        0,
      total:        12,
      hint:         `Couldn\'t read tracker_data: ${error.message}`,
      action_label: 'Open tracker',
      action_href:  '/tracker',
    }
  }

  const closedKeys = new Set<string>()
  for (const r of data ?? []) {
    const prov = (r as any).is_provisional
    if (prov === true) continue
    closedKeys.add(`${(r as any).period_year}-${(r as any).period_month}`)
  }
  const closed = months.filter(m => closedKeys.has(`${m.year}-${m.month}`)).length

  return {
    key:          'closed_pl',
    label:        'Closed monthly P&L',
    score:        Math.round((closed / 12) * 100),
    count:        closed,
    total:        12,
    hint:         closed === 12
                    ? 'Last 12 months are all closed.'
                    : `${12 - closed} of the last 12 months not yet closed.`,
    action_label: 'Open tracker',
    action_href:  '/tracker',
  }
}

// ── Dimension 2 — products with cost ────────────────────────────────
// A product is "costed" if it has at least one active alias and the
// supplier_invoice_lines join surfaces a non-null price. We approximate
// via product_aliases.is_active + the aliased product showing latest
// price on supplier_invoice_lines. Cheaper: count products that have
// ANY active alias at all (alias presence is strongly correlated with
// price availability post-M150 auto-repointer).
async function scoreProductsCosted(db: SupabaseClient, businessId: string): Promise<DimensionResult> {
  // Total in-scope products
  const { count: total, error: tErr } = await db
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .is('archived_at', null)
    .in('category', PRODUCT_CATEGORIES)

  if (tErr) {
    return blankDim('products_costed', 'Products with cost', `Couldn\'t read products: ${tErr.message}`, '/inventory/items')
  }
  if (!total || total === 0) {
    return {
      key:          'products_costed',
      label:        'Products with cost',
      score:        null,
      count:        0,
      total:        0,
      hint:         'No food/beverage/alcohol products in catalogue yet.',
      action_label: 'Connect Fortnox',
      action_href:  '/integrations',
    }
  }

  // Costed: product has at least one active alias. Distinct product_ids.
  const { data: alRows, error: aErr } = await db
    .from('product_aliases')
    .select('product_id')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .limit(10000)

  if (aErr) {
    return blankDim('products_costed', 'Products with cost', `Couldn\'t read product_aliases: ${aErr.message}`, '/inventory/items')
  }

  const costedIds = new Set<string>((alRows ?? []).map((r: any) => r.product_id))
  // Filter costedIds against in-scope category list — only count
  // food/bev/alcohol products as "costed" toward this dimension.
  const idsArray = Array.from(costedIds)
  let costed = 0
  if (idsArray.length > 0) {
    // Batch in 100 (canonical Supabase .in() cap from memory).
    const BATCH = 100
    for (let i = 0; i < idsArray.length; i += BATCH) {
      const slice = idsArray.slice(i, i + BATCH)
      const { count: c } = await db
        .from('products')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .is('archived_at', null)
        .in('category', PRODUCT_CATEGORIES)
        .in('id', slice)
      costed += c ?? 0
    }
  }

  const uncosted = total - costed
  return {
    key:          'products_costed',
    label:        'Products with cost',
    score:        Math.round((costed / total) * 100),
    count:        costed,
    total,
    hint:         uncosted === 0
                    ? 'Every product has at least one supplier link.'
                    : `${uncosted} of ${total} products have no supplier price yet.`,
    action_label: 'Open articles',
    action_href:  '/inventory/items?filter=no_price',
  }
}

// ── Dimension 3 — recipes priced ────────────────────────────────────
// A recipe counts as "priced" when:
//   - it's a dish (selling_price_ex_vat > 0 OR has a dish-shaped type)
//   - it has at least one ingredient row
//   - none of its ingredients are missing prices or have unit_mismatches
//
// Implementation: rough check via the recipe rows + ingredient row
// presence. We don't run the full computeRecipeCost engine here — too
// expensive at scale. The "no missing prices" check is approximate:
// every recipe ingredient.product_id resolves to a product that has
// an active alias.
async function scoreRecipesPriced(db: SupabaseClient, businessId: string): Promise<DimensionResult> {
  const DISH_TYPES = ['starter', 'main', 'pasta', 'pizza', 'dessert', 'drink', 'cocktail', 'side']

  // All non-archived recipes at this business that are dishes.
  const { data: recipes, error: rErr } = await db
    .from('recipes')
    .select('id, type, selling_price_ex_vat, menu_price, archived_at')
    .eq('business_id', businessId)
    .is('archived_at', null)
    .limit(5000)

  if (rErr) {
    return blankDim('recipes_priced', 'Recipes priced', `Couldn\'t read recipes: ${rErr.message}`, '/recipes')
  }

  const isDish = (r: any) => Number(r.selling_price_ex_vat ?? 0) > 0
                          || Number(r.menu_price ?? 0) > 0
                          || (r.type && DISH_TYPES.includes(r.type))
  const dishes = (recipes ?? []).filter(isDish)
  const total = dishes.length
  if (total === 0) {
    return {
      key:          'recipes_priced',
      label:        'Recipes priced',
      score:        null,
      count:        0,
      total:        0,
      hint:         'No dish recipes yet.',
      action_label: 'Add a recipe',
      action_href:  '/recipes',
    }
  }

  // Ingredient counts per dish recipe + product_ids referenced.
  const dishIds = dishes.map(d => (d as any).id)
  const ingredientsByRecipe = new Map<string, Array<{ product_id: string | null; subrecipe_id: string | null }>>()
  const allProductIds = new Set<string>()
  const BATCH = 100
  for (let i = 0; i < dishIds.length; i += BATCH) {
    const slice = dishIds.slice(i, i + BATCH)
    const { data: rows } = await db
      .from('recipe_ingredients')
      .select('recipe_id, product_id, subrecipe_id')
      .in('recipe_id', slice)
    for (const row of rows ?? []) {
      const rid = (row as any).recipe_id
      if (!ingredientsByRecipe.has(rid)) ingredientsByRecipe.set(rid, [])
      ingredientsByRecipe.get(rid)!.push({
        product_id:   (row as any).product_id,
        subrecipe_id: (row as any).subrecipe_id,
      })
      if ((row as any).product_id) allProductIds.add((row as any).product_id)
    }
  }

  // Which referenced products have an active alias (proxy for "has price").
  const pricedProductIds = new Set<string>()
  const productIdArr = Array.from(allProductIds)
  for (let i = 0; i < productIdArr.length; i += BATCH) {
    const slice = productIdArr.slice(i, i + BATCH)
    const { data: aliases } = await db
      .from('product_aliases')
      .select('product_id')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .in('product_id', slice)
    for (const a of aliases ?? []) pricedProductIds.add((a as any).product_id)
  }

  let priced = 0
  for (const d of dishes) {
    const ings = ingredientsByRecipe.get((d as any).id) ?? []
    if (ings.length === 0) continue
    let complete = true
    for (const ing of ings) {
      if (ing.product_id) {
        if (!pricedProductIds.has(ing.product_id)) { complete = false; break }
      }
      // Sub-recipe ingredients don't get checked here — too expensive
      // to recurse. We assume sub-recipes are priced; engine surfaces
      // the gap if not.
    }
    if (complete) priced++
  }

  const unpriced = total - priced
  return {
    key:          'recipes_priced',
    label:        'Recipes priced',
    score:        Math.round((priced / total) * 100),
    count:        priced,
    total,
    hint:         unpriced === 0
                    ? 'Every dish recipe has full ingredient pricing.'
                    : `${unpriced} of ${total} dishes have at least one unpriced ingredient.`,
    action_label: 'Open recipes',
    action_href:  '/recipes',
  }
}

// ── Dimension 4 — supplier lines matched ────────────────────────────
// Out of inventory-eligible supplier_invoice_lines (not skipped, not
// classified non-inventory), how many are matched to a product?
async function scoreLinesMatched(db: SupabaseClient, businessId: string): Promise<DimensionResult> {
  // Eligible = match_status NOT IN ('not_inventory','skipped').
  // We count total eligible + matched separately.
  const totalQ = await db
    .from('supplier_invoice_lines')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .not('match_status', 'in', '("not_inventory","skipped")')

  if (totalQ.error) {
    return blankDim('lines_matched', 'Supplier lines matched', `Couldn\'t read invoice lines: ${totalQ.error.message}`, '/inventory/review')
  }
  const total = totalQ.count ?? 0
  if (total === 0) {
    return {
      key:          'lines_matched',
      label:        'Supplier lines matched',
      score:        null,
      count:        0,
      total:        0,
      hint:         'No supplier invoice lines yet.',
      action_label: 'Connect Fortnox',
      action_href:  '/integrations',
    }
  }

  const matchedQ = await db
    .from('supplier_invoice_lines')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .eq('match_status', 'matched')

  const matched = matchedQ.count ?? 0
  const unmatched = total - matched
  return {
    key:          'lines_matched',
    label:        'Supplier lines matched',
    score:        Math.round((matched / total) * 100),
    count:        matched,
    total,
    hint:         unmatched === 0
                    ? 'Every inventory line is matched to a product.'
                    : `${unmatched} lines waiting to be reviewed.`,
    action_label: 'Open review queue',
    action_href:  '/inventory/review',
  }
}

// ── Dimension 5 — products classified (M137/M138) ───────────────────
async function scoreProductsClassified(db: SupabaseClient, businessId: string): Promise<DimensionResult> {
  const totalQ = await db
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .is('archived_at', null)
    .in('category', PRODUCT_CATEGORIES)

  if (totalQ.error) {
    return blankDim('products_classified', 'Products classified', `Couldn\'t read products: ${totalQ.error.message}`, '/inventory/items')
  }
  const total = totalQ.count ?? 0
  if (total === 0) {
    return {
      key:          'products_classified',
      label:        'Products classified',
      score:        null,
      count:        0,
      total:        0,
      hint:         'No food/beverage/alcohol products in catalogue yet.',
      action_label: 'Connect Fortnox',
      action_href:  '/integrations',
    }
  }

  const classifiedQ = await db
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .is('archived_at', null)
    .in('category', PRODUCT_CATEGORIES)
    .not('sub_category', 'is', null)

  const classified = classifiedQ.count ?? 0
  const unclassified = total - classified
  return {
    key:          'products_classified',
    label:        'Products classified',
    score:        Math.round((classified / total) * 100),
    count:        classified,
    total,
    hint:         unclassified === 0
                    ? 'Every product has a sub-category.'
                    : `${unclassified} products waiting to be classified.`,
    action_label: 'Open articles',
    action_href:  '/inventory/items?filter=needs_classification',
  }
}

// ── Helpers ─────────────────────────────────────────────────────────
function blankDim(
  key:    DimensionKey,
  label:  string,
  hint:   string,
  href:   string,
): DimensionResult {
  return {
    key, label, score: null, count: 0, total: 0,
    hint,
    action_label: 'Open',
    action_href:  href,
  }
}
