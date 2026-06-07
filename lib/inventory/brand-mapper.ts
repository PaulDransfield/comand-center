// lib/inventory/brand-mapper.ts
//
// Brand-name → sub_category dictionary for the Swedish restaurant
// supplier ecosystem. Used by the classification cascade when the
// supplier_articles row's `category_path` field is unusable (MS
// scraper grabs sidebar nav, not the breadcrumb) but `brand` is
// reliable.
//
// Dictionary policy:
//   - Only include brands whose product family is unambiguous.
//     A brand that sells across categories (Arla, Coca-Cola Co. parent,
//     Martin & Servera own-brand) should NOT be in here — let those
//     fall through to LLM-with-context.
//   - Keys are lower-cased + trimmed; matching is exact.
//   - Confidence is 0.90 (slightly under direct category_path mapping at
//     0.95, slightly over cross-customer at 0.90). High enough that
//     owner-review queue doesn't surface it.

import type { SubCategory } from './taxonomy'

const BRAND_TO_SUB: Record<string, SubCategory> = {
  // ── Beverages — water / sparkling ─────────────────────────────────
  'san pellegrino':           'bev_water',
  'sanpellegrino':            'bev_water',
  'perrier':                  'bev_water',
  'evian':                    'bev_water',
  'loka':                     'bev_water',
  'ramlösa':                  'bev_water',
  'vichy nouveau':            'bev_water',
  'imsdal':                   'bev_water',

  // ── Beverages — soft drinks ───────────────────────────────────────
  'fanta':                    'bev_soft_drinks',
  'sprite':                   'bev_soft_drinks',
  'pepsi':                    'bev_soft_drinks',
  '7-up':                     'bev_soft_drinks',
  '7up':                      'bev_soft_drinks',
  'mountain dew':             'bev_soft_drinks',
  'apotekarnes':              'bev_soft_drinks',
  'festis':                   'bev_soft_drinks',
  'cuba cola':                'bev_soft_drinks',
  'julmust':                  'bev_soft_drinks',

  // ── Beverages — juices ────────────────────────────────────────────
  'tropicana':                'bev_juice',
  'innocent':                 'bev_juice',
  'god morgon':               'bev_juice',
  'brämhults':                'bev_juice',
  'rynkeby':                  'bev_juice',

  // ── Beverages — coffee / tea ──────────────────────────────────────
  'gevalia':                  'bev_coffee',
  'arvid nordquist':          'bev_coffee',
  'illy':                     'bev_coffee',
  'lavazza':                  'bev_coffee',
  'lipton':                   'bev_tea',
  'twinings':                 'bev_tea',
  'pickwick':                 'bev_tea',
  'kobbs':                    'bev_tea',

  // ── Meat / poultry brands ────────────────────────────────────────
  'kronfågel':                'meat_poultry',
  'guldfågeln':               'meat_poultry',
  'scan':                     'meat_charcuterie',     // big Swedish processor — mostly charcuterie/sausage
  'moek prästorp':            'meat_beef',            // MOEK Prästorp — Swedish meat farm
  'moek':                     'meat_beef',

  // ── Produce / fresh brands ───────────────────────────────────────
  // F&G M/S = "Frukt & Grönsaker Martin & Servera" (MS in-house fresh
  // produce). All storage=kyl. Mostly vegetables + some fruit;
  // produce_vegetables is the safer default.
  'f&g m/s':                  'produce_vegetables',
  'f&g ms':                   'produce_vegetables',
  'frukt & grönsaker':        'produce_vegetables',
  'odlarna.se':               'produce_vegetables',   // "The Growers" coop
  'odlarna':                  'produce_vegetables',
  'smålandssvamp':            'produce_mushrooms',
  'svampbolaget':             'produce_mushrooms',

  // ── Fish suppliers ───────────────────────────────────────────────
  'skags':                    'fish_fresh',
  'kg paulsson':              'fish_fresh',
  'paulssons':                'fish_fresh',
  'falkenbergs fågel':        'meat_poultry',
  'leröy':                    'fish_fresh',           // Norwegian fish/seafood giant

  // ── Frozen prepared meals + ready-foods ──────────────────────────
  'dafgårds':                 'prepared_meals',       // huge SE frozen-food brand (pizza, ready-meals)
  'dafgard':                  'prepared_meals',
  'findus':                   'prepared_meals',
  'orkla':                    'prepared_meals',

  // ── Additional drinks / juices ───────────────────────────────────
  'mer':                      'bev_juice',            // MER (Coca-Cola SE — juices/cordials)
  'rio':                      'bev_soft_drinks',
  'trocadero':                'bev_soft_drinks',

  // ── Beverages — energy / mixers ───────────────────────────────────
  'red bull':                 'bev_energy',
  'monster':                  'bev_energy',
  'celsius':                  'bev_energy',
  'monin':                    'bev_mixers',
  'fever-tree':               'bev_mixers',
  'fevertree':                'bev_mixers',
  'schweppes':                'bev_mixers',
  'fentimans':                'bev_mixers',
  '1883':                     'bev_mixers',

  // ── Dairy ──────────────────────────────────────────────────────────
  'flora':                    'dairy_butter',
  'lätta':                    'dairy_butter',
  'bregott':                  'dairy_butter',
  'lurpak':                   'dairy_butter',
  'kerrygold':                'dairy_butter',
  'philadelphia':             'dairy_cheese',
  'castello':                 'dairy_cheese',
  'galbani':                  'dairy_cheese',
  'parmigiano reggiano':      'dairy_cheese',
  'grana padano':             'dairy_cheese',

  // ── Bakery ─────────────────────────────────────────────────────────
  'bageri la lorraine':       'bakery_bread',
  'la lorraine':              'bakery_bread',
  'korvbrödsbagarn':          'bakery_bread',
  'pågen':                    'bakery_bread',
  'pååg':                     'bakery_bread',          // mis-spelled by scrapers sometimes
  'fazer':                    'bakery_bread',
  'la boulangerie':           'bakery_bread',
  'bridor':                   'bakery_bread',

  // ── Charcuterie / Italian ─────────────────────────────────────────
  'galbanino':                'dairy_cheese',
  'levoni':                   'meat_charcuterie',
  'prosciuttificio':          'meat_charcuterie',

  // ── Spirits / Wine houses ──────────────────────────────────────────
  'marchesi frescobaldi':     'alc_wine_red',
  'antinori':                 'alc_wine_red',
  'masi':                     'alc_wine_red',
  'banfi':                    'alc_wine_red',
  'campari':                  'alc_liqueur',
  'aperol':                   'alc_liqueur',
  'martini':                  'alc_liqueur',
  'cinzano':                  'alc_liqueur',
  'absolut':                  'alc_spirits',
  'absolut vodka':            'alc_spirits',
  'jameson':                  'alc_spirits',
  'bombay sapphire':          'alc_spirits',
  'hendrick\'s':              'alc_spirits',
  'tanqueray':                'alc_spirits',

  // ── Beer ──────────────────────────────────────────────────────────
  'spendrups':                'alc_beer',
  'mariestads':               'alc_beer',
  'falcon':                   'alc_beer',
  'norrlands guld':           'alc_beer',
  'pripps':                   'alc_beer',
  'carlsberg':                'alc_beer',
  'heineken':                 'alc_beer',
  'stella artois':            'alc_beer',
  'corona':                   'alc_beer',

  // ── Disposables / non-food ────────────────────────────────────────
  'duni':                     'paper_napkins',
  'tork':                     'paper_general',

  // ── Sauces / oils ──────────────────────────────────────────────────
  'mutti':                    'sauces_condiments',     // tomato sauce/passata
  'heinz':                    'sauces_condiments',
  'hellmann\'s':              'sauces_condiments',
  'felix':                    'sauces_condiments',     // Swedish ketchup/sauces
  'lyckeby':                  'sauces_condiments',
  'colmans':                  'sauces_condiments',
  'lea & perrins':            'sauces_condiments',
  'tabasco':                  'sauces_condiments',
  'bertolli':                 'oils_fats',
  'zeta':                     'oils_fats',             // Italian olive oil (Sweden)
  'kalles kaviar':            'fish_preserved',
}

