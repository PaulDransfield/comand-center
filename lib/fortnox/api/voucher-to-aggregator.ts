// lib/fortnox/api/voucher-to-aggregator.ts
//
// Phase 1 verification translation layer. Takes the array of full Fortnox
// vouchers (with VoucherRows) returned by `fetchVouchersForRange` and produces
// the inputs that `projectRollup` already accepts: a `(rollup, lines)` pair
// per (year, month) period.
//
// We do NOT rewrite the aggregator. We do NOT touch projectRollup. This file
// only produces the shape projectRollup already consumes — same idea as the
// PDF extractor's output, just sourced from the API.
//
// What this DOES handle:
//   • Per-row sign convention (debit-credit per BAS account class)
//   • Account → category mapping via the existing `classifyByAccount`
//   • Period grouping by `voucher.TransactionDate`
//   • Producing the line-item array projectRollup uses for backwards-compat
//     fallbacks
//
// What this DOES NOT handle (acknowledged limitations for the report):
//   • VAT-rate revenue split (dine_in / takeaway / alcohol). Resultatrapport
//     PDFs have label rows like "Försäljning 12 % moms" that classifyByVat
//     can read; voucher rows do not. The proper VAT split needs the chart
//     of accounts (3xxx range subdivides by VAT class) plus the VAT-output
//     liability accounts (2611/2614/2640). This is left blank — the harness
//     report should call out the resulting subset values as 0 from the API
//     path and explain why.
//   • Removed/cancelled rows. We honour `row.Removed === true` and skip them.
//   • Period boundary effects. We use `voucher.TransactionDate` as the
//     authoritative period date; if a customer has month-end vouchers dated
//     into the next period (rare in Fortnox but allowed), they roll into
//     that next period.

import {
  classifyByAccount,
  classifyByVat,
  classifyLabel,
} from '@/lib/fortnox/classify'
import type {
  ExtractionLineItem,
  ExtractionRollup,
} from '@/lib/finance/projectRollup'
import type { FortnoxVoucher, FortnoxVoucherRow } from './vouchers'

export interface PeriodInput {
  year:    number
  month:   number          // 1-12
  rollup:  ExtractionRollup
  lines:   ExtractionLineItem[]
  /** Number of vouchers contributing to this period. */
  voucherCount: number
}

export interface TranslationResult {
  /** One per (year, month) period that had at least one voucher. */
  periods: PeriodInput[]
  /** Vouchers we couldn't classify (no rows, no transaction date, etc.) */
  skipped: Array<{ series: string; number: number; reason: string }>
}

/**
 * Translate a list of API-fetched vouchers into per-period rollup + line items.
 * The output is ready to pass to projectRollup() unchanged.
 */
export function translateVouchersToPeriods(vouchers: FortnoxVoucher[]): TranslationResult {
  const byPeriod = new Map<string, PeriodInput>()
  const skipped: TranslationResult['skipped'] = []

  for (const v of vouchers) {
    if (!v.TransactionDate || !Array.isArray(v.VoucherRows) || v.VoucherRows.length === 0) {
      skipped.push({
        series: v.VoucherSeries,
        number: v.VoucherNumber,
        reason: !v.TransactionDate ? 'missing TransactionDate' : 'no VoucherRows',
      })
      continue
    }

    // Use TransactionDate's year+month as the period. Fortnox dates are
    // YYYY-MM-DD; defensive parse against ISO timestamps too.
    const year  = Number(v.TransactionDate.slice(0, 4))
    const month = Number(v.TransactionDate.slice(5, 7))
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      skipped.push({
        series: v.VoucherSeries,
        number: v.VoucherNumber,
        reason: `invalid TransactionDate ${v.TransactionDate}`,
      })
      continue
    }

    const periodKey = `${year}-${String(month).padStart(2, '0')}`
    let period = byPeriod.get(periodKey)
    if (!period) {
      period = {
        year,
        month,
        rollup: {
          revenue:      0,
          food_cost:    0,
          alcohol_cost: 0,
          staff_cost:   0,
          other_cost:   0,
          depreciation: 0,
          financial:    0,
        },
        lines:        [],
        voucherCount: 0,
      }
      byPeriod.set(periodKey, period)
    }
    period.voucherCount++

    for (const row of v.VoucherRows) {
      if (row?.Removed) continue
      const lineItem = translateRow(row, v)
      if (!lineItem) continue
      period.lines.push(lineItem)
      bumpRollup(period.rollup, lineItem)
    }
  }

  // Stable order — chronological ascending. Makes report diffs deterministic.
  const periods = Array.from(byPeriod.values()).sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.month - b.month,
  )
  return { periods, skipped }
}

// ── Row translation ──────────────────────────────────────────────────────────

/**
 * Map a single voucher row to the ExtractionLineItem shape projectRollup
 * already understands. Returns null if the row contributes nothing
 * meaningful (zero-amount lines, account outside any known category, etc.).
 */
