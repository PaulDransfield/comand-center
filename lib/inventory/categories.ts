// lib/inventory/categories.ts
//
// BAS account → inventory category routing. The matcher uses this to:
//   (a) decide if a line is an inventory item at all
//       (non-inventory accounts → match_status = 'not_inventory', no
//       review-queue noise)
//   (b) pre-fill the category when a new product is created via the
//       owner-review flow.
//
// PRINCIPLE (rev. 2026-05-21 after Chicce's first backfill returned
// `lines_not_inventory: 532` with my original narrow list):
//
//   Default-include: any 4xxx account (kostnad sålda varor / inköp av
//   varor) is treated as inventory. The Swedish BAS chart's 4000-4999
//   range IS "cost of goods sold" by construction. Specific sub-codes
//   give us category routing; an unmapped 4xxx still counts as 'food'
//   so it lands in the review queue instead of being silently dropped.
//
//   Default-exclude: 5xxx (premises) is mostly non-inventory; we
//   allowlist the specific consumable codes (5410, 5420, 5460).
//
//   Hard-exclude: 6xxx (other external costs), 7xxx (personnel),
//   8xxx (financial), 9xxx (closing) — never inventory.

export type InventoryCategory =
  | 'food'
  | 'beverage'
  | 'alcohol'
  | 'cleaning'
  | 'takeaway_material'
  | 'disposables'
  | 'other'

// Specific overrides — exact match wins. These map specific BAS sub-
// codes to a precise category so the matcher seeds new products with
// the right category without owner intervention.
const SPECIFIC_OVERRIDES: Record<string, InventoryCategory> = {
  // ── 40xx food/beverage raw materials ─────────────────────────────
  // VAT-split variants of "Råvaror"
  '4010': 'food',
  '4011': 'alcohol',
  '4012': 'beverage',
  '4013': 'food',
  '4014': 'food',
  '4015': 'disposables',         // förbrukningsmaterial used for goods
  '4016': 'food',
  '4017': 'takeaway_material',
  '4018': 'takeaway_material',
  '4019': 'food',

  // Common per-category food accounts (some restaurants split fine-grained)
  '4020': 'food',                // Frukt och grönt
  '4030': 'food',                // Mjölk och mejeri
  '4040': 'food',                // Kött
  '4050': 'food',                // Fisk och skaldjur
  '4060': 'food',                // Bröd & spannmål
  '4070': 'food',                // Övriga livsmedel
  '4080': 'food',                // Färdiglagat
  '4090': 'food',                // Övriga råvaror

  // Beverages split-out variants
  '4021': 'beverage',
  '4022': 'beverage',            // Läskedrycker
  '4023': 'beverage',
  '4024': 'beverage',            // Kaffe / te
  '4025': 'alcohol',             // Vin
  '4026': 'alcohol',             // Sprit
  '4027': 'alcohol',             // Öl
  '4028': 'alcohol',

  // 41xx — sometimes used for "direkta kostnader för tjänster"
  // including catering. Treat as food by default.
  '4110': 'food',
  '4120': 'food',

  // ── 5xxx premises (mostly NON-inventory; allowlist specific codes) ─
  '5410': 'disposables',         // Förbrukningsinventarier
  '5411': 'disposables',
  '5420': 'disposables',
  '5460': 'cleaning',            // Rengöringsmedel
  '5461': 'cleaning',
  '5462': 'cleaning',
  '5470': 'disposables',
}

/**
 * Return the canonical category for a BAS account, or null if the
 * account isn't inventory.
 *
 * Logic:
 *   1. NULL / empty                       → null (skip)
 *   2. Exact match in SPECIFIC_OVERRIDES  → that category
 *   3. 4xxx account                       → 'food' (default fall-through)
 *   4. Anything else                      → null (skip)
 */
export function categoryForBasAccount(accountNumber: string | null | undefined): InventoryCategory | null {
  if (!accountNumber) return null
  const trimmed = String(accountNumber).trim()
  if (!trimmed) return null

  const explicit = SPECIFIC_OVERRIDES[trimmed]
  if (explicit) return explicit

  // Default-include rule: any 4xxx account is cost-of-goods. The owner
  // can re-categorise in the review UI later.
  if (/^4\d{3}$/.test(trimmed)) return 'food'

  return null
}

/**
 * Quick predicate for the matcher's first gate — does this line count
 * as inventory at all? Lines that fail this never enter the queue.
 */
export function isInventoryAccount(accountNumber: string | null | undefined): boolean {
  return categoryForBasAccount(accountNumber) !== null
}

export { SPECIFIC_OVERRIDES }
