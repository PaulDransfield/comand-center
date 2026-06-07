// lib/inventory/category-mapper.ts
//
// Maps supplier-side category paths (Swedish, hierarchical) to our
// owner-readable sub_category keys. Three layers:
//
//   1. Direct mapping table — for the MS top-level category paths we've
//      seen in the wild. ~80% of catalogue lands here at near-100%
//      accuracy because it's basically a translation table.
//   2. Keyword fallback — when the path doesn't match a known head, look
//      for distinctive Swedish keywords (mjölk, smör, vin, etc.).
//   3. Returns null when nothing matches; caller falls back to LLM.
//
// The direct table is deliberately broad: a single MS path like
// "Mejeri / Smör & margarin / Smör" should map to dairy_butter
// regardless of which leaf product hangs off it.

import type { SubCategory, StorageType } from './taxonomy'

// Path is Swedish, lower-case, segments separated by ' / ' or ' > '.
// Normalise first so "Mejeri/Ost" and "Mejeri / ost" both match.
export function normalisePath(p: string | null | undefined): string {
  if (!p) return ''
  return p.toLowerCase()
    .replace(/\s*[/>]\s*/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Head-match rules — most specific FIRST.
// Each rule: regex run against the normalised path, with the sub_category
// + confidence + (optional) storage hint it yields.
//
// Confidence scale here is the BASE confidence for direct-match. The
// cascade caller can demote it.
interface MapRule {
  pattern:    RegExp
  sub:        SubCategory
  storage?:   StorageType
}

const RULES: MapRule[] = [
  // ── Dairy & eggs ────────────────────────────────────────────────
  { pattern: /\bmejeri\b.*\bost\b/,                      sub: 'dairy_cheese',   storage: 'refrigerated' },
  { pattern: /\bost\b(?!.*sallad)/,                      sub: 'dairy_cheese',   storage: 'refrigerated' },
  { pattern: /\bsmör\b|\bmargarin\b|\bsmörgåspålägg\b/,  sub: 'dairy_butter',   storage: 'refrigerated' },
  { pattern: /\bgrädde\b|\bcrème fraiche\b|\bcreme fraiche\b/, sub: 'dairy_cream', storage: 'refrigerated' },
  { pattern: /\byoghurt\b|\byougurt\b|\bkvarg\b|\bfilmjölk\b/, sub: 'dairy_yogurt', storage: 'refrigerated' },
  { pattern: /\bmjölk\b/,                                sub: 'dairy_milk',     storage: 'refrigerated' },
  { pattern: /\bägg\b/,                                  sub: 'dairy_eggs',     storage: 'refrigerated' },
  { pattern: /\bmejeri\b/,                               sub: 'dairy_other',    storage: 'refrigerated' }, // catch-all

  // ── Meat & poultry (kött, fågel) ────────────────────────────────
  { pattern: /\bnötkött\b|\bbiff\b|\boxkött\b|\boxfile\b/, sub: 'meat_beef',     storage: 'refrigerated' },
  { pattern: /\bgriskött\b|\bsvin\b|\bfläsk\b/,            sub: 'meat_pork',     storage: 'refrigerated' },
  { pattern: /\blamm\b|\bfår\b/,                            sub: 'meat_lamb',     storage: 'refrigerated' },
  { pattern: /\bvilt\b|\brådjur\b|\bvildsvin\b|\bälg\b/,    sub: 'meat_game',     storage: 'refrigerated' },
  { pattern: /\bkyckling\b|\bfågel\b|\banka\b|\bkalkon\b/,  sub: 'meat_poultry',  storage: 'refrigerated' },
  { pattern: /\bcharkuteri\b|\bchark\b|\bskinka\b|\bsalami\b|\bbacon\b|\bpancetta\b|\bprosciutto\b/, sub: 'meat_charcuterie', storage: 'refrigerated' },
  { pattern: /\bkorv\b|\bsausage\b/,                        sub: 'meat_sausage',  storage: 'refrigerated' },
  { pattern: /\binälvor\b|\blever\b|\bnjure\b/,             sub: 'meat_offal',    storage: 'refrigerated' },

  // ── Fish & seafood ──────────────────────────────────────────────
  { pattern: /\bfisk\b.*\b(?:frys|fryst|djupfryst)\b/,     sub: 'fish_frozen',   storage: 'frozen' },
  { pattern: /\b(?:fryst|djupfryst)\b.*\bfisk\b/,          sub: 'fish_frozen',   storage: 'frozen' },
  { pattern: /\brökt fisk\b|\brökt lax\b|\brökt makrill\b/, sub: 'fish_smoked',   storage: 'refrigerated' },
  { pattern: /\bkonserv\b.*\bfisk\b|\btonfisk\b|\binlagd sill\b/, sub: 'fish_preserved' },
  { pattern: /\bskaldjur\b|\bräka\b|\bräkor\b|\bhumr\b|\bkrabba\b|\bostron\b|\bmussla\b/, sub: 'shellfish', storage: 'refrigerated' },
  { pattern: /\bfisk\b|\blax\b|\btorsk\b|\bsej\b|\bgös\b|\babborre\b/, sub: 'fish_fresh', storage: 'refrigerated' },

  // ── Produce ─────────────────────────────────────────────────────
  { pattern: /\bsvamp\b/,                                  sub: 'produce_mushrooms', storage: 'refrigerated' },
  { pattern: /\bsallad\b|\bsalladsblad\b|\bruccola\b|\bspenat\b/, sub: 'produce_salad', storage: 'refrigerated' },
  { pattern: /\bfärsk\s*ört\b|\b(?:basilika|persilja|koriander|dill|mynta|timjan|rosmarin)\b/, sub: 'produce_herbs', storage: 'refrigerated' },
  { pattern: /\bfrukt\b/,                                  sub: 'produce_fruit', storage: 'refrigerated' },
  { pattern: /\bgrönsak\b|\bgrönsaker\b/,                  sub: 'produce_vegetables', storage: 'refrigerated' },

  // ── Grains, pasta, bakery ───────────────────────────────────────
  { pattern: /\bpasta\b/,                                  sub: 'grain_pasta' },
  { pattern: /\bris\b/,                                    sub: 'grain_rice' },
  { pattern: /\bmjöl\b|\bgryn\b/,                          sub: 'grain_flour' },
  { pattern: /\bbröd\b/,                                   sub: 'bakery_bread' },
  { pattern: /\bbakverk\b|\bbulle\b|\bkex\b|\bkaka\b/,     sub: 'bakery_pastry' },

  // ── Oils, sauces, seasonings ────────────────────────────────────
  { pattern: /\bolja\b|\bolivolja\b|\brapsolja\b/,         sub: 'oils_fats' },
  { pattern: /\bvinäger\b|\bättika\b/,                     sub: 'vinegars' },
  { pattern: /\bsås\b|\bketchup\b|\bsenap\b|\bmajonnäs\b|\baioli\b/, sub: 'sauces_condiments' },
  { pattern: /\bkrydd\b|\bkryddor\b/,                      sub: 'spices_seasonings' },
  { pattern: /\bsalt\b|\bsocker\b|\bsirap\b|\bhonung\b/,   sub: 'salt_sugar' },
  { pattern: /\bbuljong\b|\bfond\b|\bstock\b/,             sub: 'stock_bouillon' },

  // ── Canned / preserved / dried ──────────────────────────────────
  { pattern: /\bkonserv\b/,                                sub: 'canned_preserved' },
  { pattern: /\bböna\b|\bbönor\b|\blins\b|\bkikärt\b/,     sub: 'dried_legumes' },
  { pattern: /\bnötter\b|\bmandel\b|\bcashew\b|\bvalnöt\b|\bhasselnöt\b/, sub: 'nuts_seeds' },
  { pattern: /\btorkad frukt\b|\brussin\b|\baprikos\b/,    sub: 'dried_fruit' },

  // ── Sweets ──────────────────────────────────────────────────────
  { pattern: /\bchoklad\b|\bgodis\b|\bkonfekt\b/,          sub: 'chocolate_confectionery' },
  { pattern: /\bglass\b/,                                  sub: 'ice_cream', storage: 'frozen' },

  // ── Beverages — non-alcoholic ───────────────────────────────────
  { pattern: /\bvatten\b/,                                 sub: 'bev_water' },
  { pattern: /\bläsk\b|\bcola\b|\bfanta\b|\bsprite\b/,     sub: 'bev_soft_drinks' },
  { pattern: /\bjuice\b|\bsaft\b/,                         sub: 'bev_juice' },
  { pattern: /\bkaffe\b|\bcoffee\b/,                       sub: 'bev_coffee' },
  { pattern: /\bte\b|\btea\b/,                             sub: 'bev_tea' },
  { pattern: /\benergi\s*dryck\b/,                         sub: 'bev_energy' },
  { pattern: /\bmixer\b/,                                  sub: 'bev_mixers' },

  // ── Alcohol ─────────────────────────────────────────────────────
  { pattern: /\böl\b|\bbeer\b/,                            sub: 'alc_beer' },
  { pattern: /\bcider\b/,                                  sub: 'alc_cider' },
  { pattern: /\brött vin\b|\brött\b.*\bvin\b/,             sub: 'alc_wine_red' },
  { pattern: /\bvitt vin\b|\bvitt\b.*\bvin\b/,             sub: 'alc_wine_white' },
  { pattern: /\bros[ée] vin\b|\bros[ée]\b/,                sub: 'alc_wine_rose' },
  { pattern: /\bmoussera\b|\bchampagne\b|\bcava\b|\bprosecco\b/, sub: 'alc_wine_sparkling' },
  { pattern: /\bportvin\b|\bsherry\b|\bmadeira\b/,         sub: 'alc_wine_dessert' },
  { pattern: /\bsprit\b|\bvodka\b|\bgin\b|\brom\b|\bwhisky\b|\btequila\b/, sub: 'alc_spirits' },
  { pattern: /\blikör\b|\baperitif\b|\bvermut\b/,          sub: 'alc_liqueur' },
  { pattern: /\bvin\b/,                                    sub: 'alc_wine_red' }, // catch-all wine

  // ── Cleaning / disposables / takeaway ───────────────────────────
  { pattern: /\bdiskmedel\b|\bdiskmaskin\b/,               sub: 'cleaning_dish' },
  { pattern: /\btvätt\b/,                                  sub: 'cleaning_laundry' },
  { pattern: /\brengöring\b|\brengörings\b/,               sub: 'cleaning_chemicals' },
  { pattern: /\bservett\b|\bnapkin\b/,                     sub: 'paper_napkins' },
  { pattern: /\bhandskar\b|\bförkläde\b/,                  sub: 'gloves_apron' },
  { pattern: /\bfolie\b|\bfilm\b|\bbakpapper\b/,           sub: 'film_foil' },
  { pattern: /\btakeaway\b|\bbox\b.*\b(?:trä|papper|plast)\b/, sub: 'takeaway_containers' },
  { pattern: /\bpåse\b|\bpåsar\b/,                         sub: 'takeaway_bags' },
  { pattern: /\bbestick\b|\bkniv\b.*\bplast\b/,            sub: 'takeaway_cutlery' },

  // Catch-all storage hint from path text (without committing a sub_category)
]

export interface MapResult {
  sub:        SubCategory
  confidence: number              // 0.95 for direct match, 0.85 for fuzzy
  storage:    StorageType | null
}

/**
 * Map a supplier `category_path` to one of our sub_category keys.
 * Returns null when no rule matches — caller falls back to LLM.
 *
 * `storage_type_hint` is taken from the supplier_articles row if present;
 * we prefer it over the path-derived storage hint when both exist.
 */
export function mapCategoryPath(
  path:               string | null | undefined,
  storage_type_hint?: string | null,
): MapResult | null {
  const norm = normalisePath(path)
  if (!norm) return null

  for (const rule of RULES) {
    if (rule.pattern.test(norm)) {
      // Storage: prefer supplier-provided over rule-derived
      const storage = (storage_type_hint === 'frozen' || storage_type_hint === 'refrigerated' || storage_type_hint === 'ambient')
        ? storage_type_hint as StorageType
        : (rule.storage ?? null)
      return {
        sub:        rule.sub,
        confidence: 0.95,
        storage,
      }
    }
  }

  // No direct match — return null. Caller will LLM-classify or queue
  // for owner review.
  return null
}

/**
 * Map a single supplier storage-type string ('fryst', 'kyl', 'rum') to
 * our canonical key. Used when we have the storage signal but no path.
 */
export function mapStorageType(s: string | null | undefined): StorageType | null {
  if (!s) return null
  const v = s.toLowerCase().trim()
  if (v === 'fryst' || v === 'frozen' || v === 'djupfryst') return 'frozen'
  if (v === 'kyl' || v === 'kyld' || v === 'kylvara' || v === 'chilled' || v === 'refrigerated') return 'refrigerated'
  if (v === 'rum' || v === 'rumstemp' || v === 'torrt' || v === 'ambient' || v === 'kolonial') return 'ambient'
  return null
}
