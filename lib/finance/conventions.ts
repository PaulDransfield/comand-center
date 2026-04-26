// lib/finance/conventions.ts
//
// THE sign convention for CommandCenter's financial pipeline. One file, one
// convention, every writer + reader goes through here. Adopted after FIXES.md
// §0n — where /api/tracker and the Performance page were silently subtracting
// `financial` while extract-worker and apply were adding it. The drift
// produced wrong net_profit on the dashboard.
//
// The pattern is borrowed from production accounting platforms:
//   • Square Books — debits positive, credits negative; storage convention is
//     sacrosanct, display layer translates
//     https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/
//   • pgledger     — all transfers are signed deltas in one convention
//     https://github.com/pgr0ss/pgledger
//   • Beancount    — every transaction posts opposite signs to two accounts;
//     signs always carry meaning consistently
//
// CONVENTION (storage layer — every column in tracker_data, monthly_metrics,
// extracted_json.rollup follows this):
//
//   revenue        positive — money in
//   food_cost      positive — cost of goods sold (kept as a cost magnitude)
//   alcohol_cost   positive — subset of food_cost (not double-counted)
//   staff_cost     positive — payroll + payroll tax + pension
//   other_cost     positive — rent + utilities + admin (5xxx + 6xxx)
//   depreciation   positive — 78xx avskrivningar
//   financial      SIGNED   — 8xxx interest items
//                            negative = net interest expense
//                            positive = net interest income
//   net_profit     SIGNED   — revenue − food − staff − other − depreciation
//                            + financial
//
// All arithmetic in this file uses this convention. Display formatters can
// flip signs as needed (e.g. show "Costs" tab with positive values, show a
// (parenthesised) negative for net loss). Storage is never display.

// ── Coercion helpers ────────────────────────────────────────────────────────
// Supabase returns NUMERIC columns as strings. Coerce + clamp NaN→0 so callers
// never get bitten by `0 + "23899.00" = "023899.00"` (the daily_metrics bug
// from FIXES.md §0).
export function toMoney(v: unknown): number {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : 0
}

// Cost values must always be positive in storage. If a writer accidentally
// passes a negative (e.g. raw debit), this clamps and throws in dev.
export function asCost(v: unknown): number {
  const n = toMoney(v)
  if (n < 0) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[conventions] asCost received negative value: ${n} — using abs()`)
    }
    return Math.abs(n)
  }
  return n
}

// Revenue values must always be positive in storage.
export function asRevenue(v: unknown): number {
  const n = toMoney(v)
  if (n < 0) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[conventions] asRevenue received negative value: ${n} — using abs()`)
    }
    return Math.abs(n)
  }
  return n
}

// Financial items are signed. Pass through as-is.
export function asFinancial(v: unknown): number {
  return toMoney(v)
}

// ── The single net_profit formula ───────────────────────────────────────────
// Used by lib/finance/projectRollup.ts (write side) and the aggregator (read
// side). Anything else that needs net_profit reads it from the persisted
// tracker_data.net_profit column — this function is the only place that
// computes it from raw components.
export interface RollupComponents {
  revenue:      number
  food_cost:    number
  staff_cost:   number
  other_cost:   number
  depreciation: number
  financial:    number
}

export function computeNetProfit(c: RollupComponents): number {
  return asRevenue(c.revenue)
    - asCost(c.food_cost)
    - asCost(c.staff_cost)
    - asCost(c.other_cost)
    - asCost(c.depreciation)
    + asFinancial(c.financial)
}

export function computeMarginPct(netProfit: number, revenue: number): number {
  const r = asRevenue(revenue)
  if (r <= 0) return 0
  return Math.round((netProfit / r) * 1000) / 10
}

// total_cost = sum of all positive cost components. Excludes `financial`
// because financial is signed (you can have net interest income, which would
// reduce total_cost in a confusing way). Use this for ratios like cost/revenue.
export function computeTotalCost(c: RollupComponents): number {
  return asCost(c.food_cost)
    + asCost(c.staff_cost)
    + asCost(c.other_cost)
    + asCost(c.depreciation)
}

// ── Display helpers ─────────────────────────────────────────────────────────
// Storage uses the convention above; display layers may want to show
// negative numbers as parentheses or flip costs to negative. Use these so
// the convention shift only happens at the UI boundary.

export function displaySigned(n: number): string {
  // Swedish convention: thin space as thousands separator, no decimals for kr.
  const abs = Math.abs(Math.round(n))
  const formatted = abs.toLocaleString('sv-SE').replace(/,/g, ' ')
  return n < 0 ? `(${formatted})` : formatted
}

export function displayCost(n: number): string {
  // Costs are positive in storage; show with leading minus on the financial
  // statement display ("− 350 000") if the caller wants accountant-style.
  return displaySigned(asCost(n))
}
