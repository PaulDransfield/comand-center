// lib/inventory/recipe-cost.ts
//
// (See unit-conversion.ts for the canonicalUnit / parseProductPackSize
// helpers — restaurant cost calc lives at the intersection of these two.)
//
// Single source of truth for recipe cost calculation. Both the list
// endpoint (GET /api/inventory/recipes) and the detail endpoint
// (GET /api/inventory/recipes/[id]) call computeRecipeCost() so the
// formula can't drift between surfaces.
//
import { canonicalUnit, convertQuantity, parseProductPackSize } from './unit-conversion'

// UNIT MODEL (post-M087):
//   Each product can carry pack_size + base_unit. Recipe ingredient qty
//   converts into the product's base_unit (g↔kg, ml↔l) and then
//   line_cost = converted_qty × (unit_price / pack_size).
//   Example: garlic bought as 1 ST @ 56 kr, pack_size=1000, base_unit='g'
//            recipe uses 20 g → 20 × (56/1000) = 1.12 kr.
//   Fallback: when pack_size is null, try to parse it from the product
//   name (parseProductPackSize). When that fails, fall back to legacy
//   1:1 calc + unit_mismatch warning.

export interface IngredientForCosting {
  id:           string
  product_id:   string | null        // null when this row is a sub-recipe reference
  product_name: string | null        // null for sub-recipe rows
  category:     string | null
  quantity:     number
  unit:         string | null
  notes:        string | null
  position:     number
  // Sub-recipe fields (mutually exclusive with product_id per the DB CHECK)
  subrecipe_id:    string | null
  subrecipe_name:  string | null
}

export interface RecipeContextEntry {
  id:          string
  portions:    number
  ingredients: IngredientForCosting[]
}
export type RecipeIndex = Map<string, RecipeContextEntry>

export interface ProductLatestPrice {
  product_id:      string
  product_name:    string | null   // used by the auto pack-size parser
  latest_price:    number | null
  invoice_unit:    string | null
  latest_date:     string | null
  latest_line_id:  string | null    // for inline edit-the-price from the recipe drawer
  latest_currency: string | null
  pack_size:       number | null    // M087 — base_units per invoice_unit
  base_unit:       string | null    // M087 — 'g' | 'ml' | 'st'
}

export interface CostedIngredient extends IngredientForCosting {
  invoice_unit:    string | null
  unit_price:      number | null     // per product.invoice_unit for products; per portion for sub-recipes
  line_cost:       number | null     // quantity × unit_price (after pack conversion when available)
  unit_mismatch:   boolean           // true when units couldn't be converted (different families or no pack data)
  no_price:        boolean           // true when product has no observed price yet OR sub-recipe couldn't cost
  latest_line_id:  string | null     // products only; null for sub-recipes
  latest_currency: string | null     // products only; null for sub-recipes
  is_subrecipe:    boolean           // true if this ingredient is a sub-recipe reference
  cycle:           boolean           // true if cost couldn't be computed because of a recipe cycle
  // M087 — pack-aware conversion fields
  pack_size:           number | null  // base units per invoice unit (e.g. 1000 for a 1kg bag)
  base_unit:           string | null  // 'g' | 'ml' | 'st'
  cost_per_base_unit:  number | null  // unit_price / pack_size — e.g. 0.056 kr/g
  pack_auto_detected:  boolean        // true when the parser inferred pack_size from the name (NOT saved yet)
}

export interface RecipeCostSummary {
  food_cost:       number            // sum of line_cost (NaN-safe — missing prices contribute 0)
  ingredients:     CostedIngredient[]
  missing_prices:  number            // count of ingredients with no_price=true
  unit_mismatches: number            // count of ingredients with unit_mismatch=true
  food_pct:        number | null     // food_cost / menu_price; null if menu_price <= 0
  gp_pct:          number | null     // (menu_price - food_cost) / menu_price
  gp_kr:           number | null     // menu_price - food_cost
}

