// lib/inventory/openfoodfacts.ts
//
// Thin client for the OpenFoodFacts v2 product API. Used by the
// classification cascade as source #4 when the product has a GTIN
// and the supplier_articles + cross_customer passes didn't yield
// a sub_category.
//
// OpenFoodFacts is free, no API key required. ~3M EU products
// indexed by GTIN. Hit rate on Swedish supplier catalogues is
// roughly 60-80% for branded packaged goods, much lower for
// fresh produce and supplier-specific bulk items.
//
// Required User-Agent header per OFF terms of service.

import { SUB_CATEGORIES, type SubCategory } from './taxonomy'

const UA = 'CommandCenter/1.0 (paul@comandcenter.se)'

export interface OffLookupResult {
  found:        true
  product_name: string | null
  brand:        string | null
  categories:   string[]               // free-form category strings from OFF
  allergens:    string[]               // OFF allergen tags, lower-cased
  image_url:    string | null
  raw:          any                    // for debugging
}
export interface OffLookupMiss {
  found:    false
  reason:   'not_found' | 'http_error' | 'invalid_gtin'
  status?:  number
}
export type OffLookup = OffLookupResult | OffLookupMiss

/**
 * Look up a single GTIN against OpenFoodFacts. Returns `found: false`
 * with a reason instead of throwing — caller can fall through to the
 * next cascade source.
 */
