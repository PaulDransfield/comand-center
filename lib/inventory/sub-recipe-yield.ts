// lib/inventory/sub-recipe-yield.ts
//
// Shared sub-recipe yield resolution.
//
// Both the cost engine (lib/inventory/recipe-cost.ts) and the prep-list
// engine (lib/inventory/prep-list.ts) recurse through sub-recipes and
// have to convert "X recipe-units of sub Y" into a sub-batch multiplier
// PLUS a display qty in the sub's natural prep unit. The yield math is
// identical between them; the accumulation logic (money vs quantity) is
// not. Putting the math here means a future M111-style change to the
// yield model lands in ONE place, not two.
//
// Returned shape is a discriminated union — each engine pattern-matches
// on the kind and applies its own accumulator.

import { convertQuantity } from './unit-conversion'

export interface SubYieldInputs {
  /** The qty the parent recipe asked for in `recipeUnit`. */
  adjustedQty:  number
  /** The unit the parent recipe specified (e.g. "g", "ml", "portion"). */
  recipeUnit:   string | null
  /** Sub-recipe's portion count (defines what "1 portion" of the sub means). */
  subPortions:  number
  /** Sub-recipe's yield_amount (M111). NULL when yield is not set. */
  yieldAmount:  number | null
  /** Sub-recipe's yield_unit (M111). NULL when yield is not set. */
  yieldUnit:    string | null
}

export type SubYieldResolution =
  // Parent recipe asked in 'portion'. Just multiplies by ing.quantity.
  // No yield needed. portionMultiplier = adjustedQty / subPortions.
  | {
      kind:              'portions'
      portionMultiplier: number
      qtyInDisplayUnit:  number
      displayUnit:       'portion'
    }
  // Parent asked in mass/volume AND yield set + units reconcile.
  // portionMultiplier = (qtyInYieldUnit / yieldAmount) / subPortions.
  | {
      kind:              'mass_or_volume'
      portionMultiplier: number
      qtyInDisplayUnit:  number
      displayUnit:       string
    }
  // Parent asked in mass/volume, yield set, but families don't reconcile
  // (e.g. parent wants ml of a g-yield sauce). Engine: surface uncertain.
  | {
      kind:        'unit_mismatch'
      displayUnit: string
    }
  // Parent asked in mass/volume but yield wasn't set on the sub.
  // Engine: surface uncertain, accumulate the parent's qty as-is for
  // display only ("you need to prep this much sub, somehow").
  | {
      kind:             'no_yield'
      qtyInDisplayUnit: number
      displayUnit:      string
    }

export function resolveSubRecipeYield(inputs: SubYieldInputs): SubYieldResolution {
  const { adjustedQty, subPortions, yieldAmount, yieldUnit } = inputs
  const recipeUnit = inputs.recipeUnit ?? 'portion'
  const safePortions = subPortions > 0 ? subPortions : 1

  if (recipeUnit === 'portion') {
    return {
      kind:              'portions',
      portionMultiplier: adjustedQty / safePortions,
      qtyInDisplayUnit:  adjustedQty,
      displayUnit:       'portion',
    }
  }

  if (yieldAmount != null && yieldUnit) {
    const qtyInYieldUnit = convertQuantity(adjustedQty, recipeUnit, yieldUnit)
    if (qtyInYieldUnit == null) {
      return { kind: 'unit_mismatch', displayUnit: yieldUnit }
    }
    const portionEquiv = qtyInYieldUnit / yieldAmount
    return {
      kind:              'mass_or_volume',
      portionMultiplier: portionEquiv / safePortions,
      qtyInDisplayUnit:  qtyInYieldUnit,
      displayUnit:       yieldUnit,
    }
  }

  return {
    kind:             'no_yield',
    qtyInDisplayUnit: adjustedQty,
    displayUnit:      recipeUnit,
  }
}
