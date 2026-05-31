// lib/inventory/suppliers.ts
//
// Supplier-name → inventory category routing. This is the FALLBACK for
// rows where Fortnox didn't post a BAS account number (see Chicce's
// first backfill 2026-05-21: all 3218 rows had account_number = NULL).
//
// The classifier runs in two passes:
//
//   1. Exact-match dictionary — names we've seen and curated by hand.
//      Highest confidence; the matcher trusts these without review.
//
//   2. Pattern matchers — keyword substrings in the supplier name
//      (e.g. "wine"/"vin", "kött", "fisk"). Lower confidence; useful
//      for new suppliers that match a known shape.
//
// Anything not classified by either pass returns null → the row stays
// classified as `not_inventory`. That's intentionally conservative —
// false positives (a marketing agency tagged as "food") are worse than
// false negatives (a real food supplier sitting in needs_review until
// owner curates).
//
// Add new entries by either:
//   - Adding the supplier's normalised name to EXACT_OVERRIDES
//   - Adding a keyword pattern to PATTERN_MATCHERS (with a comment)

import type { InventoryCategory } from './categories'

// Return type for the supplier classifier. Adds `'not_inventory'` as a
// sentinel so the matcher can short-circuit on known-non-inventory
// suppliers (Fortnox SaaS, E.ON, accountants, debt collectors) instead
// of dumping them into the review queue.
export type SupplierClassification = InventoryCategory | 'not_inventory'

