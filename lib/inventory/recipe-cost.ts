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
import { canonicalUnit, convertQuantity, parseProductPackSize, unitFamily } from './unit-conversion'
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
  quantity:     number               // INFLATED for cost — see loadRecipeIndex. Original (recipe-stated) qty lives in quantity_stated.
  quantity_stated: number            // What the owner entered (pre-waste). UI displays this.
  waste_pct:    number               // 0..<100; the engine doesn't read this directly (inflation is done at load), kept for UI display only.
  unit:         string | null
  notes:        string | null
  position:     number
  // Sub-recipe fields (mutually exclusive with product_id per the DB CHECK)
  subrecipe_id:    string | null
  subrecipe_name:  string | null
}

export interface RecipeContextEntry {
  id:           string
  portions:     number
  // M111 — sub-recipe yield. NULL = portion-only (legacy). When both
  // are set, a parent recipe can consume this sub-recipe in any unit
  // family-compatible with yield_unit (g↔kg, ml↔l, etc.) and the
  // engine converts at cost-time.
  yield_amount: number | null
  yield_unit:   string | null
  ingredients:  IngredientForCosting[]
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
  density_g_per_ml: number | null   // M120 — for mass↔volume conversion in the cost engine
  density_source:   string | null   // M120 — manual | ai_inferred | convention_default | null
  weight_per_piece_g:       number | null  // M122 — for mass↔count conversion in the cost engine
  weight_per_piece_source:  string | null  // M122 — manual | supplier_article | name_parsed | null
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
  // M120 — density-conversion provenance for UI ("converted via density 0.91 g/ml")
  density_used:        number | null  // the g/ml value the engine actually used for mass↔volume conversion; null when none needed
  density_source:      string | null  // 'manual' | 'ai_inferred' | 'convention_default' | null
  // M122 — mass↔count conversion provenance
  weight_per_piece_used:    number | null  // the g/piece value the engine actually used for mass↔count conversion
  weight_per_piece_source:  string | null  // 'manual' | 'supplier_article' | 'name_parsed' | null
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
          density_used:        null,
          density_source:      null,
          weight_per_piece_used:    null,
          weight_per_piece_source:  null,
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
          density_used:        null,
          density_source:      null,
          weight_per_piece_used:    null,
          weight_per_piece_source:  null,
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

      // M111 — sub-recipe yield conversion. When the recipe consumes
      // this sub-recipe in a non-portion unit (e.g. 30 g of sauce), use
      // the sub-recipe's declared yield to convert to a portion equivalent.
      // Math: qty_in_yield_unit / yield_amount = portion_equivalent.
      // Falls back to honest-incomplete (unit_mismatch + null cost)
      // when no yield is set or units are family-incompatible.
      const recipeUnit = ing.unit ?? 'portion'
      let lineCost: number | null
      let unitMismatch = false
      let displayUnit  = 'portion'

      if (recipeUnit === 'portion') {
        lineCost = Math.round(ing.quantity * perPortion * 100) / 100
      } else if (subEntry.yield_amount && subEntry.yield_unit) {
        let qtyInYieldUnit = convertQuantity(ing.quantity, recipeUnit, subEntry.yield_unit)
        if (qtyInYieldUnit == null) {
          // Cross-family between mass and volume — for sub-recipes the
          // cooking convention is 1 ml ≈ 1 g (vinaigrettes, sauces,
          // pestos). Even for pure oils (density ~0.91) the error is
          // <10%, well within recipe-cost noise floor where the chef's
          // pour estimate is the dominant uncertainty anyway.
          //
          // Engineered for sub-recipes only — products go through their
          // own density column when one is set (M120 density resolver).
          const rFam = unitFamily(recipeUnit)
          const yFam = unitFamily(subEntry.yield_unit)
          const isMassVolBridge = rFam && yFam && rFam !== yFam &&
            (rFam === 'mass' || rFam === 'volume') &&
            (yFam === 'mass' || yFam === 'volume')
          if (isMassVolBridge) {
            // Convert recipe qty to its family base (g or ml), then
            // bridge 1:1 to the other family's base.
            const recipeBase = rFam === 'mass' ? 'g' : 'ml'
            const yieldBase  = yFam === 'mass' ? 'g' : 'ml'
            const qtyInRecipeBase = convertQuantity(ing.quantity, recipeUnit, recipeBase)
            if (qtyInRecipeBase != null) {
              // 1:1 cooking density. qtyInRecipeBase is already in the
              // "other family base" (g or ml) just by interpretation.
              // Then convert from that family base to subEntry.yield_unit.
              qtyInYieldUnit = convertQuantity(qtyInRecipeBase, yieldBase, subEntry.yield_unit)
            }
          }
        }
        if (qtyInYieldUnit == null) {
          lineCost     = null
          unitMismatch = true
          displayUnit  = subEntry.yield_unit
        } else {
          const portionEquiv = qtyInYieldUnit / subEntry.yield_amount
          lineCost = Math.round(portionEquiv * perPortion * 100) / 100
          displayUnit = recipeUnit
        }
      } else {
        // No yield set — sub-recipe can only be consumed in portions.
        // Honest-incomplete: surface as unit_mismatch so the UI
        // prompts the owner to set the yield.
        lineCost     = null
        unitMismatch = true
      }

