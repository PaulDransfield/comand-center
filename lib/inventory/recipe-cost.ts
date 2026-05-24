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
import { getFxRate, type FxIndex } from './fx'

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
  latest_price_sek:  number | null  // M088 — latest_price converted via fx at latest_date; null if no rate
  fx_rate_used:    number | null    // M088 — diagnostic / UI display ("@ 11.45 SEK")
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
    // Use the SEK-converted price when fxIndex was passed; falls back
    // to native price for SEK rows (where latest_price_sek == latest_price).
    // When non-SEK + no FX rate available, latest_price_sek is null and
    // we treat the row as missing-price.
    const unitPrice   = p?.latest_price_sek ?? null
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

// Leaf-only price fetch — supplier_invoice_lines path. Used as a
// building block by both `getProductLatestPrices` (the public reader)
// and the recipe-sourced product pricing pass below. Does NOT detect
// or handle source_recipe_id products specially.
async function getProductLatestPricesLeaf(
  db: any,
  businessId: string,
  productIds: string[],
  fxIndex?: FxIndex,
): Promise<Map<string, ProductLatestPrice>> {
  const out = new Map<string, ProductLatestPrice>()
  if (productIds.length === 0) return out

  for (let i = 0; i < productIds.length; i += 500) {
    const slice = productIds.slice(i, i + 500)
    const { data: prods } = await db
      .from('products')
      .select('id, name, invoice_unit, pack_size, base_unit')
      .in('id', slice)
    for (const p of prods ?? []) {
      out.set(p.id, {
        product_id: p.id, product_name: p.name ?? null,
        latest_price: null, invoice_unit: p.invoice_unit ?? null,
        latest_date: null, latest_line_id: null, latest_currency: null,
        pack_size: p.pack_size != null ? Number(p.pack_size) : null,
        base_unit: p.base_unit ?? null,
        latest_price_sek: null, fx_rate_used: null,
      })
    }
  }

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
    if (existing && existing.latest_date) continue
    if (l.price_per_unit == null) continue
    const nativePrice = Number(l.price_per_unit)
    const currency    = l.currency ?? 'SEK'
    let priceSek: number | null = nativePrice
    let fxRateUsed: number | null = 1
    if (currency !== 'SEK') {
      if (fxIndex) {
        const rate = getFxRate(currency, l.invoice_date, fxIndex)
        if (rate != null) { priceSek = nativePrice * rate; fxRateUsed = rate }
        else { priceSek = null; fxRateUsed = null }
      } else { priceSek = null; fxRateUsed = null }
    }
    out.set(productId, {
      product_id: productId, product_name: existing?.product_name ?? null,
      latest_price: nativePrice,
      invoice_unit: existing?.invoice_unit ?? l.unit ?? null,
      latest_date: l.invoice_date, latest_line_id: l.id, latest_currency: currency,
      pack_size: existing?.pack_size ?? null, base_unit: existing?.base_unit ?? null,
      latest_price_sek: priceSek, fx_rate_used: fxRateUsed,
    })
  }
  return out
}