// Normalise a Fortnox supplier name for stable matching. Same lower /
// strip-punctuation pattern as lib/inventory/normalise.ts but kept
// separate so the two functions can evolve independently.
function normaliseSupplierName(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw
    .toLowerCase()
    .replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── Pass 1: exact-name overrides (hand-curated) ────────────────────────
//
// Keys are normalised names. The dictionary covers the suppliers we
// saw on Chicce's first backfill plus common Vero suppliers. Extend as
// new businesses onboard — this is the "one minute of curation per
// new supplier" workflow.
//
// ── HARD RULE (learned 2026-05-31, Frimurarholmen incident) ────────────
//
// THIS DICTIONARY MAY ONLY CONTAIN SUPPLIERS WHOSE MEANING IS THE SAME
// AT EVERY BUSINESS. Anything multi-purpose lives in per-business
// supplier_classifications (M083), NOT here.
//
// Example: Frimurarholmen AB is Vero's landlord AND a food-passthrough
// for Axfood purchases. Globally classifying it as 'not_inventory'
// silently vetoed 8 owner_confirmed real food matches. The supplier
// itself isn't not_inventory — its meaning depends on what's being
// billed, which only the business owner knows. That's exactly what
// the per-business override mechanism exists for.
//
// Before adding an EXACT_OVERRIDES entry, confirm:
//   1. The supplier sells the SAME category at every customer (or only
//      operates at one customer and isn't expected to expand)
//   2. The classification is structurally correct (a brewery is alcohol
//      everywhere; an electricity company is not_inventory everywhere)
//   3. The supplier doesn't have visible multi-purpose patterns at any
//      existing customer (check actual invoice descriptions if unsure)
//
// If in doubt, leave the supplier OUT of EXACT_OVERRIDES and let
// per-business overrides handle it. False-negative (line stays in
// needs_review until owner curates) is always better than false-
// positive (owner_confirmed match silently vetoed by a wrong guess).
//
// The owner_confirmed safeguard in matcher.ts Gate 0 catches the next
// such incident automatically, but the durable fix is to keep this
// dictionary clean of multi-purpose suppliers.

const EXACT_OVERRIDES: Record<string, SupplierClassification> = {
  // ── Broadline food wholesalers ──────────────────────────────────
  'martin servera restauranghandel ab':           'food',
  'werners gourmetservice ab':                    'food',
  'laweka gross matevent ab':                     'food',
  'menigo foodservice ab':                        'food',

  // ── Specialty food suppliers ─────────────────────────────────────
  'kungsholmens kott ab':                         'food',         // meat
  'bergslagsdelikatesser i lindesberg aktiebolag': 'food',        // deli
  'kvalitetsfisk i stockholm ab':                 'food',         // fish
  'rima seafood ab':                              'food',         // fish
  'tradgardshallen sverige ab':                   'food',         // produce
  'niseko i orebro ab':                           'food',         // asian groceries
  'kogi forsaljnings aktiebolag':                 'food',
  // NOTE: 'frimurarholmen ab' removed 2026-05-31 — multi-purpose at Vero
  // (landlord + Axfood food passthrough). Per-business override (M083)
  // handles the rent invoices; food invoices fall through to BAS routing.
  // See top-of-file rule + project_p20_gate0_precedence_safeguard memory.

  // ── Beverages / alcohol ──────────────────────────────────────────
  // Sweden treats beer as alcohol; we follow that convention so the
  // KPI rolls into the alcohol margin not the soft-beverage margin.
  'carlsberg sverige aktiebolag':                 'alcohol',
  'carlsberg intrum':                             'not_inventory', // debt collector for Carlsberg
  'spendrups bryggeri ab':                        'alcohol',
  'anora sweden ab':                              'alcohol',
  'enjoy wine spirits ab':                        'alcohol',
  'lihnells distillery ab':                       'alcohol',
  'lively wines sweden ab':                       'alcohol',
  'wine affair scandinavia ab':                   'alcohol',
  'out of home ab':                               'alcohol',       // Pernod Ricard SE distributor

  // ── Takeaway material / disposables ──────────────────────────────
  'ab tingstad papper':                           'takeaway_material',  // paper goods / takeaway boxes
  'quatra sweden ab':                             'disposables',

  // ── Cleaning / laundry / waste ──────────────────────────────────
  'orebro tvatt ab':                              'cleaning',      // linens & laundry
  'renall ab':                                    'cleaning',
  'prezero recycling ab':                         'not_inventory', // waste hauler — service, not goods

  // ── Pure services / utilities / fees (not inventory) ────────────
  'e on energidistribution aktiebolag':           'not_inventory',
  'caspeco ab':                                   'not_inventory', // POS / scheduling SaaS
  'fortnox ab':                                   'not_inventory',
  'fortnox aktiebolag':                           'not_inventory',
  'advania sverige ab':                           'not_inventory', // IT/hosting
  'cedra sverige ab':                             'not_inventory',
  'flow sweden ab':                               'not_inventory',
  'qvanti ab':                                    'not_inventory',
  'elavon':                                       'not_inventory', // card processor
  'fora ab':                                      'not_inventory', // collective insurance
  'sami':                                         'not_inventory', // music royalty collector
  'securitas direct sverige ab':                  'not_inventory',
  'svenskt naringsliv service ab':                'not_inventory',
  'we are marketing sverige ab':                  'not_inventory',
  // NOTE: 'barkonsult jakobsson lovgren ab' removed 2026-05-31 — multi-purpose
  // at Vero (sells real bar equipment + glassware + specialty spirits like
  // Taggiasco Gin, Urban Bar martini glasses, iSi whipped-cream chargers,
  // alongside any genuine consulting work the name suggests). Same pattern
  // as Frimurarholmen. Per-business override (M083) can be added at any
  // customer where the consulting side dominates.
  'ohrlings pricewaterhousecoopers ab':           'not_inventory',
  'orebro kommun':                                'not_inventory',
  'orebro kommun tekniska':                       'not_inventory', // water + sewage
  'orebro sotar n ab':                            'not_inventory', // chimney sweep
  'hlk elgruppen ab':                             'not_inventory',
  'varme installation storkoksserv':              'not_inventory',
  'eventcenter i orebro ab':                      'not_inventory',
  'pitchers i orebro ab':                         'not_inventory',
  'ps inkasso juridik ab':                        'not_inventory',
  'sthal ab':                                     'not_inventory',
  'ancon ab':                                     'not_inventory',
  'ancon aktiebolag':                             'not_inventory',

  // ── Inter-company (Paul's other restaurant) ──────────────────────
  // Don't auto-classify cross-entity invoices into inventory — too
  // easy to double-count if Lawe and Chicce share a kitchen procurement.
  'lawe restaurang ab':                           'not_inventory',
}

// ── Pass 2: pattern matchers (keyword substrings) ───────────────────
//
// Order matters — first hit wins. Patterns are normalised + matched
// against the normalised supplier name. Use these for variants we
// HAVEN'T hand-curated — they should be conservative enough that an
// unknown supplier matching the pattern is overwhelmingly likely to
// belong in the category.

interface Pattern {
  regex:    RegExp
  category: SupplierClassification
  reason:   string
}

const PATTERN_MATCHERS: Pattern[] = [
  // Alcohol / wine
  { regex: /\b(wine|vin|spirits?|liquor|whisky|whiskey|gin|rum|tequila|brennerei|distillery)\b/i, category: 'alcohol', reason: 'wine/spirits keyword' },
  { regex: /\b(bryggeri|brewery|brewing)\b/i,                                                     category: 'alcohol', reason: 'brewery' },

  // Food
  { regex: /\b(kott|meat|gris|nott|biff|kyckling|chicken|charkuteri)\b/i,  category: 'food', reason: 'meat keyword' },
  { regex: /\b(fisk|fish|seafood|skaldjur|musslor)\b/i,                    category: 'food', reason: 'fish/seafood keyword' },
  { regex: /\b(bageri|bakery|brod|baguette)\b/i,                           category: 'food', reason: 'bakery' },
  { regex: /\b(gron|gronsak|produce|tradgard|frukt|vegetables?|fruits?)\b/i, category: 'food', reason: 'produce' },
  { regex: /\b(mejeri|dairy|ost|cheese)\b/i,                               category: 'food', reason: 'dairy' },
  { regex: /\b(grossist|wholesaler|restauranghandel|foodservice)\b/i,      category: 'food', reason: 'restaurant wholesaler' },

  // Cleaning / disposables
  { regex: /\b(tvatt|laundry|stadning|cleaning|cleanco|tvattservice)\b/i,  category: 'cleaning', reason: 'cleaning' },
  { regex: /\b(papper|paper|forpackning|packaging|emballage)\b/i,          category: 'takeaway_material', reason: 'paper/packaging' },

  // Pure services (catch obvious ones to avoid false-positive food matches)
  { regex: /\b(forsakring|insurance|inkasso|debt|advokat|jurist|lawyer|revisor|accounting|accountant)\b/i, category: 'not_inventory', reason: 'professional service' },
  { regex: /\b(installation|reparation|service|underhall|tekn)\b/i,        category: 'not_inventory', reason: 'service/repair' },
  { regex: /\b(energi|electricity|fjarrvarme|gas|vatten|water|telefoni|internet|broadband|hosting|cloud)\b/i, category: 'not_inventory', reason: 'utility' },
]

/**
 * Return the supplier-derived category, or null if we have no signal.
 * Conservative: when in doubt, return null and let the line stay in
 * `not_inventory` until owner curates.
 */
export function categoryForSupplier(supplierName: string | null | undefined): SupplierClassification | null {
  if (!supplierName) return null
  const norm = normaliseSupplierName(supplierName)
  if (!norm) return null

  const exact = EXACT_OVERRIDES[norm]
  if (exact !== undefined) return exact

  for (const p of PATTERN_MATCHERS) {
    if (p.regex.test(supplierName) || p.regex.test(norm)) {
      return p.category
    }
  }

  return null
}

export { normaliseSupplierName, EXACT_OVERRIDES, PATTERN_MATCHERS }
