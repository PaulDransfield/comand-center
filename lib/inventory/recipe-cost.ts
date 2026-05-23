// lib/inventory/recipe-cost.ts
//
// Single source of truth for recipe cost calculation. Both the list
// endpoint (GET /api/inventory/recipes) and the detail endpoint
// (GET /api/inventory/recipes/[id]) call computeRecipeCost() so the
// formula can't drift between surfaces.
//
// MVP UNIT MODEL: ingredient.quantity is in the SAME unit as
// product.invoice_unit. When ingredient.unit differs, cost is still
// computed (quantity × latest_price) but `unit_mismatch: true` flags
// it so the UI can warn the owner. Real unit conversion needs a
// per-product `pack_to_base_unit` factor on products — follow-up.

export interface IngredientForCosting {
  id:           string
  product_id:   string
  product_name: string
  category:     string | null
  quantity:     number
  unit:         string | null
  notes:        string | null
  position:     number
}

export interface ProductLatestPrice {
  product_id:      string
  latest_price:    number | null
  invoice_unit:    string | null
  latest_date:     string | null
  latest_line_id:  string | null    // for inline edit-the-price from the recipe drawer
  latest_currency: string | null
}

export interface CostedIngredient extends IngredientForCosting {
  invoice_unit:    string | null
  unit_price:      number | null     // per product.invoice_unit
  line_cost:       number | null     // quantity × unit_price
  unit_mismatch:   boolean           // true when ingredient.unit != invoice_unit (and both non-empty)
  no_price:        boolean           // true when product has no observed price yet
  latest_line_id:  string | null     // the supplier_invoice_lines row the price came from — for inline edits
  latest_currency: string | null     // ISO 4217 of that line
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
): RecipeCostSummary {
  const costed: CostedIngredient[] = ingredients.map(ing => {
    const p = prices.get(ing.product_id)
    const unitPrice = p?.latest_price ?? null
    const invoiceUnit = p?.invoice_unit ?? null
    const noPrice = unitPrice == null
    const unitMismatch =
      !noPrice &&
      !!invoiceUnit && !!ing.unit &&
      invoiceUnit.trim().toLowerCase() !== ing.unit.trim().toLowerCase()
    const lineCost = noPrice ? null : Math.round(ing.quantity * (unitPrice ?? 0) * 100) / 100
    return {
      ...ing,
      invoice_unit:    invoiceUnit,
      unit_price:      unitPrice,
      line_cost:       lineCost,
      unit_mismatch:   unitMismatch,
      no_price:        noPrice,
      latest_line_id:  p?.latest_line_id  ?? null,
      latest_currency: p?.latest_currency ?? null,
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

  // Seed with invoice_unit from products table — guarantees every
  // requested product has an entry even if it has zero observed prices.
  for (let i = 0; i < productIds.length; i += 500) {
    const slice = productIds.slice(i, i + 500)
    const { data: prods } = await db
      .from('products')
      .select('id, invoice_unit')
      .in('id', slice)
    for (const p of prods ?? []) {
      out.set(p.id, {
        product_id:      p.id,
        latest_price:    null,
        invoice_unit:    p.invoice_unit ?? null,
        latest_date:     null,
        latest_line_id:  null,
        latest_currency: null,
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
      latest_price:    Number(l.price_per_unit),
      invoice_unit:    existing?.invoice_unit ?? l.unit ?? null,
      latest_date:     l.invoice_date,
      latest_line_id:  l.id,
      latest_currency: l.currency ?? 'SEK',
    })
  }

  return out
}
