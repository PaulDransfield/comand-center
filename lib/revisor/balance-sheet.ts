// lib/revisor/balance-sheet.ts
//
// Compute a Swedish balansräkning (balance sheet) for a (business,
// year, month) by combining:
//   1. Fortnox opening balances (Ingående balans, IB) for the fiscal
//      year containing the requested month — one API call per account
//      with 24h caching via lib/fortnox/api/account-balance.ts.
//   2. Voucher row deltas from year-start to month-end — via the
//      M080 voucher cache; sub-second after the first month load.
//
// Closing balance per account = opening_balance + Σ(Debit − Credit)
// over the period. We display debit-positive throughout; the BAS
// account-class prefix determines whether the account belongs in
// Assets vs Equity vs Liabilities.
//
// BAS chart (BAS 2024) account classes for balance sheet:
//   1xxx — Tillgångar (Assets)
//   2000-2199 — Eget kapital (Equity, incl. obeskattade reserver)
//   2200-2399 — Långfristiga skulder (Long-term liabilities)
//   2400-2999 — Kortfristiga skulder (Current liabilities)
//   3000-8999 — P&L (not on balance sheet) — feed into årets resultat
//
// Årets resultat (year-to-date P&L) is computed from voucher rows on
// 3xxx-8xxx accounts and added to the Equity section as the typical
// dynamic equity row.

import { getCachedVouchersForRange }       from '@/lib/fortnox/voucher-cache'
import { fetchAccountsList }               from '@/lib/fortnox/api/accounts-list'
import { getFreshFortnoxAccessToken }      from '@/lib/fortnox/api/auth'
import { basAccountDescription }           from './bas-chart'

// ── Public types ───────────────────────────────────────────────────

export interface BalanceSheetLine {
  account:     number
  description: string
  amount:      number              // closing balance, debit-positive
}

export interface BalanceSheetSection {
  title:    string                  // e.g. 'Tillgångar'
  groups:   Array<{
    title:  string                  // e.g. 'Anläggningstillgångar'
    lines:  BalanceSheetLine[]
    total:  number
  }>
  total:    number
}

export interface BalanceSheetResult {
  business_id:        string
  period_year:        number
  period_month:       number
  period_end_date:    string                            // YYYY-MM-DD
  fiscal_year_from:   string
  fiscal_year_to:     string

  assets:             BalanceSheetSection
  equity:             BalanceSheetSection
  liabilities:        BalanceSheetSection

  // Totals & balance check
  total_assets:                 number
  total_equity_and_liabilities: number
  imbalance:                    number     // assets - (equity + liab); should be ~0

  ytd_result:                   number     // årets resultat YTD through this month
  voucher_count:                number
}

// ── Account classification helpers ─────────────────────────────────

type BsClass = 'asset' | 'equity' | 'long_term_liab' | 'current_liab' | 'pl'

function classifyAccount(account: number): BsClass {
  if (account >= 1000 && account <= 1999) return 'asset'
  if (account >= 2000 && account <= 2199) return 'equity'
  if (account >= 2200 && account <= 2399) return 'long_term_liab'
  if (account >= 2400 && account <= 2999) return 'current_liab'
  return 'pl'
}

// Asset subclass for grouping within Assets section
function assetGroup(account: number): string {
  if (account >= 1000 && account <= 1099) return 'Immateriella anläggningstillgångar'
  if (account >= 1100 && account <= 1299) return 'Materiella anläggningstillgångar'
  if (account >= 1300 && account <= 1399) return 'Finansiella anläggningstillgångar'
  if (account >= 1400 && account <= 1499) return 'Lager'
  if (account >= 1500 && account <= 1899) return 'Fordringar och förutbetalda kostnader'
  if (account >= 1900 && account <= 1999) return 'Kassa och bank'
  return 'Övriga tillgångar'
}

// ── Main entrypoint ────────────────────────────────────────────────

