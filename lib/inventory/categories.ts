// lib/inventory/categories.ts
//
// BAS account → inventory category routing. The matcher uses this to:
//   (a) decide if a line is an inventory item at all
//       (non-inventory accounts → match_status = 'not_inventory', no
//       review-queue noise)
//   (b) pre-fill the category when a new product is created via the
//       owner-review flow.
//
// Source: INVENTORY-CATALOGUE-PLAN.md §8 Q1 — owner-approved starting set.
// Add or remove account numbers here; this is the only file that needs
// touching when the customer base diversifies (e.g. a cafe-only customer
// has different 4xxx splits than a full-service restaurant).

export type InventoryCategory =
  | 'food'
  | 'beverage'
  | 'alcohol'
  | 'cleaning'
  | 'takeaway_material'
  | 'disposables'
  | 'other'

/**
 * Hard-coded list of BAS accounts that count as inventory. Lines on
 * any other account skip the matcher entirely (match_status = 'not_inventory').
 *
 * Keep this list narrow. False positives (e.g. utilities tagged as
 * inventory) flood the review queue; false negatives (real inventory
 * skipped) the owner can fix by editing the line's category manually
 * later. Bias toward narrow.
 */
const INVENTORY_BAS_ACCOUNTS: Record<string, InventoryCategory> = {
  // ── Råvaror (food raw materials) ───────────────────────────────
  '4010': 'food',
  '4011': 'alcohol',
  '4012': 'beverage',
  '4015': 'disposables',          // förbrukningsmaterial
  '4017': 'takeaway_material',    // emballage / packaging (where used)
  '4018': 'takeaway_material',

  // ── Förbrukningsinventarier (small consumables) ────────────────
  '5410': 'disposables',
  '5460': 'cleaning',             // rengöringsmedel
}

/**
 * Return the canonical category for a BAS account, or null if the account
 * is not an inventory account (caller should mark the line 'not_inventory').
 */
export function categoryForBasAccount(accountNumber: string | null | undefined): InventoryCategory | null {
  if (!accountNumber) return null
  const trimmed = String(accountNumber).trim()
  return INVENTORY_BAS_ACCOUNTS[trimmed] ?? null
}

/**
 * Quick predicate for the matcher's first gate — does this line count
 * as inventory at all? Lines that fail this never enter the queue.
 */
export function isInventoryAccount(accountNumber: string | null | undefined): boolean {
  return categoryForBasAccount(accountNumber) !== null
}

export { INVENTORY_BAS_ACCOUNTS }