export function computeRecipeCost(
  ingredients: IngredientForCosting[],
  prices:      Map<string, ProductLatestPrice>,
  menuPrice:   number | null,
  options?: { recipeIndex?: RecipeIndex; recipeId?: string; ancestors?: Set<string> },
): RecipeCostSummary {
  const index     = options?.recipeIndex
  const ancestors = options?.ancestors ?? new Set<string>()
  // Add current recipe to the ancestor stack so any descendant lookup
  // that hits this id is detected as a cycle.
  if (options?.recipeId) ancestors.add(options.recipeId)

  const costed: CostedIngredient[] = ingredients.map(ing => {
    // ── Sub-recipe branch ───────────────────────────────────────────
    if (ing.subrecipe_id) {
      // Cycle: the sub-recipe IS one of our ancestors. Don't recurse.
      if (ancestors.has(ing.subrecipe_id)) {
        return {
          ...ing,
          invoice_unit:        'portion',
          unit_price:          null,
          line_cost:           null,
          unit_mismatch:       false,
          no_price:            true,
          latest_line_id:      null,
          latest_currency:     null,
          is_subrecipe:        true,
          cycle:               true,
          pack_size:           null,
          base_unit:           null,
          cost_per_base_unit:  null,
          pack_auto_detected:  false,
        }
      }
      const subEntry = index?.get(ing.subrecipe_id)
      if (!subEntry || subEntry.portions <= 0) {
        return {
          ...ing,
          invoice_unit:        'portion',
          unit_price:          null,
          line_cost:           null,
          unit_mismatch:       false,
          no_price:            true,
          latest_line_id:      null,
          latest_currency:     null,
          is_subrecipe:        true,
          cycle:               false,
          pack_size:           null,
          base_unit:           null,
          cost_per_base_unit:  null,
          pack_auto_detected:  false,
        }
      }
      // Recurse — pass a copy of ancestors so siblings can re-enter the
      // same sub-recipe legitimately (diamond dependency is fine).
      const subSummary = computeRecipeCost(
        subEntry.ingredients,
        prices,
        null,
        {
          recipeIndex: index,
          recipeId:    ing.subrecipe_id,
          ancestors:   new Set(ancestors),
        },
      )
      const perPortion = subSummary.food_cost / subEntry.portions
      const lineCost = Math.round(ing.quantity * perPortion * 100) / 100
      return {
        ...ing,
        invoice_unit:        'portion',
        unit_price:          Math.round(perPortion * 100) / 100,
        line_cost:           lineCost,
        unit_mismatch:       false,
        no_price:            subSummary.food_cost === 0 && subSummary.missing_prices > 0,
        latest_line_id:      null,
        latest_currency:     null,
        is_subrecipe:        true,
        cycle:               false,
        pack_size:           null,
        base_unit:           null,
        cost_per_base_unit:  null,
        pack_auto_detected:  false,
      }
    }

    // ── Product branch ──────────────────────────────────────────────
    const p = ing.product_id ? prices.get(ing.product_id) : undefined
    const unitPrice   = p?.latest_price ?? null
    const invoiceUnit = p?.invoice_unit ?? null
    const noPrice     = unitPrice == null

    // Pack-aware conversion. Use saved pack data first; if missing, try
    // to parse from the product name (cheap and very high hit rate for
    // restaurant invoices — "Pizza sauce 4,1 kg" etc).
    let packSize:   number | null = p?.pack_size ?? null
    let baseUnit:   string | null = p?.base_unit ?? null
    let autoParsed = false
    if ((packSize == null || baseUnit == null) && p?.product_name) {
      const parsed = parseProductPackSize(p.product_name)
      if (parsed) {
        packSize = parsed.pack_size
        baseUnit = parsed.base_unit
        autoParsed = true
      }
    }

    // cost_per_base_unit = unit_price / pack_size  (when both known)
    let costPerBase: number | null = null
    if (unitPrice != null && packSize != null && packSize > 0) {
      costPerBase = unitPrice / packSize
    }

    // Try to convert recipe qty to base_unit. If we have base_unit + the
    // recipe's unit is in the same family (g↔kg, ml↔l), we get a clean
    // converted quantity. If not, fall back to old line_cost so the
    // owner at least sees SOMETHING and the unit_mismatch flag warns them.
    let lineCost: number | null = null
    let unitMismatch = false
    if (!noPrice && costPerBase != null && baseUnit && ing.unit) {
      const converted = convertQuantity(ing.quantity, ing.unit, baseUnit)
      if (converted != null) {
        lineCost = Math.round(converted * costPerBase * 100) / 100
      } else {
        // Cross-family or unknown unit — flag and don't try to cost
        lineCost = null
        unitMismatch = true
      }
    } else if (!noPrice) {
      // No pack data at all (and parser couldn't help) — legacy 1:1 calc.
      lineCost = Math.round(ing.quantity * (unitPrice ?? 0) * 100) / 100
      unitMismatch = !!invoiceUnit && !!ing.unit &&
                     canonicalUnit(invoiceUnit) !== canonicalUnit(ing.unit)
    }

    return {
      ...ing,
      invoice_unit:    invoiceUnit,
      unit_price:      unitPrice,
      line_cost:       lineCost,
      unit_mismatch:   unitMismatch,
      no_price:        noPrice,
      latest_line_id:  p?.latest_line_id  ?? null,
      latest_currency: p?.latest_currency ?? null,
      is_subrecipe:    false,
      cycle:           false,
      pack_size:           packSize,
      base_unit:           baseUnit,
      cost_per_base_unit:  costPerBase != null ? Math.round(costPerBase * 10000) / 10000 : null,
      pack_auto_detected:  autoParsed,
    }
  })

  const foodCost = Math.round(costed.reduce((s, c) => s + (c.line_cost ?? 0), 0) * 100) / 100
  const missing  = costed.filter(c => c.no_price).length
  const mismatch = costed.filter(c => c.unit_mismatch).length

  const haveMenuPrice = menuPrice != null && menuPrice > 0
  const foodPct = haveMenuPrice ? Math.round((foodCost / menuPrice!) * 1000) / 10 : null
  const gpKr    = haveMenuPrice ? Math.round((menuPrice! - foodCost) * 100) / 100 : null
  const gpPct   = haveMenuPrice ? Math.round(((menuPrice! - foodCost) / menuPrice!) * 1000) / 10 : null

  return {
    food_cost:       foodCost,
    ingredients:     costed,
    missing_prices:  missing,
    unit_mismatches: mismatch,
    food_pct:        foodPct,
    gp_pct:          gpPct,
    gp_kr:           gpKr,
  }
}

