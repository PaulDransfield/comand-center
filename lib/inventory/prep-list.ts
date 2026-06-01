// lib/inventory/prep-list.ts
//
// Prep-list quantity aggregator. Mirrors computeRecipeCost's recursion
// shape (graph walk + ancestor cycle-guard + M111 sub-recipe yield
// conversion) but accumulates QUANTITY instead of money.
//
// Input:  [{ recipe_id, qty }] — owner's expected production
// Output: two grouped lists:
//   - components: sub-recipes to prep, summed across all dishes that use
//     them. "Pinsa Red Sauce 6700 g" when Margherita + Pinsa Parma share
//     it. Cook reads as "make this much of each component."
//   - products: raw ingredients to pull, summed across all uses (both
//     direct dish ingredients AND transitive sub-recipe consumption).
//     "Tomato 5564 g" when 2.8 kg goes into sauce + 0.75 kg goes into a
//     garnish. Cook reads as "pull this much from the walk-in."
//
// Honest-incomplete rule (matches the cost engine):
//   - sub-recipe consumed in mass/volume but no yield set → component
//     line surfaces with `uncertain: 'sub_no_yield'`; transitive raw
//     ingredients NOT aggregated for that sub (we cannot safely convert
//     to portions).
//   - sub-recipe consumed in unit family ≠ yield family → component line
//     surfaces with `uncertain: 'unit_mismatch'`; transitive ingredients
//     not aggregated.
//   - sub-recipe is part of a cycle → component line `uncertain: 'cycle'`.
//
// Waste handling: matches the cost engine. loadRecipeIndex inflates
// `quantity` for waste_pct already; this walker reads `quantity` so prep
// totals include the waste allowance — the cook prepping should account
// for trim/cook-down/spillage. `quantity_stated` is the raw entered
// amount, kept around purely for transparency.

import type { RecipeIndex, IngredientForCosting } from './recipe-cost'
import { canonicalUnit, convertQuantity, unitFamily, baseUnitForFamily } from './unit-conversion'

export interface PrepListInput {
  recipe_id: string
  qty:       number   // covers (number of portions of this dish)
}

export interface PrepComponentLine {
  subrecipe_id:   string
  name:           string | null
  total_qty:      number          // accumulated qty in `unit`
  unit:           string          // the natural prep unit: sub's yield_unit if set, else 'portion'
  source_recipes: string[]        // parent dish recipe_ids contributing to this line
  uncertain:      null | 'sub_no_yield' | 'unit_mismatch' | 'cycle'
  // When uncertain, this is the human-readable cause line that the UI
  // can surface directly without translating internal codes.
  uncertain_reason: string | null
}

export interface PrepProductLine {
  product_id:     string
  name:           string | null
  total_qty:      number          // accumulated in `unit`
  unit:           string          // canonical unit (g | ml | st when family resolves; else whatever the recipe used)
  source_recipes: string[]        // parent dish recipe_ids contributing (transitively if through a sub)
}

export interface PrepListResult {
  components: PrepComponentLine[]
  products:   PrepProductLine[]
  flags:      Array<{ recipe_id: string; reason: string }>
}

interface SubAccum {
  total_qty:        number
  unit:             string
  source_recipes:   Set<string>
  uncertain:        null | 'sub_no_yield' | 'unit_mismatch' | 'cycle'
  uncertain_reason: string | null
}

interface ProductAccum {
  total_qty:      number
  unit:           string     // canonical (g/ml/st) when resolvable; falls back to first-seen unit
  family:         'mass' | 'volume' | 'count' | null
  source_recipes: Set<string>
}

