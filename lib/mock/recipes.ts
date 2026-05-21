// lib/mock/recipes.ts
//
// Phase 6 — vision data for Menyrecept. Each recipe references items
// from lib/mock/inventory.ts by id so the (one-day-real) item-master
// swap doesn't disturb the page-level rendering contract.

import { MOCK_INVENTORY_ITEMS } from './inventory'

export type RecipeType = 'Förrätt' | 'Pasta' | 'Pizza' | 'Huvudrätt' | 'Dessert' | 'Drink'

export interface MockRecipeIngredient {
  item_id: string
  qty:     number
  unit:    string
}

export interface MockRecipe {
  id:           string
  name:         string
  type:         RecipeType
  sale_price:   number   // SEK incl. VAT for menu pricing
  ingredients:  MockRecipeIngredient[]
}

// Compute the food cost for a recipe by pulling per-unit prices from the
// item master. Mock implementation; production would project per-pack
// price → per-unit cost using count_units conversions.
export function recipeFoodCost(recipe: MockRecipe): number {
  let sum = 0
  for (const ing of recipe.ingredients) {
    const item = MOCK_INVENTORY_ITEMS.find(i => i.id === ing.item_id)
    if (!item) continue
    // Crude unit ratio — every pack contains an opinionated "units per
    // pack" inferred from the order_unit string. Real maths lives in the
    // unit-conversion service that ships with Phase 6's follow-on.
    const unitsPerPack = inferUnitsPerPack(item.order_unit, ing.unit)
    if (!unitsPerPack) continue
    const perUnit = item.price_sek / unitsPerPack
    sum += perUnit * ing.qty
  }
  return Math.round(sum * 100) / 100
}

export function recipeGpPct(recipe: MockRecipe): number {
  const cost = recipeFoodCost(recipe)
  if (recipe.sale_price <= 0) return 0
  return ((recipe.sale_price - cost) / recipe.sale_price) * 100
}

function inferUnitsPerPack(orderUnit: string, requestedUnit: string): number {
  const ouLower = orderUnit.toLowerCase()
  const reqLower = requestedUnit.toLowerCase()
  // Naive heuristics — enough for the mock to render plausible food costs.
  const grams  = ouLower.match(/(\d+)\s*g\b/)
  const kilos  = ouLower.match(/(\d+(?:\.\d+)?)\s*kg/)
  const litres = ouLower.match(/(\d+(?:\.\d+)?)\s*l\b/)
  const ml     = ouLower.match(/(\d+)\s*ml/)
  const pack   = ouLower.match(/(\d+)\s*[x×]\s*/)
  const packQty = pack ? Number(pack[1]) : 1
  if (reqLower === 'g')   return (kilos ? Number(kilos[1]) * 1000 : grams ? Number(grams[1]) : 1000) * packQty
  if (reqLower === 'kg')  return (kilos ? Number(kilos[1]) : 1) * packQty
  if (reqLower === 'ml')  return (litres ? Number(litres[1]) * 1000 : ml ? Number(ml[1]) : 1000) * packQty
  if (reqLower === 'l')   return (litres ? Number(litres[1]) : 1) * packQty
  if (reqLower === 'st')  return packQty
  return 1
}

export const MOCK_RECIPES: MockRecipe[] = [
  {
    id: 'rcp-001', name: 'Margherita',
    type: 'Pizza', sale_price: 169,
    ingredients: [
      { item_id: 'inv-003', qty: 240, unit: 'g' },   // mjöl
      { item_id: 'inv-002', qty: 110, unit: 'g' },   // mozzarella
      { item_id: 'inv-001', qty: 120, unit: 'g' },   // san marzano
      { item_id: 'inv-004', qty: 12,  unit: 'ml' },  // olja
      { item_id: 'inv-010', qty: 4,   unit: 'g' },   // basilika
    ],
  },
  {
    id: 'rcp-002', name: 'Diavola',
    type: 'Pizza', sale_price: 189,
    ingredients: [
      { item_id: 'inv-003', qty: 240, unit: 'g' },
      { item_id: 'inv-002', qty: 110, unit: 'g' },
      { item_id: 'inv-001', qty: 120, unit: 'g' },
      { item_id: 'inv-006', qty: 35,  unit: 'g' },   // prosciutto stand-in
    ],
  },
  {
    id: 'rcp-003', name: 'Cacio e Pepe',
    type: 'Pasta', sale_price: 179,
    ingredients: [
      { item_id: 'inv-012', qty: 130, unit: 'g' },
      { item_id: 'inv-005', qty: 45,  unit: 'g' },
      { item_id: 'inv-004', qty: 15,  unit: 'ml' },
    ],
  },
  {
    id: 'rcp-004', name: 'Spaghetti al pomodoro',
    type: 'Pasta', sale_price: 159,
    ingredients: [
      { item_id: 'inv-012', qty: 130, unit: 'g' },
      { item_id: 'inv-001', qty: 200, unit: 'g' },
      { item_id: 'inv-013', qty: 80,  unit: 'g' },
      { item_id: 'inv-010', qty: 6,   unit: 'g' },
      { item_id: 'inv-004', qty: 18,  unit: 'ml' },
    ],
  },
  {
    id: 'rcp-005', name: 'Prosciutto e Melone',
    type: 'Förrätt', sale_price: 145,
    ingredients: [
      { item_id: 'inv-006', qty: 60, unit: 'g' },
    ],
  },
  {
    id: 'rcp-006', name: 'Tiramisu, husets',
    type: 'Dessert', sale_price: 119,
    ingredients: [
      { item_id: 'inv-014', qty: 20, unit: 'g' },  // espresso
      { item_id: 'inv-005', qty: 25, unit: 'g' },  // hård ost stand-in
    ],
  },
  {
    id: 'rcp-007', name: 'Glas Pinot Grigio',
    type: 'Drink', sale_price: 109,
    ingredients: [
      { item_id: 'inv-007', qty: 1, unit: 'glas' },
    ],
  },
  {
    id: 'rcp-008', name: 'Glas Chianti Classico',
    type: 'Drink', sale_price: 125,
    ingredients: [
      { item_id: 'inv-008', qty: 1, unit: 'flaska' },
    ],
  },
]

export const MOCK_RECIPES_TOTAL = 47
