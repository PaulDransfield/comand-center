// lib/inventory/taxonomy.ts
//
// Owner-readable product taxonomy. Two-level: top-level `category`
// (already on products) → `sub_category` (M137, this file is the
// canonical list).
//
// The top level has always been: food | beverage | alcohol | cleaning
// | takeaway_material | disposables | other. We don't touch that.
//
// Sub-categories are designed to:
//   1. Group the way a restaurant owner thinks about ordering. Cream
//      sits with butter and milk (dairy), not with sauces. Wine is
//      split by colour because pricing/cellar behaviour differs.
//   2. Match the granularity Swedish suppliers use natively (MS
//      category_path follows similar splits — easier mapping).
//   3. Stay stable as the product universe grows. Adding a new SKU
//      should NEVER require adding a new sub-category — these are
//      buckets, not categories of one.
//   4. Be small enough (~50) for filter pills to be usable. Not so
//      small that "all food" collapses everything.
//
// Naming: snake_case to match the DB convention. Prefix groups so
// they sort together alphabetically (dairy_*, meat_*, etc.).
//
// Labels are owner-facing English. Locale handled at UI layer if
// needed; the value stored in the DB is the key.

export const SUB_CATEGORIES = {
  // ── Food: dairy ──────────────────────────────────────────────────
  dairy_milk:           { label: 'Milk',                            top: 'food', allergens: ['dairy'] },
  dairy_cheese:         { label: 'Cheese',                          top: 'food', allergens: ['dairy'] },
  dairy_butter:         { label: 'Butter & margarine',              top: 'food', allergens: ['dairy'] },
  dairy_cream:          { label: 'Cream & crème fraîche',           top: 'food', allergens: ['dairy'] },
  dairy_yogurt:         { label: 'Yogurt & quark',                  top: 'food', allergens: ['dairy'] },
  dairy_other:          { label: 'Other dairy',                     top: 'food', allergens: ['dairy'] },
  dairy_eggs:           { label: 'Eggs',                            top: 'food', allergens: ['eggs'] },

  // ── Food: meat & poultry ─────────────────────────────────────────
  meat_beef:            { label: 'Beef',                            top: 'food', allergens: [] },
  meat_pork:            { label: 'Pork',                            top: 'food', allergens: [] },
  meat_lamb:            { label: 'Lamb',                            top: 'food', allergens: [] },
  meat_game:            { label: 'Game (venison, wild boar, etc.)', top: 'food', allergens: [] },
  meat_poultry:         { label: 'Poultry',                         top: 'food', allergens: [] },
  meat_charcuterie:     { label: 'Charcuterie & cured',             top: 'food', allergens: [] },
  meat_sausage:         { label: 'Sausages',                        top: 'food', allergens: [] },
  meat_offal:           { label: 'Offal',                           top: 'food', allergens: [] },

  // ── Food: fish & seafood ─────────────────────────────────────────
  fish_fresh:           { label: 'Fresh fish',                      top: 'food', allergens: ['fish'] },
  fish_frozen:          { label: 'Frozen fish',                     top: 'food', allergens: ['fish'] },
  fish_smoked:          { label: 'Smoked & cured fish',             top: 'food', allergens: ['fish'] },
  fish_preserved:       { label: 'Tinned & preserved fish',         top: 'food', allergens: ['fish'] },
  shellfish:            { label: 'Shellfish',                       top: 'food', allergens: ['shellfish'] },

  // ── Food: produce ────────────────────────────────────────────────
  produce_vegetables:   { label: 'Vegetables',                      top: 'food', allergens: [] },
  produce_fruit:        { label: 'Fruit',                           top: 'food', allergens: [] },
  produce_herbs:        { label: 'Fresh herbs',                     top: 'food', allergens: [] },
  produce_mushrooms:    { label: 'Mushrooms',                       top: 'food', allergens: [] },
  produce_salad:        { label: 'Salad & leaves',                  top: 'food', allergens: [] },

  // ── Food: grains, pasta, baked ───────────────────────────────────
  grain_pasta:          { label: 'Pasta',                           top: 'food', allergens: ['gluten'] },
  grain_rice:           { label: 'Rice',                            top: 'food', allergens: [] },
  grain_flour:          { label: 'Flour & meals',                   top: 'food', allergens: ['gluten'] },
  grain_other:          { label: 'Other grains',                    top: 'food', allergens: ['gluten'] },
  bakery_bread:         { label: 'Bread',                           top: 'food', allergens: ['gluten'] },
  bakery_pastry:        { label: 'Pastry & viennoiserie',           top: 'food', allergens: ['gluten', 'dairy', 'eggs'] },

  // ── Food: oils, sauces, seasonings ───────────────────────────────
  oils_fats:            { label: 'Oils & fats',                     top: 'food', allergens: [] },
  vinegars:             { label: 'Vinegars',                        top: 'food', allergens: [] },
  sauces_condiments:    { label: 'Sauces & condiments',             top: 'food', allergens: [] },
  spices_seasonings:    { label: 'Spices & seasonings',             top: 'food', allergens: [] },
  salt_sugar:           { label: 'Salt, sugar & syrups',            top: 'food', allergens: [] },
  stock_bouillon:       { label: 'Stock & bouillon',                top: 'food', allergens: [] },

  // ── Food: preserved & dry ────────────────────────────────────────
  canned_preserved:     { label: 'Canned & preserved',              top: 'food', allergens: [] },
  dried_legumes:        { label: 'Dried legumes & beans',           top: 'food', allergens: [] },
  nuts_seeds:           { label: 'Nuts & seeds',                    top: 'food', allergens: ['nuts'] },
  dried_fruit:          { label: 'Dried fruit',                     top: 'food', allergens: [] },

  // ── Food: other ──────────────────────────────────────────────────
  chocolate_confectionery: { label: 'Chocolate & confectionery',    top: 'food', allergens: ['dairy', 'soy'] },
  ice_cream:            { label: 'Ice cream & frozen dessert',      top: 'food', allergens: ['dairy', 'eggs'] },
  prepared_meals:       { label: 'Prepared meals & components',     top: 'food', allergens: [] },
  food_other:           { label: 'Other food',                      top: 'food', allergens: [] },

  // ── Beverage (non-alcoholic) ─────────────────────────────────────
  bev_water:            { label: 'Water',                           top: 'beverage', allergens: [] },
  bev_soft_drinks:      { label: 'Soft drinks',                     top: 'beverage', allergens: [] },
  bev_juice:            { label: 'Juice & smoothies',               top: 'beverage', allergens: [] },
  bev_coffee:           { label: 'Coffee',                          top: 'beverage', allergens: [] },
  bev_tea:              { label: 'Tea',                             top: 'beverage', allergens: [] },
  bev_dairy_drinks:     { label: 'Dairy drinks',                    top: 'beverage', allergens: ['dairy'] },
  bev_energy:           { label: 'Energy & sports drinks',          top: 'beverage', allergens: [] },
  bev_mixers:           { label: 'Mixers & syrups',                 top: 'beverage', allergens: [] },
  bev_other:            { label: 'Other beverage',                  top: 'beverage', allergens: [] },

  // ── Alcohol ──────────────────────────────────────────────────────
  alc_beer:             { label: 'Beer',                            top: 'alcohol', allergens: ['gluten'] },
  alc_cider:            { label: 'Cider',                           top: 'alcohol', allergens: [] },
  alc_wine_red:         { label: 'Red wine',                        top: 'alcohol', allergens: ['sulphites'] },
  alc_wine_white:       { label: 'White wine',                      top: 'alcohol', allergens: ['sulphites'] },
  alc_wine_rose:        { label: 'Rosé wine',                       top: 'alcohol', allergens: ['sulphites'] },
  alc_wine_sparkling:   { label: 'Sparkling wine',                  top: 'alcohol', allergens: ['sulphites'] },
  alc_wine_dessert:     { label: 'Dessert & fortified wine',        top: 'alcohol', allergens: ['sulphites'] },
  alc_spirits:          { label: 'Spirits',                         top: 'alcohol', allergens: [] },
  alc_liqueur:          { label: 'Liqueurs & aperitifs',            top: 'alcohol', allergens: [] },
  alc_rtd:              { label: 'RTD & pre-mixed',                 top: 'alcohol', allergens: [] },

  // ── Cleaning ─────────────────────────────────────────────────────
  cleaning_chemicals:   { label: 'Cleaning chemicals',              top: 'cleaning', allergens: [] },
  cleaning_supplies:    { label: 'Cleaning supplies & tools',       top: 'cleaning', allergens: [] },
  cleaning_dish:        { label: 'Dishwashing',                     top: 'cleaning', allergens: [] },
  cleaning_laundry:     { label: 'Laundry & linen',                 top: 'cleaning', allergens: [] },
  hygiene:              { label: 'Personal hygiene',                top: 'cleaning', allergens: [] },

  // ── Takeaway material & packaging ────────────────────────────────
  takeaway_containers:  { label: 'Takeaway containers',             top: 'takeaway_material', allergens: [] },
  takeaway_cutlery:     { label: 'Takeaway cutlery & napkins',      top: 'takeaway_material', allergens: [] },
  takeaway_bags:        { label: 'Bags & wraps',                    top: 'takeaway_material', allergens: [] },

  // ── Disposables (in-house) ───────────────────────────────────────
  paper_napkins:        { label: 'Napkins & tissues',               top: 'disposables', allergens: [] },
  paper_general:        { label: 'Paper goods',                     top: 'disposables', allergens: [] },
  gloves_apron:         { label: 'Gloves & aprons',                 top: 'disposables', allergens: [] },
  film_foil:            { label: 'Film, foil & baking paper',       top: 'disposables', allergens: [] },

  // ── Other catch-alls ─────────────────────────────────────────────
  kitchen_equipment:    { label: 'Kitchen equipment & smallwares',  top: 'other', allergens: [] },
  uncategorised:        { label: 'Uncategorised',                   top: 'other', allergens: [] },
} as const