// One-shot batch fetch: given a set of product_ids, return the latest
// observed unit price per product (with its invoice_unit so the cost
// reader can flag unit_mismatch + FX rate so non-SEK lines convert).
// Used by both list + detail endpoints. The optional `fxIndex` arg
// applies FX conversion when present; callers that don't care about FX
// can omit it and prices stay in their native currency.
//
// Recipe-sourced products (M089, source_recipe_id != NULL) are priced
// from the recipe's live food_cost / portions rather than from supplier
// invoices — owner can promote a prep recipe ('Tomato Sauce') to a
// catalogue item and stocktake it.
export async function getProductLatestPrices(
  db: any,
  businessId: string,
  productIds: string[],
  fxIndex?: FxIndex,
): Promise<Map<string, ProductLatestPrice>> {
  const out = new Map<string, ProductLatestPrice>()
  if (productIds.length === 0) return out

  // Seed with invoice_unit + pack_size + base_unit + name + source_recipe_id
  // from products table — guarantees every requested product has an entry
  // even if it has zero observed prices, and exposes the pack data so
  // cost calc can apply per-base-unit conversion.
  //
  // RECIPE-SOURCED PRODUCTS (M089): when source_recipe_id is set, latest
  // price comes from the recipe's live cost (food_cost / portions), not
  // from supplier_invoice_lines. We collect their ids here and fill the
  // prices in a second pass below.
  const recipeSourcedProducts: Array<{ product_id: string; recipe_id: string }> = []
  const overrideProducts:      Array<{ product_id: string; price: number; currency: string }> = []
  for (let i = 0; i < productIds.length; i += 500) {
    const slice = productIds.slice(i, i + 500)
    const { data: prods } = await db
      .from('products')
      .select('id, name, invoice_unit, pack_size, base_unit, source_recipe_id, price_override, price_override_currency')
      .in('id', slice)
    for (const p of prods ?? []) {
      out.set(p.id, {
        product_id:        p.id,
        product_name:      p.name ?? null,
        latest_price:      null,
        invoice_unit:      p.invoice_unit ?? null,
        latest_date:       null,
        latest_line_id:    null,
        latest_currency:   null,
        pack_size:         p.pack_size != null ? Number(p.pack_size) : null,
        base_unit:         p.base_unit ?? null,
        latest_price_sek:  null,
        fx_rate_used:      null,
      })
      if (p.price_override != null) {
        overrideProducts.push({
          product_id: p.id,
          price:      Number(p.price_override),
          currency:   p.price_override_currency ?? 'SEK',
        })
      } else if (p.source_recipe_id) {
        recipeSourcedProducts.push({ product_id: p.id, recipe_id: p.source_recipe_id })
      }
    }
  }

  // Apply price overrides FIRST — they win over both recipe-derived and
  // invoice-derived prices. FX-convert non-SEK overrides via fxIndex
  // (using "today" since overrides don't have an invoice_date).
  const todayIso = new Date().toISOString().slice(0, 10)
  for (const ov of overrideProducts) {
    const slot = out.get(ov.product_id)
    if (!slot) continue
    let priceSek: number | null = ov.price
    let fxRateUsed: number | null = 1
    if (ov.currency !== 'SEK') {
      if (fxIndex) {
        const rate = getFxRate(ov.currency, todayIso, fxIndex)
        if (rate != null) { priceSek = ov.price * rate; fxRateUsed = rate }
        else { priceSek = null; fxRateUsed = null }
      } else { priceSek = null; fxRateUsed = null }
    }
    slot.latest_price     = ov.price
    slot.latest_currency  = ov.currency
    slot.latest_price_sek = priceSek
    slot.fx_rate_used     = fxRateUsed
    slot.latest_date      = todayIso
    // latest_line_id stays null — override isn't a line
  }

  // Recipe-sourced product pricing — compute each linked recipe's
  // cost-per-portion using the same compute path the recipe drawer uses.
  // Doing it here keeps cost identical across surfaces.
  if (recipeSourcedProducts.length > 0) {
    const recipeIds = Array.from(new Set(recipeSourcedProducts.map(r => r.recipe_id)))
    const { data: recipes } = await db
      .from('recipes')
      .select('id, portions, updated_at')
      .in('id', recipeIds)
    const recipeMeta = new Map<string, { portions: number; updated_at: string }>()
    for (const r of recipes ?? []) {
      recipeMeta.set(r.id, { portions: r.portions ?? 1, updated_at: r.updated_at })
    }

    // Build a recipe-index ONLY for these recipes' transitive ingredients.
    // Easiest: just load the whole business's recipe index. The caller's
    // already paying for getProductLatestPrices, this adds one extra query.
    const fullIndex = await loadRecipeIndex(db, businessId)

    // Collect all leaf product IDs the linked recipes (and their
    // sub-recipes) depend on. Recurse to grab them all.
    function collectLeafProducts(recipeId: string, seen: Set<string>, leafProducts: Set<string>) {
      if (seen.has(recipeId)) return
      seen.add(recipeId)
      const entry = fullIndex.get(recipeId)
      if (!entry) return
      for (const ing of entry.ingredients) {
        if (ing.product_id) leafProducts.add(ing.product_id)
        if (ing.subrecipe_id) collectLeafProducts(ing.subrecipe_id, seen, leafProducts)
      }
    }
    const leafProducts = new Set<string>()
    for (const { recipe_id } of recipeSourcedProducts) {
      collectLeafProducts(recipe_id, new Set(), leafProducts)
    }

    // Recursive call WITHOUT fxIndex+recipe context to avoid infinite
    // loops on circular recipe-product references. Leaf product prices
    // only — never enters the recipe-sourced branch.
    let leafPrices: Map<string, ProductLatestPrice> = new Map()
    if (leafProducts.size > 0) {
      // Filter out any leaf product that is ITSELF recipe-sourced (rare
      // edge case where a promoted recipe is used inside another recipe).
      // Those will recurse via the same code path.
      const ids = Array.from(leafProducts).filter(id => !recipeSourcedProducts.some(r => r.product_id === id))
      if (ids.length > 0) {
        leafPrices = await getProductLatestPricesLeaf(db, businessId, ids, fxIndex)
      }
    }

    // Cost each recipe-sourced product
    for (const { product_id, recipe_id } of recipeSourcedProducts) {
      const meta = recipeMeta.get(recipe_id)
      const entry = fullIndex.get(recipe_id)
      if (!meta || !entry) continue
      const summary = computeRecipeCost(entry.ingredients, leafPrices, null, {
        recipeIndex: fullIndex, recipeId: recipe_id,
      })
      const portions = Math.max(1, meta.portions)
      const perPortion = Math.round((summary.food_cost / portions) * 10000) / 10000
      const slot = out.get(product_id)
      if (slot) {
        slot.latest_price     = perPortion
        slot.latest_price_sek = perPortion          // recipes' food_cost is already in SEK
        slot.fx_rate_used     = 1
        slot.latest_date      = meta.updated_at?.slice(0, 10) ?? null
        slot.latest_currency  = 'SEK'
        // invoice_unit/pack/base already set at insert time
      }
    }
  }

  // Supplier-invoice-priced products — delegate to the leaf helper for
  // anything that ISN'T recipe-sourced AND ISN'T price-overridden.
  // Merge results, but don't clobber the override / recipe price we
  // already set above.
  const skipIds = new Set<string>([
    ...recipeSourcedProducts.map(r => r.product_id),
    ...overrideProducts.map(o => o.product_id),
  ])
  const nonSkipIds = productIds.filter(id => !skipIds.has(id))
  if (nonSkipIds.length > 0) {
    const leafPrices = await getProductLatestPricesLeaf(db, businessId, nonSkipIds, fxIndex)
    for (const [id, row] of leafPrices) {
      const existing = out.get(id)
      out.set(id, {
        ...row,
        product_name: existing?.product_name ?? row.product_name,
        invoice_unit: existing?.invoice_unit ?? row.invoice_unit,
        pack_size:    existing?.pack_size    ?? row.pack_size,
        base_unit:    existing?.base_unit    ?? row.base_unit,
      })
    }
  }

  return out
}