      return {
        ...ing,
        invoice_unit:        displayUnit,
        unit_price:          Math.round(perPortion * 100) / 100,
        line_cost:           lineCost,
        unit_mismatch:       unitMismatch,
        no_price:            subSummary.food_cost === 0 && subSummary.missing_prices > 0,
        latest_line_id:      null,
        latest_currency:     null,
        is_subrecipe:        true,
        cycle:               false,
        pack_size:           subEntry.yield_amount,
        base_unit:           subEntry.yield_unit,
        cost_per_base_unit:  subEntry.yield_amount && subEntry.yield_amount > 0
          ? Math.round((perPortion / subEntry.yield_amount) * 10000) / 10000
          : null,
        pack_auto_detected:  false,
        density_used:        null,
        density_source:      null,
        weight_per_piece_used:    null,
        weight_per_piece_source:  null,
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

    // Pack-aware conversion. Resolution priority:
    //   1. Saved pack_size + base_unit on the product (owner-set).
    //   2. Parse from product name — "Pizza sauce 4,1 kg" etc.
    //   3. Canonical SI inference from invoice_unit alone. If supplier
    //      sells in KG and we know the kr/KG price, we know the kr/g
    //      price without needing an explicit pack_size. Owner shouldn't
    //      have to write `pack=1000, base=g` for every kg-priced item.
    let packSize:   number | null = p?.pack_size ?? null
    let baseUnit:   string | null = p?.base_unit ?? null
    let autoParsed = false
    if ((packSize == null || baseUnit == null) && p?.product_name) {
      // Phase A — parseProductPackSize now does the invoice_unit fallback
      // itself (name first, invoice_unit second). The dedicated
      // inferPackFromInvoiceUnit call below is retained as belt-and-
      // braces but should be a no-op since the parser covers it.
      const parsed = parseProductPackSize(p.product_name, invoiceUnit)
      if (parsed) {
        packSize = parsed.pack_size
        baseUnit = parsed.base_unit
        autoParsed = true
      }
    }
    if ((packSize == null || baseUnit == null) && invoiceUnit) {
      const inferred = inferPackFromInvoiceUnit(invoiceUnit)
      if (inferred) {
        packSize = inferred.pack_size
        baseUnit = inferred.base_unit
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
    // converted quantity. If not in the same family, try the 1:1 fallback
    // against invoice_unit first — common case: invoice='st' (1 jar),
    // pack parsed from name to '4100g', recipe asks for '1 styck' = 1 jar.
    // The pack-aware path can't convert st→g, but 1:1 against invoice_unit
    // is correct because '1 st of the jar' IS unit_price by definition.
    let lineCost: number | null = null
    let unitMismatch = false
    let densityUsed: number | null = null
    let weightPerPieceUsed: number | null = null
    const weightPerPiece = p?.weight_per_piece_g ?? null
    // M120 — density-bridge for mass↔volume. If recipe asks "30 g of
    // olive oil" but supplier base is ml, divide by density to get ml,
    // then cost via cost-per-ml. Same in reverse for ml ingredients
    // priced by mass. Only fires when:
    //   - convertQuantity returned null (family mismatch)
    //   - both families ∈ {mass, volume}
    //   - product has density_g_per_ml set
    // Otherwise honest-incomplete: unit_mismatch=true, line_cost=null.
    const density = p?.density_g_per_ml ?? null
    if (!noPrice && costPerBase != null && baseUnit && ing.unit) {
      const converted = convertQuantity(ing.quantity, ing.unit, baseUnit)
      if (converted != null) {
        lineCost = Math.round(converted * costPerBase * 100) / 100
      } else if (invoiceUnit && canonicalUnit(invoiceUnit) === canonicalUnit(ing.unit)) {
        // Recipe unit canonicalizes to the invoice unit (e.g. recipe 'styck'
        // vs invoice 'st'). Use the unit_price directly — that's what the
        // owner means by "1 of these". Pack-derived base_unit is irrelevant
        // here; the supplier sells per st and the recipe specifies in st.
        lineCost = Math.round(ing.quantity * (unitPrice ?? 0) * 100) / 100
      } else if (weightPerPiece != null && weightPerPiece > 0 &&
                 baseUnit === 'st' && unitFamily(ing.unit) === 'mass') {
        // M122 — mass↔count bridge via weight_per_piece_g.
        // Recipe asks "30 g of egg"; product is base_unit='st' with
        // weight_per_piece_g=60. Convert grams → pieces, then cost via
        // cost_per_base_unit (kr/st).
        const qtyInGrams = convertQuantity(ing.quantity, ing.unit, 'g')
        if (qtyInGrams != null) {
          const pieces = qtyInGrams / weightPerPiece
          lineCost = Math.round(pieces * costPerBase * 100) / 100
          weightPerPieceUsed = weightPerPiece
          unitMismatch = false
        } else {
          lineCost = null
          unitMismatch = true
        }
      } else {
        // Mass↔volume bridge. Use the product's explicit density_g_per_ml
        // when present; otherwise fall back to 1.0 (cooking convention —
        // water-like liquids are ≈ 1 g/ml, most kitchen liquids are within
        // 10%, and the cost difference is small enough that the chef
        // shouldn't have to do data entry for it to work at all).
        // Aceto Balsamico, vinegar, juice, milk, broth, etc. all collapse
        // into the "≈ 1" bucket. Olive oil and syrup are off by ~10%;
        // owner can set explicit density to refine.
        const recipeFam = unitFamily(ing.unit)
        const baseFam   = unitFamily(baseUnit)
        if (recipeFam && baseFam && recipeFam !== baseFam &&
            (recipeFam === 'mass' || recipeFam === 'volume') &&
            (baseFam   === 'mass' || baseFam   === 'volume')) {
          const recipeBase = recipeFam === 'mass' ? 'g' : 'ml'
          const qtyInRecipeBase = convertQuantity(ing.quantity, ing.unit, recipeBase)
          if (qtyInRecipeBase != null) {
            const effectiveDensity = (density != null && density > 0) ? density : 1.0
            const bridged = recipeFam === 'mass'
              ? qtyInRecipeBase / effectiveDensity
              : qtyInRecipeBase * effectiveDensity
            lineCost = Math.round(bridged * costPerBase * 100) / 100
            densityUsed = effectiveDensity
            unitMismatch = false
          } else {
            lineCost = null
            unitMismatch = true
          }
        } else {
          // Truly different families (mass↔count without weight_per_piece,
          // count↔volume etc.) — honest-incomplete.
          lineCost = null
          unitMismatch = true
        }
      }
    } else if (!noPrice) {
      // No pack data — use a 1:1 calc ONLY when the recipe unit matches the
      // invoice unit (or one isn't set). If the units differ and we have no
      // pack to convert through, we honestly cannot cost this line — return
      // null and the unit_mismatch flag, never a confident-wrong number
      // (the "10g recipe × 229 kr/KG = 2,290 kr" trap from the live test).
      const sameUnit = !invoiceUnit || !ing.unit ||
                       canonicalUnit(invoiceUnit) === canonicalUnit(ing.unit)
      if (sameUnit) {
        lineCost = Math.round(ing.quantity * (unitPrice ?? 0) * 100) / 100
        unitMismatch = false
      } else {
        lineCost = null
        unitMismatch = true
      }
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
      density_used:        densityUsed,
      density_source:      densityUsed != null ? (p?.density_source ?? null) : null,
      weight_per_piece_used:    weightPerPieceUsed,
      weight_per_piece_source:  weightPerPieceUsed != null ? (p?.weight_per_piece_source ?? null) : null,
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
    .select('id, portions, yield_amount, yield_unit')
    .eq('business_id', businessId)
    .is('archived_at', null)
  if (!recipes || recipes.length === 0) return idx
  for (const r of recipes) {
    idx.set(r.id, {
      id:           r.id,
      portions:     r.portions ?? 1,
      yield_amount: r.yield_amount != null ? Number(r.yield_amount) : null,
      yield_unit:   r.yield_unit ?? null,
      ingredients:  [],
    })
  }
  const recipeIds = recipes.map((r: any) => r.id)
  const { data: ings } = await db
    .from('recipe_ingredients')
    .select('id, recipe_id, product_id, subrecipe_id, quantity, waste_pct, unit, notes, position, products(name, category), subrecipe:subrecipe_id(name)')
    .in('recipe_id', recipeIds)
    .order('position')
  for (const i of ings ?? []) {
    const entry = idx.get(i.recipe_id)
    if (!entry) continue
    const statedQty = Number(i.quantity)
    const wastePct  = clampWastePct(i.waste_pct)
    entry.ingredients.push({
      id:              i.id,
      product_id:      i.product_id,
      product_name:    (i.products as any)?.name ?? null,
      category:        (i.products as any)?.category ?? null,
      quantity:        inflateForWaste(statedQty, wastePct),
      quantity_stated: statedQty,
      waste_pct:       wastePct,
      unit:            i.unit,
      notes:           i.notes,
      position:        i.position,
      subrecipe_id:    i.subrecipe_id,
      subrecipe_name:  (i.subrecipe as any)?.name ?? null,
    })
  }
  return idx
}

// Canonical SI inference — turn an invoice_unit string into (pack_size,
// base_unit) so the engine can convert kg→g, l→ml etc without the owner
// having to set explicit pack data per product. Returns null for unknown
// units (engine falls through to the legacy 1:1 path with unit_mismatch
// flag if recipe unit differs).
//
// Conservative: only matches the canonical SI/Swedish kitchen units where
// the conversion is unambiguous. Anything weirder (FRP, FÖRP, KART, BX)
// owner still has to set explicitly, because the pack-size is opaque
// from the unit string alone.
export function inferPackFromInvoiceUnit(invoiceUnit: string): { pack_size: number; base_unit: string } | null {
  const u = invoiceUnit.trim().toLowerCase().replace(/\s+/g, '')
  // Mass
  if (u === 'kg' || u === 'kilo' || u === 'kilogram') return { pack_size: 1000, base_unit: 'g' }
  if (u === 'g' || u === 'gr' || u === 'gram' || u === 'grams') return { pack_size: 1, base_unit: 'g' }
  // Volume — 'ltr' is a Swedish supplier variant of 'liter' (Diageo etc).
  if (u === 'l' || u === 'liter' || u === 'litre' || u === 'lit' || u === 'ltr') return { pack_size: 1000, base_unit: 'ml' }
  if (u === 'dl') return { pack_size: 100, base_unit: 'ml' }
  if (u === 'cl') return { pack_size: 10,  base_unit: 'ml' }
  if (u === 'ml') return { pack_size: 1,   base_unit: 'ml' }
  // Count
  if (u === 'st' || u === 'styck' || u === 'stk' || u === 'ea' || u === 'each') return { pack_size: 1, base_unit: 'st' }
  return null
}

// Yield-loss inflation. The engine consumes `quantity` directly; we pre-
// inflate at load so the engine math stays pure (no waste-aware branch
// inside computeRecipeCost). At waste=0 this returns qty unchanged
// (multiplied by 1). The clamp + DB CHECK (waste_pct < 100) prevent
// division-by-zero; a stray 100 from anywhere clamps to MAX_WASTE_PCT and
// the call is computed at the cap rather than blowing up.
//
// Named bounds (no magic numbers per owner review note).
export const MAX_WASTE_PCT = 95     // Hard ceiling; >95% means the recipe is misconfigured.
export const MIN_WASTE_PCT = 0
function clampWastePct(raw: any): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return MIN_WASTE_PCT
  if (n <= MIN_WASTE_PCT) return MIN_WASTE_PCT
  if (n >= MAX_WASTE_PCT) return MAX_WASTE_PCT
  return n
}
export function inflateForWaste(quantity: number, wastePct: number): number {
  if (wastePct <= 0) return quantity                    // true no-op
  const yieldFraction = 1 - (wastePct / 100)
  if (yieldFraction <= 0) return quantity               // belt-and-braces — clamp should have caught this
  return quantity / yieldFraction
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

// M120 — set false the first time PostgREST tells us density_g_per_ml
// doesn't exist (column not applied yet). Skips the optimistic SELECT
// on every subsequent call so we don't pay the round-trip per batch.
// Once the owner applies the M120 SQL the next process restart picks
// it up; until then the cost engine silently treats density as null
// (honest-incomplete falls back to unit_mismatch as before).
let DENSITY_COLUMNS_AVAILABLE = true

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

  // BATCH_IN: 500 UUIDs in .in() blows past Supabase's ~16 KB header
  // limit (UND_ERR_HEADERS_OVERFLOW) and supabase-js silently returns
  // { data: null } — every consumer of this function would lose
  // prices silently. Keep at 100; never raise without re-measuring.
  // See docs/investigation/no-price-root-cause.md.
  const BATCH_IN = 100

  // M120-aware SELECT — try density columns first; if the column hasn't
  // been applied yet (42703 undefined_column), retry without them. The
  // flag flips once at module level on first miss; subsequent calls
  // skip the retry attempt.
  for (let i = 0; i < productIds.length; i += BATCH_IN) {
    const slice = productIds.slice(i, i + BATCH_IN)
    let prods: any[] | null = null
    if (DENSITY_COLUMNS_AVAILABLE) {
      const { data, error: pErr } = await db
        .from('products')
        .select('id, name, invoice_unit, pack_size, base_unit, density_g_per_ml, density_source, weight_per_piece_g, weight_per_piece_source')
        .in('id', slice)
      if (pErr) {
        if ((pErr as any).code === '42703' || /density_g_per_ml.*does not exist/i.test(pErr.message) || /weight_per_piece_g.*does not exist/i.test(pErr.message)) {
          DENSITY_COLUMNS_AVAILABLE = false   // M120 / M122 not applied yet — stop trying.
        } else {
          throw new Error(`[recipe-cost] products lookup failed: ${pErr.message}`)
        }
      } else {
        prods = data
      }
    }
    if (prods == null) {
      const { data, error: pErr } = await db
        .from('products')
        .select('id, name, invoice_unit, pack_size, base_unit')
        .in('id', slice)
      if (pErr) throw new Error(`[recipe-cost] products lookup failed: ${pErr.message}`)
      prods = data
    }
    for (const p of prods ?? []) {
      out.set(p.id, {
        product_id: p.id, product_name: p.name ?? null,
        latest_price: null, invoice_unit: p.invoice_unit ?? null,
        latest_date: null, latest_line_id: null, latest_currency: null,
        pack_size: p.pack_size != null ? Number(p.pack_size) : null,
        base_unit: p.base_unit ?? null,
        latest_price_sek: null, fx_rate_used: null,
        density_g_per_ml: (p as any).density_g_per_ml != null ? Number((p as any).density_g_per_ml) : null,
        density_source:   (p as any).density_source ?? null,
        weight_per_piece_g:      (p as any).weight_per_piece_g != null ? Number((p as any).weight_per_piece_g) : null,
        weight_per_piece_source: (p as any).weight_per_piece_source ?? null,
      })
    }
  }

  const aliasToProduct = new Map<string, string>()
  for (let i = 0; i < productIds.length; i += BATCH_IN) {
    const slice = productIds.slice(i, i + BATCH_IN)
    const { data: aliases, error: aErr } = await db
      .from('product_aliases')
      .select('id, product_id')
      .in('product_id', slice)
    if (aErr) throw new Error(`[recipe-cost] product_aliases lookup failed: ${aErr.message}`)
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
        .select('id, product_alias_id, price_per_unit, quantity, total_excl_vat, unit, invoice_date, currency')
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
    // Derive per-unit price. PDF-extracted price_per_unit is unreliable —
    // the model sometimes picks up the per-kg figure, a discounted unit
    // price, or a per-something-else number when the line shows multiple
    // numeric columns (per-unit + line total + discount + tax). The
    // ground-truth paid-per-unit IS total_excl_vat / quantity: the line
    // total is validated against the invoice header during extraction, so
    // it's much harder for the model to get wrong. Mutti Pizza sauce
    // 4,1kg jar example: PDF gave qty=3, price_per_unit=14.22, total=466.83;
    // 14.22/jar is implausible at ~155 SEK retail, but 466.83/3 = 155.61
    // is correct. Fall back to raw price_per_unit when qty + total aren't
    // both present (Fortnox-row source rows often only have one).
    const qty   = Number(l.quantity ?? 0)
    const total = Number(l.total_excl_vat ?? 0)
    let nativePrice: number
    if (Number.isFinite(qty) && qty > 0 && Number.isFinite(total) && total !== 0) {
      nativePrice = total / qty
    } else if (l.price_per_unit != null) {
      nativePrice = Number(l.price_per_unit)
    } else {
      continue
    }
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
      density_g_per_ml: existing?.density_g_per_ml ?? null,
      density_source:   existing?.density_source ?? null,
      weight_per_piece_g:      existing?.weight_per_piece_g ?? null,
      weight_per_piece_source: existing?.weight_per_piece_source ?? null,
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
  const BATCH_IN_PUBLIC = 100   // same rationale as BATCH_IN above (16 KB header cap)
  for (let i = 0; i < productIds.length; i += BATCH_IN_PUBLIC) {
    const slice = productIds.slice(i, i + BATCH_IN_PUBLIC)
    let prods: any[] | null = null
    if (DENSITY_COLUMNS_AVAILABLE) {
      const { data, error: pErr } = await db
        .from('products')
        .select('id, name, invoice_unit, pack_size, base_unit, source_recipe_id, price_override, price_override_currency, density_g_per_ml, density_source, weight_per_piece_g, weight_per_piece_source')
        .in('id', slice)
      if (pErr) {
        if ((pErr as any).code === '42703' || /density_g_per_ml.*does not exist/i.test(pErr.message) || /weight_per_piece_g.*does not exist/i.test(pErr.message)) {
          DENSITY_COLUMNS_AVAILABLE = false
        } else {
          throw new Error(`[recipe-cost] products(public) lookup failed: ${pErr.message}`)
        }
      } else {
        prods = data
      }
    }
    if (prods == null) {
      const { data, error: pErr } = await db
        .from('products')
        .select('id, name, invoice_unit, pack_size, base_unit, source_recipe_id, price_override, price_override_currency')
        .in('id', slice)
      if (pErr) throw new Error(`[recipe-cost] products(public) lookup failed: ${pErr.message}`)
      prods = data
    }
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
        density_g_per_ml:  (p as any).density_g_per_ml != null ? Number((p as any).density_g_per_ml) : null,
        density_source:    (p as any).density_source ?? null,
        weight_per_piece_g:      (p as any).weight_per_piece_g != null ? Number((p as any).weight_per_piece_g) : null,
        weight_per_piece_source: (p as any).weight_per_piece_source ?? null,
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

// ─────────────────────────────────────────────────────────────────────
// Price-trend reader
//
// Used by the edit-item modal to display "X% senaste veckan" alongside
// the current cost. Splits a product's recent supplier_invoice_lines into
// two windows (most-recent vs prior) and returns the delta as a signed
// percentage. Returns null when there's too little history — the modal
// MUST render that as honest absence ("ingen prishistorik") and not as
// "0.0% stable", per the prompt's honest-incomplete-state rule.
// ─────────────────────────────────────────────────────────────────────
export interface ProductPriceTrend {
  latest_price:  number
  prev_price:    number
  delta_pct:     number    // signed: positive = price rose
  latest_date:   string
  prev_date:     string
  window_days:   number
  data_points:   number    // total invoice lines used to compute the trend
}

export async function getProductPriceTrend(
  db: any,
  businessId: string,
  productId: string,
  windowDays = 7,
): Promise<ProductPriceTrend | null> {
  // Find aliases for this product (one product → may have several aliases
  // across suppliers/SKUs). All matched lines via those aliases feed the
  // trend reader — the trend is product-level, not alias-level.
  const { data: aliases } = await db
    .from('product_aliases')
    .select('id')
    .eq('business_id', businessId)
    .eq('product_id', productId)
    .eq('is_active', true)
  const aliasIds = (aliases ?? []).map((a: any) => a.id)
  if (aliasIds.length === 0) return null

  // Recent matched lines with the per-line ground-truth price (post-merge
  // we derive total/qty rather than trust raw price_per_unit).
  const { data: lines } = await db
    .from('supplier_invoice_lines')
    .select('invoice_date, quantity, total_excl_vat, price_per_unit')
    .eq('business_id', businessId)
    .eq('match_status', 'matched')
    .in('product_alias_id', aliasIds)
    .order('invoice_date', { ascending: false })
    .limit(50)
  if (!lines || lines.length < 2) return null

  // Per-line price = total / qty when both present (matches the engine's
  // ground-truth rule); fall back to raw price_per_unit otherwise.
  const priced = lines.map((l: any) => {
    const qty = Number(l.quantity ?? 0)
    const tot = Number(l.total_excl_vat ?? 0)
    const ppu = Number.isFinite(qty) && qty > 0 && Number.isFinite(tot) && tot !== 0
      ? tot / qty
      : (l.price_per_unit != null ? Number(l.price_per_unit) : null)
    return { date: l.invoice_date, ppu }
  }).filter((p: any) => p.ppu != null && Number.isFinite(p.ppu))
  if (priced.length < 2) return null

  // Latest = the single most-recent line. Prev = the most-recent line
  // outside the latest-window-days window. If no prior data point falls
  // beyond the window (e.g. the supplier ships weekly and all data is
  // from the last week), return null — owner sees "ingen prishistorik"
  // rather than a delta computed against a same-week sibling.
  const latest = priced[0]
  const latestTime = new Date(latest.date).getTime()
  const cutoffTime = latestTime - windowDays * 24 * 60 * 60 * 1000
  const prev = priced.slice(1).find((p: any) => new Date(p.date).getTime() < cutoffTime)
  if (!prev) return null

  const deltaPct = ((latest.ppu - prev.ppu) / Math.abs(prev.ppu)) * 100
  return {
    latest_price: Math.round(latest.ppu * 100) / 100,
    prev_price:   Math.round(prev.ppu   * 100) / 100,
    delta_pct:    Math.round(deltaPct * 10) / 10,
    latest_date:  latest.date,
    prev_date:    prev.date,
    window_days:  windowDays,
    data_points:  priced.length,
  }
}

// ─────────────────────────────────────────────────────────────────────
// Product-cost reliability signal
//
// FIRST-CLASS REQUIREMENT for the edit-item modal: surface when a
// product's price comes from an extraction the system itself doesn't
// trust. Without this, the modal would show e.g. "331 kr/kg" with quiet
// confidence on a Laweka product whose underlying invoice line is wrong
// by an order of magnitude (per-line value-extraction bug, pending fix).
//
// Two independent checks; if EITHER fires, the product is "unreliable":
//
//   1. Per-line internal inconsistency: the most-recent matched
//      supplier_invoice_line has quantity × price_per_unit ≉ total_excl_vat
//      (more than 5% off). This catches the Marini/Rima per-line bug
//      directly without needing to find the parent extraction record.
//
//   2. Parent extraction was flagged: the line's invoice has an
//      invoice_pdf_extractions row whose validation_warnings contains
//      'over_extraction' or 'total_mismatch'. Belt-and-braces against
//      future failure modes where the per-line numbers look internally
//      consistent but the aggregate extraction was wrong.
//
// Returns { reliable: true } when both checks pass, { reliable: false,
// reason } when either fires. Callers MUST render the reason; never
// silently default to "reliable" if the check errors.
// ─────────────────────────────────────────────────────────────────────
export interface ProductReliabilitySignal {
  reliable: boolean
  reason:   string | null     // owner-facing, in English (UI localises if needed)
  evidence: {
    invoice_number?:           string | null
    invoice_date?:             string | null
    qty?:                      number | null
    price_per_unit?:           number | null
    total_excl_vat?:           number | null
    extraction_warning_codes?: string[]
  } | null
}

const LINE_CONSISTENCY_TOL_PCT = 0.05   // qty × ppu within 5% of total_excl_vat

export async function getProductReliabilitySignal(
  db: any,
  businessId: string,
  productId: string,
): Promise<ProductReliabilitySignal> {
  const { data: aliases } = await db
    .from('product_aliases')
    .select('id')
    .eq('business_id', businessId)
    .eq('product_id', productId)
    .eq('is_active', true)
  const aliasIds = (aliases ?? []).map((a: any) => a.id)
  if (aliasIds.length === 0) {
    return { reliable: false, reason: 'No supplier invoice yet — price will be reliable once an invoice is matched', evidence: null }
  }

  const { data: lines } = await db
    .from('supplier_invoice_lines')
    .select('fortnox_invoice_number, invoice_date, quantity, price_per_unit, total_excl_vat')
    .eq('business_id', businessId)
    .eq('match_status', 'matched')
    .in('product_alias_id', aliasIds)
    .order('invoice_date', { ascending: false })
    .limit(1)
  const latest = (lines ?? [])[0]
  if (!latest) {
    return { reliable: false, reason: 'No matched invoice line yet', evidence: null }
  }

  // Check 1: per-line internal consistency.
  const qty = Number(latest.quantity ?? 0)
  const ppu = Number(latest.price_per_unit ?? 0)
  const tot = Number(latest.total_excl_vat ?? 0)
  if (Number.isFinite(qty) && qty > 0 && Number.isFinite(ppu) && Number.isFinite(tot) && tot !== 0) {
    const computed = qty * ppu
    const delta = Math.abs(computed - tot) / Math.abs(tot)
    if (delta > LINE_CONSISTENCY_TOL_PCT) {
      return {
        reliable: false,
        reason:   `Latest invoice line is internally inconsistent: qty × price_per_unit = ${computed.toFixed(2)} but total = ${tot.toFixed(2)} (${(delta * 100).toFixed(0)}% off). Price may be unreliable — extraction needs review.`,
        evidence: {
          invoice_number: latest.fortnox_invoice_number,
          invoice_date:   latest.invoice_date,
          qty, price_per_unit: ppu, total_excl_vat: tot,
        },
      }
    }
  }

  // Check 2: parent extraction was flagged. JSONB containment query.
  const { data: ext } = await db
    .from('invoice_pdf_extractions')
    .select('validation_warnings')
    .eq('business_id', businessId)
    .eq('fortnox_invoice_number', latest.fortnox_invoice_number)
    .maybeSingle()
  const warnings = Array.isArray(ext?.validation_warnings) ? ext.validation_warnings : []
  const flaggedCodes = warnings
    .map((w: any) => w?.code)
    .filter((c: any) => c === 'over_extraction' || c === 'total_mismatch')
  if (flaggedCodes.length > 0) {
    return {
      reliable: false,
      reason:   `The invoice this price came from is flagged (${flaggedCodes.join(', ')}). Price may be unreliable — extraction needs review.`,
      evidence: {
        invoice_number:           latest.fortnox_invoice_number,
        invoice_date:             latest.invoice_date,
        extraction_warning_codes: flaggedCodes,
      },
    }
  }

  return { reliable: true, reason: null, evidence: null }
}