// Load every recipe + its ingredients for a business into a RecipeIndex
// so cost computation can recurse through sub-recipes cheaply. Two
// batched queries — fine even at 500+ recipes per business.
export async function loadRecipeIndex(
  db: any,
  businessId: string,
): Promise<RecipeIndex> {
  const idx: RecipeIndex = new Map()
  const { data: recipes } = await db
    .from('recipes')
    .select('id, portions')
    .eq('business_id', businessId)
    .is('archived_at', null)
  if (!recipes || recipes.length === 0) return idx
  for (const r of recipes) {
    idx.set(r.id, { id: r.id, portions: r.portions ?? 1, ingredients: [] })
  }
  const recipeIds = recipes.map((r: any) => r.id)
  const { data: ings } = await db
    .from('recipe_ingredients')
    .select('id, recipe_id, product_id, subrecipe_id, quantity, unit, notes, position, products(name, category), subrecipe:subrecipe_id(name)')
    .in('recipe_id', recipeIds)
    .order('position')
  for (const i of ings ?? []) {
    const entry = idx.get(i.recipe_id)
    if (!entry) continue
    entry.ingredients.push({
      id:             i.id,
      product_id:     i.product_id,
      product_name:   (i.products as any)?.name ?? null,
      category:       (i.products as any)?.category ?? null,
      quantity:       Number(i.quantity),
      unit:           i.unit,
      notes:          i.notes,
      position:       i.position,
      subrecipe_id:   i.subrecipe_id,
      subrecipe_name: (i.subrecipe as any)?.name ?? null,
    })
  }
  return idx
}

