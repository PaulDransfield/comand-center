// lib/inventory/promoted-product-pack.ts
//
// Single source of truth for how a promoted sub-recipe (M089) maps onto
// the catalogue product's pack model, so it can be counted BY WEIGHT (or
// volume) in stock takes instead of only by whole portions.
//
// Why this works — the pricing invariant:
//   getProductLatestPrices() values a recipe-sourced product at the
//   recipe's LIVE cost-per-portion:  perPortion = food_cost / portions.
//   The stock-count valuation is:    lineValue = qtyInBase × perPortion / pack_size.
//
//   A recipe's yield (M111) is PER PORTION — yield_amount/yield_unit means
//   "one portion = yield_amount of yield_unit" (e.g. 250 g). So if we set
//        base_unit = the yield's base (g | ml)
//        pack_size = yield_amount expressed in that base   (per-portion size)
//   then  perPortion / pack_size = (food_cost/portions) / (grams/portion)
//                                = food_cost / total_grams  =  price per gram.
//   Counting 2 kg of sauce → 2000 g × price-per-gram → correct value.
//
//   invoice_unit stays 'portion' because perPortion is a per-portion price
//   (the count page shows "X kr/portion · 250 g/pack", which reads true).
//
// When the recipe has no yield, or a count-based ('st') yield, we fall back
// to the portion model (pack_size 1, base_unit 'st') — counted in pieces.

import { unitFamily, baseUnitForFamily, convertQuantity } from './unit-conversion'

export interface RecipeYieldShape {
  yield_amount: number | null
  yield_unit:   string | null
}

export interface PromotedPackFields {
  invoice_unit: string
  pack_size:    number
  base_unit:    string
  /** 'weight' | 'volume' = countable by mass/volume; 'portion' = pieces only. */
  count_mode:   'weight' | 'volume' | 'portion'
}

export function packFieldsForPromotedRecipe(recipe: RecipeYieldShape): PromotedPackFields {
  const ya = recipe.yield_amount
  const yu = recipe.yield_unit
  if (ya != null && Number(ya) > 0 && yu) {
    const fam = unitFamily(yu)
    if (fam === 'mass' || fam === 'volume') {
      const base = baseUnitForFamily(fam)                  // 'g' | 'ml'
      const packInBase = convertQuantity(Number(ya), yu, base)  // per-portion size in base unit
      if (packInBase != null && packInBase > 0) {
        return {
          invoice_unit: 'portion',
          pack_size:    Math.round(packInBase * 1000) / 1000,
          base_unit:    base,
          count_mode:   fam === 'mass' ? 'weight' : 'volume',
        }
      }
    }
  }
  // No yield, count-based yield, or a unit we can't reconcile → pieces.
  return { invoice_unit: 'portion', pack_size: 1, base_unit: 'st', count_mode: 'portion' }
}