export type SubCategory = keyof typeof SUB_CATEGORIES

// ── Storage types ──────────────────────────────────────────────────
// Match MS's own vocabulary (Swedish): fryst / kyl / rum. Storing
// English keys for code; surface localised label at UI layer if needed.
export const STORAGE_TYPES = ['frozen', 'refrigerated', 'ambient'] as const
export type StorageType = typeof STORAGE_TYPES[number]

// ── Allergens ──────────────────────────────────────────────────────
// Swedish Livsmedelsverket's 14 major allergens, lower-cased keys.
// `sulphites` non-standard but included because alc/wine flagging is
// expected. Add 'mustard', 'sesame' etc. when actually used.
export const ALLERGENS = [
  'dairy',
  'eggs',
  'gluten',
  'fish',
  'shellfish',
  'molluscs',
  'nuts',
  'peanuts',
  'soy',
  'celery',
  'mustard',
  'sesame',
  'sulphites',
  'lupin',
] as const
export type Allergen = typeof ALLERGENS[number]

// ── Classification provenance ──────────────────────────────────────
export const CLASSIFICATION_SOURCES = [
  'owner',              // manual override — highest priority
  'supplier_articles',  // from supplier_articles.category_path via mapper
  'cross_customer',     // copied from another customer with same supplier+article
  'brand_learned',      // M138 — auto-learned global brand → sub_category
  'openfoodfacts',      // GTIN lookup
  'web_llm',            // Brave/Tavily search + LLM
  'name_llm',           // last-resort LLM from product name only
] as const
export type ClassificationSource = typeof CLASSIFICATION_SOURCES[number]

// ── Helpers ────────────────────────────────────────────────────────
export function subCategoryLabel(key: string | null | undefined): string {
  if (!key) return 'Uncategorised'
  const slot = (SUB_CATEGORIES as any)[key]
  return slot?.label ?? key
}
export function subCategoriesForTop(top: string): Array<{ key: SubCategory; label: string }> {
  return Object.entries(SUB_CATEGORIES)
    .filter(([, v]) => v.top === top)
    .map(([key, v]) => ({ key: key as SubCategory, label: v.label }))
    .sort((a, b) => a.label.localeCompare(b.label))
}
export function defaultAllergensFor(sub: SubCategory | null | undefined): string[] {
  if (!sub) return []
  const slot = (SUB_CATEGORIES as any)[sub]
  return slot?.allergens ?? []
}