// Cycle prevention helper for POST /api/inventory/recipes/[id]/ingredients.
// Returns true if adding subrecipeId as an ingredient of parentRecipeId
// would create a cycle (i.e. subrecipeId's transitive ingredients
// include parentRecipeId).
export function wouldCreateCycle(
  parentRecipeId: string,
  subrecipeId:    string,
  index:          RecipeIndex,
): boolean {
  if (parentRecipeId === subrecipeId) return true
  const seen = new Set<string>()
  const stack = [subrecipeId]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (seen.has(cur)) continue
    seen.add(cur)
    if (cur === parentRecipeId) return true
    const entry = index.get(cur)
    if (!entry) continue
    for (const ing of entry.ingredients) {
      if (ing.subrecipe_id && !seen.has(ing.subrecipe_id)) stack.push(ing.subrecipe_id)
    }
  }
  return false
}

// One-shot batch fetch: given a set of product_ids, return the latest
// observed unit price per product (with its invoice_unit so the cost
// reader can flag unit_mismatch). Used by both list + detail endpoints.
export async function getProductLatestPrices(
  db: any,
  businessId: string,
  productIds: string[],
): Promise<Map<string, ProductLatestPrice>> {
  const out = new Map<string, ProductLatestPrice>()
  if (productIds.length === 0) return out

  // Seed with invoice_unit + pack_size + base_unit + name from products
  // table — guarantees every requested product has an entry even if it
  // has zero observed prices, and exposes the pack data so cost calc
  // can apply per-base-unit conversion.
  for (let i = 0; i < productIds.length; i += 500) {
    const slice = productIds.slice(i, i + 500)
    const { data: prods } = await db
      .from('products')
      .select('id, name, invoice_unit, pack_size, base_unit')
      .in('id', slice)
    for (const p of prods ?? []) {
      out.set(p.id, {
        product_id:      p.id,
        product_name:    p.name ?? null,
        latest_price:    null,
        invoice_unit:    p.invoice_unit ?? null,
        latest_date:     null,
        latest_line_id:  null,
        latest_currency: null,
        pack_size:       p.pack_size != null ? Number(p.pack_size) : null,
        base_unit:       p.base_unit ?? null,
      })
    }
  }

  // Resolve product → aliases → latest matched supplier_invoice_lines.
  // Single sweep on supplier_invoice_lines + a sweep on product_aliases.
  const aliasToProduct = new Map<string, string>()
  for (let i = 0; i < productIds.length; i += 500) {
    const slice = productIds.slice(i, i + 500)
    const { data: aliases } = await db
      .from('product_aliases')
      .select('id, product_id')
      .in('product_id', slice)
    for (const a of aliases ?? []) aliasToProduct.set(a.id, a.product_id)
  }

  const aliasIds = Array.from(aliasToProduct.keys())
  if (aliasIds.length === 0) return out

  // Pull matched lines for these aliases, newest first. We only need
  // the FIRST hit per product — but a small business has few enough
  // observations that pulling everything and reducing in JS is fine.
  // Cap at 50k to avoid pathological cases.
  const allLines: any[] = []
  for (let i = 0; i < aliasIds.length; i += 200) {
    const slice = aliasIds.slice(i, i + 200)
    let from = 0
    while (from <= 50_000) {
      const { data } = await db
        .from('supplier_invoice_lines')
        .select('id, product_alias_id, price_per_unit, unit, invoice_date, currency')
        .eq('business_id', businessId)
        .eq('match_status', 'matched')
        .in('product_alias_id', slice)
        .order('invoice_date', { ascending: false })
        .range(from, from + 999)
      if (!data || data.length === 0) break
      allLines.push(...data)
      if (data.length < 1000) break
      from += 1000
    }
  }

  for (const l of allLines) {
    const productId = aliasToProduct.get(l.product_alias_id)
    if (!productId) continue
    const existing = out.get(productId)
    if (existing && existing.latest_date) continue   // already have a newer hit (input sorted DESC)
    if (l.price_per_unit == null) continue
    out.set(productId, {
      product_id:      productId,
      product_name:    existing?.product_name ?? null,
      latest_price:    Number(l.price_per_unit),
      invoice_unit:    existing?.invoice_unit ?? l.unit ?? null,
      latest_date:     l.invoice_date,
      latest_line_id:  l.id,
      latest_currency: l.currency ?? 'SEK',
      pack_size:       existing?.pack_size ?? null,
      base_unit:       existing?.base_unit ?? null,
    })
  }

  return out
}