export async function computeBalanceSheet(
  db:         any,
  orgId:      string,
  businessId: string,
  year:       number,
  month:      number,
): Promise<BalanceSheetResult> {
  // 1. Period end (end-of-requested-month).
  const monthEnd = (() => {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
    return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`
  })()

  // 1a. Fetch Fortnox access token + FULL accounts list for the FY
  //     containing the requested period end. The list response gives us:
  //       - real fiscal-year start (used to scope the voucher walk)
  //       - opening balance (BalanceBroughtForward) for EVERY account
  //         the customer has — including ones that don't move in the
  //         requested period.
  //
  //     Pre-2026-05-23 we only fetched IBs for accounts referenced in
  //     vouchers. That dropped fixed-asset accounts (e.g. 1220 Inventarier)
  //     that have carry-over IB but no current-period movement — so
  //     their contra (1229 Ackum. avskr.) appeared on the asset side
  //     alone, dragging assets negative by the magnitude of the missing
  //     cost basis.
  //
  //     Soft-fail: if accounts list fails (token issue / Fortnox 5xx /
  //     timeout), we fall back to the old voucher-only approach via the
  //     loop below — the balance sheet may be incomplete but at least
  //     renders.
  let accountsList: Awaited<ReturnType<typeof fetchAccountsList>> | null = null
  try {
    const accessToken = await getFreshFortnoxAccessToken(db, orgId, businessId)
    if (accessToken) {
      accountsList = await fetchAccountsList(db, orgId, businessId, accessToken, {
        anchorDate: monthEnd,
      })
    }
  } catch { /* soft-fail to fallback path */ }

  const fyStart = accountsList?.fiscal_year_from && accountsList.fiscal_year_from <= monthEnd
    ? accountsList.fiscal_year_from
    : `${year}-01-01`

  const fetchResult = await getCachedVouchersForRange({
    db,
    orgId,
    businessId,
    fromDate: fyStart,
    toDate:   monthEnd,
  })
  const vouchers = fetchResult.vouchers

  // 2. Walk voucher rows, accumulate (debit, credit) per account.
  const accumByAccount = new Map<number, { debit: number; credit: number; description: string }>()
  for (const v of vouchers) {
    for (const r of (v.VoucherRows ?? [])) {
      if ((r as any).Removed) continue
      const acc = Number(r.Account)
      if (!Number.isFinite(acc)) continue
      let entry = accumByAccount.get(acc)
      if (!entry) {
        entry = {
          debit:       0,
          credit:      0,
          description: r.AccountDescription ?? basAccountDescription(acc),
        }
        accumByAccount.set(acc, entry)
      }
      entry.debit  += Number(r.Debit)  || 0
      entry.credit += Number(r.Credit) || 0
    }
  }

  // 3. Build opening-balance map. Prefer the accounts-list response —
  //    it covers EVERY account the customer has including ones with no
  //    period movement. Fall back to zero if the list call soft-failed.
  const openingBalances: Record<number, number> = {}
  if (accountsList) {
    for (const [accStr, a] of Object.entries(accountsList.accounts)) {
      openingBalances[Number(accStr)] = Number(a.opening_balance ?? 0)
    }
  }

  // 4. Compute closing balance per account. closing = opening + delta.
  //    Walk the union of (accounts with movement) and (accounts with
  //    opening balance) — either path can contribute to the balance sheet.
  const closingByAccount = new Map<number, number>()
  const allAccounts = new Set<number>([
    ...accumByAccount.keys(),
    ...Object.keys(openingBalances).map(Number),
  ])
  for (const acc of allAccounts) {
    const cls = classifyAccount(acc)
    if (cls === 'pl') continue                                 // P&L feeds Årets resultat, not balance sheet
    const opening = openingBalances[acc] ?? 0
    const entry   = accumByAccount.get(acc)
    const delta   = entry ? entry.debit - entry.credit : 0
    closingByAccount.set(acc, opening + delta)

    // Ensure we have a description even for accounts with no movement.
    if (!accumByAccount.has(acc)) {
      const desc = accountsList?.accounts[acc]?.description ?? basAccountDescription(acc)
      accumByAccount.set(acc, { debit: 0, credit: 0, description: desc })
    }
  }

  // 6. Compute YTD result from P&L accounts.
  //    Revenue (3xxx) is credit-positive; cost/financial (4-8xxx) is debit-positive.
  //    Result = revenue - costs - financial — in debit-positive terms:
  //      result = -(3xxx net) - (4-7xxx net) + (8xxx net signed)
  //    Simplification: result = - Σ(debit - credit) over all P&L accounts.
  //    Because for revenue: credit > debit, net is negative, -net is positive.
  //    For costs: debit > credit, net is positive, -net is negative.
  //    Sum gives revenue - costs = profit.
  let ytdResult = 0
  for (const [acc, entry] of accumByAccount.entries()) {
    if (classifyAccount(acc) !== 'pl') continue
    const net = entry.debit - entry.credit
    ytdResult += -net
  }

  // 7. Assemble Assets section
  const assetEntries: Array<{ acc: number; amount: number; description: string }> = []
  for (const [acc, amount] of closingByAccount.entries()) {
    if (classifyAccount(acc) !== 'asset') continue
    if (Math.abs(amount) < 0.5) continue            // hide zero accounts
    assetEntries.push({
      acc,
      amount,
      description: accumByAccount.get(acc)?.description ?? basAccountDescription(acc),
    })
  }
  assetEntries.sort((a, b) => a.acc - b.acc)

  const assetGroups = new Map<string, BalanceSheetLine[]>()
  for (const e of assetEntries) {
    const g = assetGroup(e.acc)
    if (!assetGroups.has(g)) assetGroups.set(g, [])
    assetGroups.get(g)!.push({ account: e.acc, description: e.description, amount: e.amount })
  }
  const assetsSection: BalanceSheetSection = {
    title:  'Tillgångar',
    groups: Array.from(assetGroups.entries()).map(([title, lines]) => ({
      title,
      lines,
      total: lines.reduce((s, l) => s + l.amount, 0),
    })),
    total:  0,
  }
  assetsSection.total = assetsSection.groups.reduce((s, g) => s + g.total, 0)

  // 8. Equity section: 2xxx accounts (2000-2199) — closing balances are
  //    credit-positive (typical equity sign in BAS). We DISPLAY equity
  //    as positive numbers (the absolute value of credit-side balance).
  //    Plus we append "Årets resultat (YTD)" as a derived line.
  const equityLines: BalanceSheetLine[] = []
  for (const [acc, amount] of closingByAccount.entries()) {
    if (classifyAccount(acc) !== 'equity') continue
    // Equity = credit balance = our debit-positive convention says
    // the closing is NEGATIVE for a healthy equity account. Display
    // as |amount| with the right convention; sum-up takes the negated value.
    const equityValue = -amount
    if (Math.abs(equityValue) < 0.5) continue
    equityLines.push({
      account:     acc,
      description: accumByAccount.get(acc)?.description ?? basAccountDescription(acc),
      amount:      equityValue,
    })
  }
  equityLines.sort((a, b) => a.account - b.account)

  // Append the YTD result line (only if it differs from any 2099 row
  // that's already present — to avoid double-counting).
  const has2099 = equityLines.some(l => l.account === 2099 || l.account === 2019)
  if (!has2099 && Math.abs(ytdResult) > 0.5) {
    equityLines.push({
      account:     2099,
      description: 'Årets resultat (YTD)',
      amount:      ytdResult,
    })
  }

  const equitySection: BalanceSheetSection = {
    title:  'Eget kapital',
    groups: [{
      title: 'Bundet och fritt eget kapital',
      lines: equityLines,
      total: equityLines.reduce((s, l) => s + l.amount, 0),
    }],
    total:  equityLines.reduce((s, l) => s + l.amount, 0),
  }

  // 9. Liabilities section: long-term + current.
  const ltLines: BalanceSheetLine[]    = []
  const curLines: BalanceSheetLine[]   = []
  for (const [acc, amount] of closingByAccount.entries()) {
    const cls = classifyAccount(acc)
    if (cls !== 'long_term_liab' && cls !== 'current_liab') continue
    const liabValue = -amount                        // liab = credit balance, flip to display-positive
    if (Math.abs(liabValue) < 0.5) continue
    const target = cls === 'long_term_liab' ? ltLines : curLines
    target.push({
      account:     acc,
      description: accumByAccount.get(acc)?.description ?? basAccountDescription(acc),
      amount:      liabValue,
    })
  }
  ltLines.sort((a, b) => a.account - b.account)
  curLines.sort((a, b) => a.account - b.account)

  const liabSection: BalanceSheetSection = {
    title:  'Skulder',
    groups: [
      { title: 'Långfristiga skulder', lines: ltLines,  total: ltLines.reduce ((s, l) => s + l.amount, 0) },
      { title: 'Kortfristiga skulder', lines: curLines, total: curLines.reduce((s, l) => s + l.amount, 0) },
    ].filter(g => g.lines.length > 0),
    total:  ltLines.reduce((s, l) => s + l.amount, 0) + curLines.reduce((s, l) => s + l.amount, 0),
  }

  // 10. Totals + imbalance check
  const totalAssets       = assetsSection.total
  const totalEquityAndLib = equitySection.total + liabSection.total

  return {
    business_id:                  businessId,
    period_year:                  year,
    period_month:                 month,
    period_end_date:              monthEnd,
    fiscal_year_from:             accountsList?.fiscal_year_from || fyStart,
    fiscal_year_to:               accountsList?.fiscal_year_to   || `${year}-12-31`,
    assets:                       assetsSection,
    equity:                       equitySection,
    liabilities:                  liabSection,
    total_assets:                 totalAssets,
    total_equity_and_liabilities: totalEquityAndLib,
    imbalance:                    totalAssets - totalEquityAndLib,
    ytd_result:                   ytdResult,
    voucher_count:                vouchers.length,
  }
}