/**
 * Map a brand string from supplier_articles.brand to a sub_category.
 * Returns null when the brand isn't in the dictionary (let it fall
 * through to LLM context).
 */
export function brandToSubCategory(brand: string | null | undefined): SubCategory | null {
  if (!brand) return null
  const key = String(brand).toLowerCase().trim()
  if (!key) return null
  // Direct hit
  if (BRAND_TO_SUB[key]) return BRAND_TO_SUB[key]
  // Try removing common corporate suffixes
  const stripped = key
    .replace(/\b(ab|aps|gmbh|inc|ltd|s\.r\.l\.?|s\.p\.a\.?|sl|llc|oy|asa)\b\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (stripped && stripped !== key && BRAND_TO_SUB[stripped]) return BRAND_TO_SUB[stripped]
  return null
}

/**
 * Sniff whether a supplier_articles.category_path is the bogus MS
 * sidebar-navigation string ("Restaurangbutiker > Galatea > ...")
 * rather than the actual product breadcrumb. When it is, we skip
 * mapCategoryPath() entirely and lean on brand + storage_type
 * + LLM context instead.
 */
export function isNavigationMenuPath(path: string | null | undefined): boolean {
  if (!path) return true                              // treat null as "no signal"
  const norm = String(path).toLowerCase()
  // The MS scraper bug grabs the supplier menu rail. Hallmark: starts
  // with "restaurangbutiker" (literally "Restaurant Shops") and lists
  // multiple sub-brand division names separated by " > ".
  if (norm.startsWith('restaurangbutiker')) return true
  // Also catch other supplier menu patterns we've seen.
  if (norm.includes('sortiment >') && norm.split('>').length > 5) return true
  return false
}