export async function lookupGtin(rawGtin: string | null | undefined): Promise<OffLookup> {
  if (!rawGtin) return { found: false, reason: 'invalid_gtin' }
  const gtin = String(rawGtin).trim()
  if (!/^[0-9]{8,14}$/.test(gtin)) return { found: false, reason: 'invalid_gtin' }

  // OFF stores barcodes WITHOUT GS1 leading-zero padding — strip the
  // leading zero on 14-digit GTINs so we hit their canonical record.
  const candidate = gtin.length === 14 && gtin.startsWith('0') ? gtin.slice(1) : gtin

  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${candidate}.json`, {
      headers: { 'User-Agent': UA },
      // OFF's CDN responds fast (~100-200ms typical) so no need for a
      // long timeout — but bound it so the cascade can't hang.
      signal: AbortSignal.timeout(5_000),
    })
    if (!r.ok) return { found: false, reason: 'http_error', status: r.status }
    const j: any = await r.json()
    if (j?.status !== 1 || !j?.product) return { found: false, reason: 'not_found' }
    const p = j.product
    const categories = Array.isArray(p.categories_tags)
      ? p.categories_tags.map((c: string) => c.replace(/^[a-z]{2}:/, ''))
      : (typeof p.categories === 'string' ? p.categories.split(',').map((s: string) => s.trim()) : [])
    const allergens = Array.isArray(p.allergens_tags)
      ? p.allergens_tags.map((a: string) => a.replace(/^[a-z]{2}:/, '').toLowerCase())
      : []
    return {
      found:        true,
      product_name: p.product_name ?? p.product_name_en ?? null,
      brand:        typeof p.brands === 'string' ? p.brands.split(',')[0].trim() : null,
      categories,
      allergens,
      image_url:    p.image_url ?? p.image_front_url ?? null,
      raw:          undefined,           // omit raw to keep memory bounded across batches
    }
  } catch {
    return { found: false, reason: 'http_error' }
  }
}

// Map OFF allergen tags → our taxonomy keys. OFF uses things like
// 'en:milk', 'en:gluten', 'en:nuts'. After we strip the language
// prefix, we map to our key set.
const OFF_ALLERGEN_MAP: Record<string, string> = {
  milk:       'dairy',
  dairy:      'dairy',
  eggs:       'eggs',
  egg:        'eggs',
  gluten:     'gluten',
  wheat:      'gluten',
  fish:       'fish',
  crustaceans:'shellfish',
  shellfish:  'shellfish',
  molluscs:   'molluscs',
  mollusks:   'molluscs',
  nuts:       'nuts',
  'tree-nuts':'nuts',
  peanuts:    'peanuts',
  peanut:     'peanuts',
  soy:        'soy',
  soybeans:   'soy',
  celery:     'celery',
  mustard:    'mustard',
  sesame:     'sesame',
  sulphites:  'sulphites',
  sulfites:   'sulphites',
  lupin:      'lupin',
}
export function mapOffAllergens(offAllergens: string[]): string[] {
  const out = new Set<string>()
  for (const a of offAllergens) {
    const k = a.replace(/[_-]/g, '').toLowerCase()
    if (OFF_ALLERGEN_MAP[k]) out.add(OFF_ALLERGEN_MAP[k])
  }
  return Array.from(out)
}

// Map OFF category strings → our sub_category keys. OFF's category set
// is huge and English-language; we run a keyword-pass that mirrors
// category-mapper.ts but on English vocabulary instead of Swedish.
const OFF_CATEGORY_RULES: Array<{ re: RegExp; sub: SubCategory }> = [
  // Dairy
  { re: /\b(cheese|cheeses)\b/,                               sub: 'dairy_cheese' },
  { re: /\b(butter|margarine)\b/,                             sub: 'dairy_butter' },
  { re: /\b(cream|creme-fraiche|crème\s*fraîche)\b/,          sub: 'dairy_cream' },
  { re: /\b(yog[hu]rt|yoghurt|kvarg|quark|skyr)\b/,           sub: 'dairy_yogurt' },
  { re: /\bmilks?\b/,                                          sub: 'dairy_milk' },
  { re: /\beggs?\b/,                                           sub: 'dairy_eggs' },
  { re: /\bdairy\b/,                                           sub: 'dairy_other' },
  // Meat
  { re: /\bbeef\b/,                                            sub: 'meat_beef' },
  { re: /\b(pork|ham|bacon)\b/,                                sub: 'meat_pork' },
  { re: /\blamb\b/,                                            sub: 'meat_lamb' },
  { re: /\b(venison|game|wild\s*boar)\b/,                      sub: 'meat_game' },
  { re: /\b(chicken|poultry|duck|turkey)\b/,                   sub: 'meat_poultry' },
  { re: /\b(salami|prosciutto|chorizo|charcuterie|cured\s*meat)\b/, sub: 'meat_charcuterie' },
  { re: /\bsausages?\b/,                                       sub: 'meat_sausage' },
  // Fish
  { re: /\bsmoked.*fish|smoked\s*salmon\b/,                    sub: 'fish_smoked' },
  { re: /\b(canned|tinned).*fish|tuna|sardines?\b/,            sub: 'fish_preserved' },
  { re: /\bshellfish|prawns?|shrimps?|crab|lobster|mussels?|clams?\b/, sub: 'shellfish' },
  { re: /\bfrozen.*fish\b/,                                    sub: 'fish_frozen' },
  { re: /\b(salmon|cod|sea[-\s]*fish|fish)\b/,                 sub: 'fish_fresh' },
  // Produce
  { re: /\bmushrooms?\b/,                                      sub: 'produce_mushrooms' },
  { re: /\b(salad|lettuce|rocket|spinach)\b/,                  sub: 'produce_salad' },
  { re: /\bherbs?\b/,                                          sub: 'produce_herbs' },
  { re: /\bfruits?\b/,                                         sub: 'produce_fruit' },
  { re: /\bvegetables?\b/,                                     sub: 'produce_vegetables' },
  // Grains, pasta, bakery
  { re: /\bpastas?\b/,                                         sub: 'grain_pasta' },
  { re: /\brices?\b/,                                          sub: 'grain_rice' },
  { re: /\b(flour|meal)\b/,                                    sub: 'grain_flour' },
  { re: /\bbreads?\b/,                                         sub: 'bakery_bread' },
  { re: /\b(pastry|pastries|viennoiserie|croissant)\b/,        sub: 'bakery_pastry' },
  // Oils / sauces / seasonings
  { re: /\b(oil|olive[-\s]oil)\b/,                             sub: 'oils_fats' },
  { re: /\bvinegars?\b/,                                       sub: 'vinegars' },
  { re: /\b(sauces?|ketchup|mustard|mayonnaise|aioli)\b/,      sub: 'sauces_condiments' },
  { re: /\b(spices?|seasonings?)\b/,                           sub: 'spices_seasonings' },
  { re: /\b(salt|sugars?|syrups?|honey)\b/,                    sub: 'salt_sugar' },
  { re: /\b(stock|broth|bouillon|fond)\b/,                     sub: 'stock_bouillon' },
  // Preserved
  { re: /\bcanned\b/,                                          sub: 'canned_preserved' },
  { re: /\b(beans|legumes|chickpeas|lentils)\b/,               sub: 'dried_legumes' },
  { re: /\b(nuts|almonds|cashews|walnuts|hazelnuts)\b/,        sub: 'nuts_seeds' },
  { re: /\b(dried\s*fruit|raisins)\b/,                         sub: 'dried_fruit' },
  // Sweets
  { re: /\b(chocolates?|confectionery)\b/,                     sub: 'chocolate_confectionery' },
  { re: /\bice[-\s]cream\b/,                                   sub: 'ice_cream' },
  // Beverages
  { re: /\bwaters?\b/,                                         sub: 'bev_water' },
  { re: /\b(soft[-\s]drinks?|cola|soda)\b/,                    sub: 'bev_soft_drinks' },
  { re: /\b(juices?|smoothies?)\b/,                            sub: 'bev_juice' },
  { re: /\bcoffees?\b/,                                        sub: 'bev_coffee' },
  { re: /\bteas?\b/,                                           sub: 'bev_tea' },
  { re: /\benergy[-\s]drinks?\b/,                              sub: 'bev_energy' },
  // Alcohol
  { re: /\bbeers?\b/,                                          sub: 'alc_beer' },
  { re: /\bcider\b/,                                           sub: 'alc_cider' },
  { re: /\bred[-\s]wine\b/,                                    sub: 'alc_wine_red' },
  { re: /\bwhite[-\s]wine\b/,                                  sub: 'alc_wine_white' },
  { re: /\bros[ée][-\s]wine\b/,                                sub: 'alc_wine_rose' },
  { re: /\b(sparkling|champagne|cava|prosecco)\b/,             sub: 'alc_wine_sparkling' },
  { re: /\b(spirits?|vodka|gin|rum|whisky|whiskey|tequila)\b/, sub: 'alc_spirits' },
  { re: /\b(liqueurs?|aperitifs?)\b/,                          sub: 'alc_liqueur' },
  { re: /\bwines?\b/,                                          sub: 'alc_wine_red' },  // catch-all
]

export function mapOffCategories(categories: string[]): SubCategory | null {
  const blob = categories.join(' ').toLowerCase()
  for (const rule of OFF_CATEGORY_RULES) {
    if (rule.re.test(blob)) return rule.sub
  }
  return null
}
