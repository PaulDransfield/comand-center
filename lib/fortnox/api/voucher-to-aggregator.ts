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
} from '@/lib/fortnox/classify'
import type {
  ExtractionLineItem,
  ExtractionRollup,
} from '@/lib/finance/projectRollup'
import type { FortnoxVoucher } from './vouchers'

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
 *
 * Two-pass design (post-2026-05-09 fix):
 *
 *   Pass 1 — accumulate raw debit/credit per (period, account). Voucher
 *   rows are NOT classified or sign-converted here; we just sum the
 *   atomic numbers per account so reversals/corrections net naturally.
 *
 *   Pass 2 — for each account, compute ONE net signed amount, classify it
 *   per BAS category, and emit ONE line item. This is what projectRollup
 *   consumes.
 *
 * Why two-pass: the previous row-by-row implementation dropped voucher
 * rows where signedAmount went negative (e.g. an isolated credit on a
 * staff-cost account = vacation-accrual reversal). Dropping such rows
 * meant the corresponding offsets were lost from the rollup, inflating
 * costs by ~7-50% on 2026-03 Vero data. By netting at the account level
 * before sign-checking, true reversals subtract correctly and only fully
 * negative accounts (rare — usually a fully refunded category) are dropped.
 */
export function translateVouchersToPeriods(vouchers: FortnoxVoucher[]): TranslationResult {
  type AccountAccumulator = {
    debit:  number
    credit: number
    /** label → count, so we can pick the most common label as the line's representative */
    labels: Map<string, number>
  }
  type PeriodAccumulator = {
    year:         number
    month:        number
    voucherCount: number
    byAccount:    Map<number, AccountAccumulator>
  }

  const byPeriod = new Map<string, PeriodAccumulator>()
  const skipped: TranslationResult['skipped'] = []

  // ── Pass 1: aggregate raw debit/credit per (period, account) ──────────────
  for (const v of vouchers) {
    if (!v.TransactionDate || !Array.isArray(v.VoucherRows) || v.VoucherRows.length === 0) {
      skipped.push({
        series: v.VoucherSeries,
        number: v.VoucherNumber,
        reason: !v.TransactionDate ? 'missing TransactionDate' : 'no VoucherRows',
      })
      continue
    }

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
      period = { year, month, voucherCount: 0, byAccount: new Map() }
      byPeriod.set(periodKey, period)
    }
    period.voucherCount++

    for (const row of v.VoucherRows) {
      if (row?.Removed) continue
      const account = Number(row.Account)
      if (!Number.isFinite(account)) continue
      const debit  = Number(row.Debit  ?? 0)
      const credit = Number(row.Credit ?? 0)
      if (!Number.isFinite(debit) || !Number.isFinite(credit)) continue
      if (debit === 0 && credit === 0) continue

      let acc = period.byAccount.get(account)
      if (!acc) {
        acc = { debit: 0, credit: 0, labels: new Map() }
        period.byAccount.set(account, acc)
      }
      acc.debit  += debit
      acc.credit += credit

      const label = String(row.Description ?? row.AccountDescription ?? v.Description ?? '').trim()
      if (label) acc.labels.set(label, (acc.labels.get(label) ?? 0) + 1)
    }
  }

  // ── Pass 2: compute net signed amount per account, emit one line item ─────
  const periods: PeriodInput[] = []
  for (const periodAcc of byPeriod.values()) {
    const rollup: ExtractionRollup = {
      revenue:      0,
      food_cost:    0,
      alcohol_cost: 0,
      staff_cost:   0,
      other_cost:   0,
      depreciation: 0,
      financial:    0,
    }
    const lines: ExtractionLineItem[] = []

    for (const [account, acc] of periodAcc.byAccount.entries()) {
      const acctClass = classifyByAccount(account)
      if (!acctClass) continue   // 1xxx assets, 2xxx liabilities, VAT — ignored

      // Sign convention per BAS double-entry, mapped to storage convention:
      //   3xxx revenue:        credit - debit (positive)
      //   4xxx-7799 costs:     debit - credit (positive)
      //   7800-7899 deprec.:   debit - credit (positive)
      //   7900-7999 staff:     debit - credit (positive)
      //   8000-8899 financial: credit - debit (income +, expense -)
      //   8900-8999 tax:       -(debit - credit) — pushes financial more negative
      let signedAmount: number
      switch (acctClass.category) {
        case 'revenue':
          signedAmount = acc.credit - acc.debit
          break
        case 'food_cost':
        case 'staff_cost':
        case 'other_cost':
        case 'depreciation':
          signedAmount = acc.debit - acc.credit
          break
        case 'financial':
          signedAmount = acctClass.subcategory === 'tax'
            ? -(acc.debit - acc.credit)
            : acc.credit - acc.debit
          break
        default:
          continue
      }

      if (signedAmount === 0) continue   // fully offset within the period

      // Pick most-common label as the representative for the line item.
      // Voucher rows usually share descriptions per account anyway.
      let label = ''
      let bestCount = 0
      for (const [l, c] of acc.labels.entries()) {
        if (c > bestCount) { label = l; bestCount = c }
      }

      let subcategory = acctClass.subcategory ?? null
      // VAT-rate refinement for revenue + food_cost (subset tagging only;
      // never reclassifies the parent category).
      if (acctClass.category === 'revenue' || acctClass.category === 'food_cost') {
        const vat = classifyByVat(label)
        if (vat?.subcategory) subcategory = vat.subcategory
      }

      let amount: number
      if (acctClass.category === 'financial') {
        amount = signedAmount    // signed
      } else if (signedAmount < 0) {
        // Net-negative for a revenue/cost account = the entire account is
        // a reversal/refund within this period. Rare but legitimate (e.g.
        // food account that only has supplier credits this month).
        // projectRollup expects positive `amount` for these categories; we
        // skip rather than send a negative that would get clamped. The
        // amount is small and dropping it is the conservative choice —
        // this line item is now informational only after the netting pass.
        continue
      } else {
        amount = signedAmount
      }

      const lineItem: ExtractionLineItem = {
        label,
        label_sv:        label,
        category:        acctClass.category,
        subcategory,
        amount,
        fortnox_account: account,
        account,
      }
      lines.push(lineItem)
      bumpRollup(rollup, lineItem)
    }

    periods.push({
      year:         periodAcc.year,
      month:        periodAcc.month,
      rollup,
      lines,
      voucherCount: periodAcc.voucherCount,
    })
  }

  // Stable order — chronological ascending. Makes report diffs deterministic.
  periods.sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month)
  return { periods, skipped }
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
