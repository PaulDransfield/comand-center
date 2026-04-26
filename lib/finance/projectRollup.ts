// lib/finance/projectRollup.ts
//
// THE single function that turns an extracted Fortnox AI rollup into a
// canonical tracker_data row shape. Used by /api/fortnox/apply and only
// by /api/fortnox/apply.
//
// The point of this file: there is exactly one path from extraction → DB.
// /api/tracker, the Performance page, the aggregator and any future reader
// all consume the persisted tracker_data values verbatim. They never
// recompute net_profit, never re-derive alcohol_cost from line items,
// never fold in their own sign convention. If the formula changes, it
// changes here, then we re-apply existing extractions (their extracted_json
// blobs are immutable, so re-projection is safe and idempotent).
//
// Pattern reference: Square Books / Modern Treasury / pgledger — single
// writer, single computation, trusted reads. See
// https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/
// and FIXES.md §0n for why we adopted this.

import {
  asCost, asRevenue, asFinancial, toMoney,
  computeNetProfit, computeMarginPct,
  type RollupComponents,
} from '@/lib/finance/conventions'

export interface ExtractionRollup {
  revenue?:      number | string | null
  food_cost?:    number | string | null
  alcohol_cost?: number | string | null   // optional — extractor populates from VAT classifier
  staff_cost?:   number | string | null
  other_cost?:   number | string | null
  depreciation?: number | string | null
  financial?:    number | string | null
  net_profit?:   number | string | null   // ignored — we always recompute from components
}

export interface ExtractionLineItem {
  label?:           string | null
  label_sv?:        string | null
  label_en?:        string | null
  category?:        string | null
  subcategory?:     string | null
  amount?:          number | string | null
  fortnox_account?: number | string | null
  account?:         number | string | null
}

export interface ProjectedRollup {
  revenue:      number
  food_cost:    number
  alcohol_cost: number
  staff_cost:   number
  other_cost:   number
  depreciation: number
  financial:    number
  net_profit:   number
  margin_pct:   number
}

// Subcategory labels that count as alcohol/beverage on the cost side. Mirrors
// the VAT classifier in extract-worker (25% moms = alcohol). Kept loose
// because the extractor's subcategory naming has drifted historically.
const ALCOHOL_SUBCATS = new Set(['alcohol', 'beverages', 'beverage', 'drinks', 'alkohol'])

// Compute alcohol_cost from line items as a fallback when the extractor
// didn't populate the rollup field directly. Used for backwards-compat with
// extractions made before we added alcohol_cost to the tool schema.
function alcoholFromLines(lines: ExtractionLineItem[] | null | undefined): number {
  if (!Array.isArray(lines)) return 0
  let sum = 0
  for (const l of lines) {
    if (l?.category !== 'food_cost') continue
    const sub = String(l?.subcategory ?? '').toLowerCase()
    if (ALCOHOL_SUBCATS.has(sub)) sum += toMoney(l?.amount)
  }
  return sum
}

// THE projection. Takes whatever the extractor produced and returns the
// canonical shape we persist + read everywhere downstream.
export function projectRollup(
  rollupRaw: ExtractionRollup | null | undefined,
  lines:     ExtractionLineItem[] | null | undefined,
): ProjectedRollup {
  const r = rollupRaw ?? {}

  const revenue      = asRevenue(r.revenue)
  const food_cost    = asCost(r.food_cost)
  const staff_cost   = asCost(r.staff_cost)
  const other_cost   = asCost(r.other_cost)
  const depreciation = asCost(r.depreciation)
  const financial    = asFinancial(r.financial)

  // alcohol_cost: prefer the extractor's top-level value when present (post
  // 2026-04-26), fall back to summing line items (pre 2026-04-26 extractions
  // backfilled by M028). Clamp to food_cost so we can never report
  // alcohol > total food (a rounding artefact would otherwise leak into the
  // food-only display).
  const alcoholRaw  = r.alcohol_cost == null ? alcoholFromLines(lines) : asCost(r.alcohol_cost)
  const alcohol_cost = Math.min(alcoholRaw, food_cost)

  const components: RollupComponents = {
    revenue, food_cost, staff_cost, other_cost, depreciation, financial,
  }
  const net_profit = computeNetProfit(components)
  const margin_pct = computeMarginPct(net_profit, revenue)

  // Round at the boundary so storage values are clean money. Internal math
  // happens at full precision above; only the persisted shape rounds.
  return {
    revenue:      Math.round(revenue),
    food_cost:    Math.round(food_cost),
    alcohol_cost: Math.round(alcohol_cost),
    staff_cost:   Math.round(staff_cost),
    other_cost:   Math.round(other_cost),
    depreciation: Math.round(depreciation),
    financial:    Math.round(financial),
    net_profit:   Math.round(net_profit),
    margin_pct,
  }
}