function translateRow(row: FortnoxVoucherRow, v: FortnoxVoucher): ExtractionLineItem | null {
  const account = Number(row.Account)
  if (!Number.isFinite(account)) return null

  const debit  = Number(row.Debit  ?? 0)
  const credit = Number(row.Credit ?? 0)
  if (!Number.isFinite(debit) || !Number.isFinite(credit)) return null
  if (debit === 0 && credit === 0) return null

  const acctClass = classifyByAccount(account)
  if (!acctClass) return null  // accounts outside our category ranges (1xxx assets, 2xxx liabilities, etc. — VAT and balance-sheet movements)

  // Sign convention per BAS double-entry, mapped to storage convention:
  //   3xxx revenue:      net contribution = credit - debit (positive)
  //   4xxx-7799 costs:   net contribution = debit - credit (positive)
  //   7800-7899 deprec.: net contribution = debit - credit (positive)
  //   7900-7999 staff:   net contribution = debit - credit (positive)
  //   8000-8899 financial: net contribution = credit - debit
  //                          (positive = interest income; negative = expense)
  //   8900-8999 tax:     debit-credit (positive cost; we tag as financial.tax)
  let signedAmount: number
  switch (acctClass.category) {
    case 'revenue':
      signedAmount = credit - debit       // > 0 increases revenue
      break
    case 'food_cost':
    case 'staff_cost':
    case 'other_cost':
    case 'depreciation':
      signedAmount = debit - credit       // > 0 increases the cost
      break
    case 'financial':
      // Tax sub-bucket: debit - credit gives positive cost, which projectRollup
      // treats as part of the signed `financial` field. Net interest is also
      // signed via credit - debit. Differentiate:
      signedAmount = acctClass.subcategory === 'tax'
        ? -(debit - credit)               // tax pushes financial more negative
        : credit - debit                  // income +, expense −
      break
    default:
      return null
  }

  // Drop net-zero lines (offsetting debit + credit on the same row, rare but
  // possible when a row corrects itself).
  if (signedAmount === 0) return null

  // Label preference: voucher row description, else voucher description, else
  // empty string. classifyByVat reads the Swedish "X% moms" wording from the
  // label; voucher rows rarely carry that, so VAT classification will mostly
  // miss — that's expected and documented at the top of the file.
  const label = String(row.Description ?? row.AccountDescription ?? v.Description ?? '').trim()
  let subcategory = acctClass.subcategory ?? null

  // For revenue + food_cost lines, ATTEMPT a VAT-rate refinement so the
  // verification path doesn't lose 100% of the dine_in/takeaway/alcohol
  // signal. classifyByVat returns null when the label doesn't match — we
  // accept that.
  if (acctClass.category === 'revenue' || acctClass.category === 'food_cost') {
    const vat = classifyByVat(label)
    if (vat?.subcategory) subcategory = vat.subcategory
  }

  // For revenue + costs, projectRollup expects a positive `amount` (it
  // re-applies the sign via asCost / asRevenue). For financial, the sign
  // is already correct.
  let amount: number
  if (acctClass.category === 'financial') {
    amount = signedAmount               // signed
  } else if (signedAmount < 0) {
    // Revenue/cost line that net to a refund/correction. Drop it from the
    // rollup — projectRollup's asCost/asRevenue would clamp negatives via
    // abs() and double-count. The right behaviour is to net-it-out at the
    // line level, which we already did above.
    return null
  } else {
    amount = signedAmount
  }

  return {
    label,
    label_sv:        label,
    category:        acctClass.category,
    subcategory,
    amount,
    fortnox_account: account,
    account,
  }
}

// ── Rollup accumulation ──────────────────────────────────────────────────────

function bumpRollup(rollup: ExtractionRollup, line: ExtractionLineItem): void {
  const amount = Number(line.amount ?? 0)
  if (!Number.isFinite(amount)) return
  switch (line.category) {
    case 'revenue':
      rollup.revenue = (Number(rollup.revenue) || 0) + amount
      // Also bump the appropriate revenue subset when classifyByVat tagged it.
      if (line.subcategory === 'food' || line.subcategory === 'dine_in') {
        rollup.dine_in_revenue  = (Number(rollup.dine_in_revenue)  || 0) + amount
      } else if (line.subcategory === 'takeaway') {
        rollup.takeaway_revenue = (Number(rollup.takeaway_revenue) || 0) + amount
      } else if (line.subcategory === 'alcohol') {
        rollup.alcohol_revenue  = (Number(rollup.alcohol_revenue)  || 0) + amount
      }
      break
    case 'food_cost':
      rollup.food_cost    = (Number(rollup.food_cost)    || 0) + amount
      if (line.subcategory === 'alcohol') {
        rollup.alcohol_cost = (Number(rollup.alcohol_cost) || 0) + amount
      }
      break
    case 'staff_cost':
      rollup.staff_cost   = (Number(rollup.staff_cost)   || 0) + amount
      break
    case 'other_cost':
      rollup.other_cost   = (Number(rollup.other_cost)   || 0) + amount
      break
    case 'depreciation':
      rollup.depreciation = (Number(rollup.depreciation) || 0) + amount
      break
    case 'financial':
      // amount is already signed for financial lines.
      rollup.financial    = (Number(rollup.financial)    || 0) + amount
      break
  }
}
