// lib/sweden/vat.ts
//
// Single source of truth for Swedish VAT rate constants.
// Before this module the rates 25 / 12 / 6 were sprinkled across at
// least seven files as magic numbers and regex literals — when Sweden
// announced the temporary food-VAT cut from 12 % to 6 % effective
// 2026-04-01, the classifiers in lib/fortnox/classify.ts and
// lib/pos/personalkollen.ts silently mis-bucketed dine-in food
// revenue as takeaway because the old "6 % moms → takeaway" rule
// was hard-coded as deterministic. See VAT-MISROUTING-FIX-PLAN.md
// and docs/investigation/vat-misrouting-verdict.md.
//
// New code that consumes Swedish VAT rates should import from here.
// Pre-existing call-sites are being migrated incrementally.

export const SWEDEN_VAT = {
  /** Standard rate — alcohol, soft drinks, durables, services. */
  STANDARD: 25,
  /** Dine-in restaurant service. Unchanged by the 2026-04-01 cut. */
  RESTAURANT_DINE: 12,
  /**
   * Food sold as goods + takeaway food + groceries.
   *
   * Was 12 % until 2026-03-31. Temporary cut to 6 % from 2026-04-01
   * through 2027-12-31, then scheduled to revert to 12 %. AFTER the cut,
   * a `6 % moms` revenue line on a Swedish restaurant P&L is AMBIGUOUS:
   * it could be takeaway delivery (Wolt/Foodora/UberEats), genuine
   * food-as-goods retail, or even dine-in food if the accountant chose
   * to book it under the temporary cut rate. Code that needs to map
   * `6 %` to a revenue subset MUST consult an explicit signal (platform
   * name, per-business account override, or POS `is_take_away` flag) —
   * never assume.
   */
  FOOD_GOODS: 6,
  /** Exempt / momsfri. */
  ZERO: 0,
} as const

/** All VAT rates a Swedish restaurant might encounter on an invoice or P&L. */
export const VALID_VAT_RATES = [0, 6, 12, 25] as const
export type SwedenVatRate = typeof VALID_VAT_RATES[number]

/** ISO 8601 date when the temporary food-VAT cut takes effect. */
export const TEMP_FOOD_CUT_START = '2026-04-01'
/** ISO 8601 date when the temporary food-VAT cut is scheduled to end. */
export const TEMP_FOOD_CUT_END = '2027-12-31'

/**
 * Was the temporary food-VAT cut in effect on the given date?
 * Use this when deciding how to interpret a `6 % moms` label —
 * pre-cut it was unambiguously takeaway, post-cut it's ambiguous.
 *
 * @param dateIso YYYY-MM-DD
 */
export function isFoodVatCutActive(dateIso: string): boolean {
  return dateIso >= TEMP_FOOD_CUT_START && dateIso <= TEMP_FOOD_CUT_END
}

/**
 * The VAT rate that food-as-goods carries on the given date.
 * 6 % during the temporary cut, 12 % outside it.
 */
export function foodVatRateAt(dateIso: string): 6 | 12 {
  return isFoodVatCutActive(dateIso) ? 6 : 12
}