export function aggregatePrepRequirements(
  input:       PrepListInput[],
  recipeIndex: RecipeIndex,
  recipeNames: Map<string, string | null>,
): PrepListResult {
  const subs:     Map<string, SubAccum>     = new Map()
  const products: Map<string, ProductAccum> = new Map()
  const flags:    Array<{ recipe_id: string; reason: string }> = []

  // Recursive walker. `multiplier` is the cover count this branch is
  // being expanded for — at the top level it's the entered qty; inside
  // a sub-recipe expansion it's `portionEquivalent / sub.portions` so
  // each leaf product gets scaled by "fraction of one batch of sub".
  function walk(
    recipeId:     string,
    multiplier:   number,
    rootRecipeId: string,
    ancestors:    Set<string>,
  ): void {
    if (ancestors.has(recipeId)) {
      flags.push({ recipe_id: recipeId, reason: 'cycle detected — skipped' })
      return
    }
    const entry = recipeIndex.get(recipeId)
    if (!entry) {
      flags.push({ recipe_id: recipeId, reason: 'recipe not found in index — skipped' })
      return
    }
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(recipeId)

    for (const ing of entry.ingredients) {
      const adjustedQty = ing.quantity * multiplier

      if (ing.subrecipe_id) {
        handleSub(ing, adjustedQty, rootRecipeId, nextAncestors)
        continue
      }
      if (ing.product_id) {
        accProduct(ing.product_id, ing.product_name, adjustedQty, ing.unit, rootRecipeId)
      }
    }
  }

  function handleSub(
    ing:          IngredientForCosting,
    adjustedQty:  number,    // already × multiplier
    rootRecipeId: string,
    ancestors:    Set<string>,
  ): void {
    const subId   = ing.subrecipe_id!
    const subName = ing.subrecipe_name
    const subEntry = recipeIndex.get(subId)

    // Cycle: sub is one of our ancestors. Surface as uncertain component
    // line, do NOT recurse.
    if (ancestors.has(subId)) {
      const slot = ensureSubSlot(subs, subId, ing.unit ?? 'portion')
      slot.uncertain = 'cycle'
      slot.uncertain_reason = `Cycle detected involving "${subName ?? subId.slice(0, 8)}" — not expanded.`
      slot.source_recipes.add(rootRecipeId)
      return
    }

    if (!subEntry || subEntry.portions <= 0) {
      // No sub data — flag component line uncertain
      const slot = ensureSubSlot(subs, subId, ing.unit ?? 'portion')
      slot.uncertain = 'sub_no_yield'
      slot.uncertain_reason = `Sub-recipe "${subName ?? subId.slice(0, 8)}" has no portion count — can't aggregate.`
      slot.source_recipes.add(rootRecipeId)
      return
    }

    const recipeUnit = ing.unit ?? 'portion'

    // Component-line accumulation: how much of this sub the cook needs
    // to prep, in the sub's natural prep unit.
    //   - yield set: roll up in the yield_unit (g/ml/portion)
    //   - no yield set: roll up in portions if the recipe used 'portion';
    //     otherwise flag uncertain (the cook can't be told "prep 250 g"
    //     of something they only know as portions).

    if (recipeUnit === 'portion') {
      const slot = ensureSubSlot(subs, subId, 'portion')
      slot.total_qty += adjustedQty
      slot.source_recipes.add(rootRecipeId)
      // Recurse into the sub for raw ingredients: each entered portion
      // corresponds to (1 / sub.portions) of a sub-batch.
      const subMultiplier = adjustedQty / subEntry.portions
      walk(subId, subMultiplier, rootRecipeId, ancestors)
      return
    }

    // Recipe asks in mass/volume. Need yield to convert.
    if (subEntry.yield_amount && subEntry.yield_unit) {
      const qtyInYieldUnit = convertQuantity(adjustedQty, recipeUnit, subEntry.yield_unit)
      if (qtyInYieldUnit == null) {
        // Family mismatch (e.g. recipe ml of g-yield sauce). Flag.
        const slot = ensureSubSlot(subs, subId, subEntry.yield_unit)
        slot.uncertain = 'unit_mismatch'
        slot.uncertain_reason = `Sub-recipe "${subName ?? subId.slice(0, 8)}" yield is ${subEntry.yield_unit} but recipe asks in ${recipeUnit} — units don't reconcile.`
        slot.source_recipes.add(rootRecipeId)
        return
      }
      const slot = ensureSubSlot(subs, subId, subEntry.yield_unit)
      slot.total_qty += qtyInYieldUnit
      slot.source_recipes.add(rootRecipeId)
      // Recurse — convert to portion equivalent for the leaf walk:
      //   qty_in_yield_unit / yield_amount = portion_equivalent
      //   portion_equivalent / sub.portions = sub-batch multiplier
      const portionEquiv = qtyInYieldUnit / subEntry.yield_amount
      const subMultiplier = portionEquiv / subEntry.portions
      walk(subId, subMultiplier, rootRecipeId, ancestors)
      return
    }

    // Recipe asks in mass/volume but no yield set. Honest-incomplete:
    // component line shown as uncertain, raw ingredients NOT aggregated
    // for this sub (we'd be guessing).
    const slot = ensureSubSlot(subs, subId, recipeUnit)
    slot.total_qty += adjustedQty
    slot.uncertain = 'sub_no_yield'
    slot.uncertain_reason = `Sub-recipe "${subName ?? subId.slice(0, 8)}" has no yield set — can't roll up its raw ingredients. Set yield on the sub to fix.`
    slot.source_recipes.add(rootRecipeId)
  }

  function accProduct(
    productId:    string,
    productName:  string | null,
    qty:          number,
    rawUnit:      string | null,
    rootRecipeId: string,
  ): void {
    const fam = unitFamily(rawUnit)
    const targetUnit = fam ? baseUnitForFamily(fam) : (canonicalUnit(rawUnit) ?? rawUnit ?? 'st')

    // If we've seen this product before with a different family, that's
    // a genuine inconsistency — leave the first family in place and add
    // the new contribution under a separate flag rather than mixing
    // grams + ml into one number.
    const existing = products.get(productId)
    if (existing && existing.family && fam && existing.family !== fam) {
      flags.push({
        recipe_id: rootRecipeId,
        reason:    `Product "${productName ?? productId.slice(0, 8)}" used in ${rawUnit} can't combine with prior ${existing.unit} entries — kept the first family's total.`,
      })
      return
    }

    // Convert the new qty into the slot's canonical target unit when
    // both are in the same family. If not in a family at all, accumulate
    // raw (e.g. 'st' counts).
    let qtyForSlot = qty
    if (fam) {
      const converted = convertQuantity(qty, rawUnit, targetUnit)
      if (converted == null) {
        flags.push({
          recipe_id: rootRecipeId,
          reason:    `Product "${productName ?? productId.slice(0, 8)}" qty in ${rawUnit} couldn't convert to ${targetUnit} — skipped from rollup.`,
        })
        return
      }
      qtyForSlot = converted
    }

    if (!existing) {
      products.set(productId, {
        total_qty:      qtyForSlot,
        unit:           targetUnit,
        family:         fam ?? null,
        source_recipes: new Set([rootRecipeId]),
      })
    } else {
      existing.total_qty += qtyForSlot
      existing.source_recipes.add(rootRecipeId)
    }
  }

  // Top-level: walk every entered dish at its requested cover count.
  for (const item of input) {
    if (!item.recipe_id || !Number.isFinite(item.qty) || item.qty <= 0) continue
    walk(item.recipe_id, item.qty, item.recipe_id, new Set())
  }

  // Build output. Sort components by source-count desc (the most-shared
  // sub-recipes are the highest-value lines), then by total_qty desc.
  // Products: sort by total weight/count desc.
  const componentsOut: PrepComponentLine[] = [...subs.entries()].map(([id, s]) => ({
    subrecipe_id:     id,
    name:             recipeNames.get(id) ?? null,
    total_qty:        round2(s.total_qty),
    unit:             s.unit,
    source_recipes:   [...s.source_recipes],
    uncertain:        s.uncertain,
    uncertain_reason: s.uncertain_reason,
  }))
  componentsOut.sort((a, b) => {
    if (b.source_recipes.length !== a.source_recipes.length) {
      return b.source_recipes.length - a.source_recipes.length
    }
    return b.total_qty - a.total_qty
  })

  const productsOut: PrepProductLine[] = [...products.entries()].map(([id, p]) => ({
    product_id:     id,
    name:           null,            // caller fills from products table
    total_qty:      round2(p.total_qty),
    unit:           p.unit,
    source_recipes: [...p.source_recipes],
  }))
  productsOut.sort((a, b) => b.total_qty - a.total_qty)

  return { components: componentsOut, products: productsOut, flags }
}

function ensureSubSlot(map: Map<string, SubAccum>, id: string, unit: string): SubAccum {
  const existing = map.get(id)
  if (existing) return existing
  const fresh: SubAccum = {
    total_qty:        0,
    unit,
    source_recipes:   new Set<string>(),
    uncertain:        null,
    uncertain_reason: null,
  }
  map.set(id, fresh)
  return fresh
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// Render a (qty, unit) pair in the most readable form for kitchen
// display. 4000 g → "4 kg". 1500 ml → "1.5 l". Counts stay as st.
// Returns the same unit string when no rescale applies.
export function formatPrepQty(qty: number, unit: string): { qty: number; unit: string } {
  if (unit === 'g' && qty >= 1000) {
    return { qty: round2(qty / 1000), unit: 'kg' }
  }
  if (unit === 'ml' && qty >= 1000) {
    return { qty: round2(qty / 1000), unit: 'l' }
  }
  return { qty: round2(qty), unit }
}
