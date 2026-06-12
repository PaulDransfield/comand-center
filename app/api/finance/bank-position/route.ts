// app/api/finance/bank-position/route.ts
//
// Phase 5 cash visibility. Returns the net bank movements per closed month
// (from BAS bank accounts 1910-1979 in voucher data we already have) plus
// a cumulative "since-tracking-began" position estimate. Used by the
// dashboard's Cash Position tile.
//
// GET /api/finance/bank-position?business_id=<uuid>[&months=12]
//
// Response shape:
//   {
//     business_id, currency,
//     monthly: [{ year, month, net_change, cumulative, accounts }, ...]  // chronological
//     summary: {
//       current_position_since_tracking: <int kr>,     // cumulative sum across all rows we have
//       this_month_change:               <int kr|null>,
//       last_month_change:               <int kr|null>,
//       last_12m_change:                 <int kr|null>,
//       months_with_data:                <int>,
//     },
//     coverage: {
//       earliest_period:  'YYYY-MM' | null,
//       latest_period:    'YYYY-MM' | null,
//       is_provisional_latest: boolean   // latest period not closed yet
//     }
//   }
//
// Honesty: we do NOT pretend this is an absolute bank balance. The customer's
// opening balance before they connected to CommandCenter is unknown. The
// number is the CUMULATIVE NET CHANGE since the data we hold begins. The tile
// labels it accordingly. Phase 2 will add an absolute-balance fetch via
// Fortnox's account-charts endpoint.
//
// Filter: only reads rows where bank_net_change IS NOT NULL (avoids mixing
// in PDF rollups and other writers that don't produce bank data).

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { fetchBankAccountBalances } from '@/lib/fortnox/api/account-balance'
import { detectBookkeepingLag }     from '@/lib/finance/bookkeeping-lag'

export const runtime         = 'nodejs'
export const dynamic         = 'force-dynamic'
export const preferredRegion = 'fra1'
export const maxDuration     = 30

interface MonthRow {
  year:         number
  month:        number
  net_change:   number
  cumulative:   number
  accounts:     Record<string, { debit: number; credit: number; net: number }> | null
  is_provisional: boolean
}

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const businessId = String(req.nextUrl.searchParams.get('business_id') ?? '').trim()
  const monthsParam = Number(req.nextUrl.searchParams.get('months') ?? 24)
  const monthsWanted = Number.isFinite(monthsParam) ? Math.min(Math.max(monthsParam, 1), 36) : 24
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()

  // Verify org ownership.
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id, currency')
    .eq('id', businessId)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'Business not found in your org' }, { status: 404 })

  // Pull every closed-or-provisional period that has bank data. Order
  // ascending so cumulative sum walks naturally forward in time.
  const { data: rows, error } = await db
    .from('tracker_data')
    .select('period_year, period_month, bank_net_change, bank_accounts, is_provisional')
    .eq('business_id', businessId)
    .not('bank_net_change', 'is', null)
    .order('period_year', { ascending: true })
    .order('period_month', { ascending: true })

  if (error) {
    return NextResponse.json({
      error:   'bank_position_query_failed',
      detail:  error.message,
      hint:    error.message.includes('does not exist') ? 'Apply M069 (sql/M069-TRACKER-BANK-POSITION.sql).' : null,
    }, { status: 500 })
  }

  // Build cumulative series. All time held; we'll slice the recent window
  // for the tile but keep the full cumulative figure honest.
  let cumulative = 0
  const allMonths: MonthRow[] = []
  for (const r of (rows ?? [])) {
    cumulative += Number(r.bank_net_change ?? 0)
    allMonths.push({
      year:         Number((r as any).period_year),
      month:        Number((r as any).period_month),
      net_change:   Math.round(Number((r as any).bank_net_change ?? 0)),
      cumulative:   Math.round(cumulative),
      accounts:     ((r as any).bank_accounts ?? null) as any,
      is_provisional: !!((r as any).is_provisional),
    })
  }

  const recentSlice = allMonths.slice(-monthsWanted)

  // Summary
  const last = allMonths[allMonths.length - 1] ?? null
  const prev = allMonths[allMonths.length - 2] ?? null
  const last12 = allMonths.slice(-12)
  const last12Change = last12.reduce((s, m) => s + m.net_change, 0)

  // ── Option 3: ABSOLUTE current balance ──────────────────────────────
  // Fortnox's /3/vouchers doesn't return the Ingående Balans (year-opening)
  // voucher, so summing `bank_net_change` only gives net change since
  // tracking began — not the actual cash balance. Fetch the opening balance
  // for each known bank account via /3/accounts/{n}?financialyear={fyId}
  // and combine with the current fiscal year's net change for an absolute
  // figure.
  //
  // Soft-fails: if Fortnox is unreachable or the helper returns no balances
  // (e.g. customer hasn't connected Fortnox at all), the response still
  // includes the cumulative-since-tracking number. The tile decides which
  // to surface.
  const accountsSeen = new Set<number>()
  for (const m of allMonths) {
    if (m.accounts) {
      for (const a of Object.keys(m.accounts)) accountsSeen.add(Number(a))
    }
  }

  // Fallback: if monthly_metrics.bank_accounts hasn't been populated yet
  // (newly connected customer, aggregator hasn't run, etc.), enumerate
  // 1900-1989 (cash + bank + payment-provider settlement accounts) from
  // the cached Fortnox account chart. This guarantees the cash position
  // tile renders the day a customer connects Fortnox — instead of staying
  // empty until the aggregator catches up.
  if (accountsSeen.size === 0) {
    try {
      const { fetchAccountsList } = await import('@/lib/fortnox/api/accounts-list')
      const { getFreshFortnoxAccessToken } = await import('@/lib/fortnox/api/auth')
      const token = await getFreshFortnoxAccessToken(db, auth.orgId, businessId)
      if (token) {
        const al = await fetchAccountsList(db, auth.orgId, businessId, token)
        for (const a of Object.values(al.accounts)) {
          if (a.number >= 1900 && a.number <= 1989 &&
              (Math.abs(a.current_balance) > 0 || Math.abs(a.opening_balance) > 0)) {
            accountsSeen.add(a.number)
          }
        }
      }
    } catch { /* soft-fail — tile falls back to 'no bank data yet' */ }
  }

  let absoluteBalance: number | null = null
  let openingBalancesByAccount: Record<number, number> = {}
  let currentBalancesByAccount: Record<number, { description: string; current: number; opening: number }> = {}
  let fiscalYearFrom: string | null = null
  let fiscalYearTo: string | null = null
  let balanceFetchOk = false

  // Preferred path: read the per-account v2 balance cache directly from
  // Postgres. These rows are populated by historical fetchBankAccountBalances
  // calls and carry both opening + current balances per account.
  //
  // IMPORTANT: Fortnox's BULK /3/accounts?financialyear=X endpoint
  // returns BalanceCarriedForward = 0 for every account — only the
  // PER-ACCOUNT endpoint returns the live closing balance. So the
  // __accounts_list_fy*__ cache (used elsewhere for opening balances)
  // is NOT a valid source for current balances. Pre-2026-05-23 we
  // tried reading from it and got Σ current = 0 → tile rendered 0 kr
  // for Chicce despite 320 k SEK actually being present.
  //
  // The per-account v2 cache (__bank_balance_v2_{acc}_fy{fyId}__) IS
  // populated correctly. We read that directly, no token / refresh /
  // Fortnox network call needed for the dashboard tile.
  try {
    const { data: v2Rows } = await db
      .from('overhead_drilldown_cache')
      .select('category, payload, fetched_at')
      .eq('business_id', businessId)
      .eq('period_month', 0)
      .like('category', '__bank_balance_v2_%')
      .order('fetched_at', { ascending: false })

    let sum = 0
    let mostRecentFy = 0
    let mostRecentFyFrom: string | null = null
    let mostRecentFyTo: string | null = null
    for (const r of (v2Rows ?? [])) {
      const p = (r as any).payload
      if (!p || typeof p.account !== 'number') continue
      const accNum = p.account
      if (accNum < 1900 || accNum > 1989) continue
      // De-dupe: keep the freshest entry per account (rows are sorted
      // newest first, so first sighting wins).
      if (currentBalancesByAccount[accNum]) continue
      const opening = Number(p.opening_balance ?? 0)
      const current = Number(p.current_balance ?? 0)
      if (Math.abs(opening) < 0.5 && Math.abs(current) < 0.5) continue
      openingBalancesByAccount[accNum] = opening
      currentBalancesByAccount[accNum] = {
        description: String(p.description ?? ''),
        current,
        opening,
      }
      sum += current
      // Track the FY range of the freshest entry for the response
      const fyId = Number(p.fiscal_year_id ?? 0)
      if (fyId > mostRecentFy) {
        mostRecentFy = fyId
        mostRecentFyFrom = p.fiscal_year_from ?? null
        mostRecentFyTo   = p.fiscal_year_to   ?? null
      }
    }
    if (Object.keys(currentBalancesByAccount).length > 0) {
      absoluteBalance = Math.round(sum)
      balanceFetchOk  = true
      fiscalYearFrom  = mostRecentFyFrom
      fiscalYearTo    = mostRecentFyTo
    }
  } catch { /* fall through to the legacy live-fetch path below */ }

  if (!balanceFetchOk && accountsSeen.size > 0) {
    const result = await fetchBankAccountBalances(db, auth.orgId, businessId, Array.from(accountsSeen))
    if (Object.keys(result.balances).length > 0) {
      balanceFetchOk = true
      fiscalYearFrom = result.fiscal_year_from
      fiscalYearTo   = result.fiscal_year_to

      // Sum current balances directly — Fortnox's BalanceCarriedForward
      // IS the live closing balance through the latest booked voucher.
      // Do NOT add YTD net change on top: that's already inside the
      // current_balance figure (the earlier code did this and double-counted).
      let currentSum = 0
      for (const [acc, bal] of Object.entries(result.balances)) {
        const a = Number(acc)
        openingBalancesByAccount[a] = bal.opening_balance
        currentBalancesByAccount[a] = {
          description: bal.description,
          current:     bal.current_balance,
          opening:     bal.opening_balance,
        }
        currentSum += bal.current_balance
      }
      absoluteBalance = Math.round(currentSum)
    }
  }

  // ── VAT owed + supplier payables → "spendable" cash ──────────────────
  // The headline bank balance includes money that's already spoken for: VAT
  // collected from customers but not yet remitted to Skatteverket, and supplier
  // invoices booked but not yet paid. Subtract both for a true spendable figure.
  // Same per-account balance path as the bank accounts (15-min cached).
  // Sign convention (confirmed against Fortnox): assets/receivables positive,
  // liabilities negative. VAT net = Σ 2600-2659 (output credit − input debit);
  // a net credit (negative) is owed. Payables (2440-2449) credit = owed.
  let vatOwed: number | null = null
  let supplierPayables: number | null = null
  let payrollTaxOwed: number | null = null
  if (balanceFetchOk && absoluteBalance != null) {
    try {
      // VAT (2600-2659), supplier payables (2440-2449), and payroll taxes owed
      // to Skatteverket: employee withholding (2710), employer social fees
      // (2730/2731), and special payroll tax on pension (2514).
      const LIABILITY_ACCOUNTS = [
        2440, 2441, 2443, 2448,
        2610, 2611, 2612, 2613, 2620, 2621, 2630, 2631, 2640, 2641, 2645, 2650,
        2514, 2710, 2730, 2731,
      ]
      const liab = await fetchBankAccountBalances(db, auth.orgId, businessId, LIABILITY_ACCOUNTS)
      let vatNet = 0, pay = 0, payroll = 0, sawVat = false, sawPay = false, sawPayroll = false
      for (const [acc, b] of Object.entries(liab.balances)) {
        const n = Number(acc)
        const cur = Number((b as any).current_balance ?? 0)
        if (n >= 2600 && n <= 2659)                      { vatNet += cur; sawVat = true }
        else if (n >= 2440 && n <= 2449)                 { pay += -cur;   sawPay = true }
        else if (n === 2514 || (n >= 2710 && n <= 2739)) { payroll += -cur; sawPayroll = true }
      }
      if (sawVat)     vatOwed         = vatNet < 0 ? Math.round(-vatNet) : 0   // net credit = owed; net debit = refund due
      if (sawPay)     supplierPayables = Math.max(0, Math.round(pay))
      if (sawPayroll) payrollTaxOwed   = Math.max(0, Math.round(payroll))
    } catch { /* soft-fail — tile just omits the breakdown */ }
  }
  const spendableCash = absoluteBalance != null
    ? Math.round(absoluteBalance - (vatOwed ?? 0) - (supplierPayables ?? 0) - (payrollTaxOwed ?? 0))
    : null

  // ── Bookkeeping-lag detection ────────────────────────────────────────
  // Cross-reference recent bank activity against POS revenue presence:
  // a credits-only month on the primary checking account during a
  // demonstrably operating period = deposits not yet booked.
  let lagSignal = null as ReturnType<typeof detectBookkeepingLag> | null
  if (allMonths.length > 0) {
    // Look back 6 months for the signal — enough to spot a 2-3 month lag
    // without picking up old structural gaps.
    const recentMonthsForLag = allMonths.slice(-6)
    const periodFilter = recentMonthsForLag.map(m => `(year.eq.${m.year},month.eq.${m.month})`).join(',')
    const { data: mmRows } = await db
      .from('monthly_metrics')
      .select('year, month, revenue')
      .eq('business_id', businessId)
      .or(recentMonthsForLag.map(m => `and(year.eq.${m.year},month.eq.${m.month})`).join(','))
    const revenueByPeriod = new Map<string, number>()
    for (const r of (mmRows ?? [])) {
      revenueByPeriod.set(`${(r as any).year}-${(r as any).month}`, Number((r as any).revenue ?? 0))
    }
    lagSignal = detectBookkeepingLag({
      rows: recentMonthsForLag.map(m => ({
        period_year:   m.year,
        period_month:  m.month,
        bank_accounts: (m.accounts as any) ?? null,
        had_revenue:   (revenueByPeriod.get(`${m.year}-${m.month}`) ?? 0) > 0,
      })).reverse(),  // newest first for the helper's loop
    })
  }

  return NextResponse.json({
    business_id: businessId,
    currency:    biz.currency ?? 'SEK',
    monthly:     recentSlice,
    summary: {
      current_position_since_tracking: Math.round(cumulative),
      this_month_change: last?.net_change ?? null,
      last_month_change: prev?.net_change ?? null,
      last_12m_change:   last12.length > 0 ? Math.round(last12Change) : null,
      months_with_data:  allMonths.length,

      // Absolute balance — sum of Fortnox's `BalanceCarriedForward` across
      // bank accounts. Reflects what Fortnox has BOOKED through the latest
      // voucher, NOT necessarily the live bank balance: if the customer's
      // accountant is behind on entering bank movements, this lags reality.
      // Null = Fortnox's /3/accounts endpoint unreachable (then UI falls
      // back to "since tracking began" net change).
      absolute_balance:           absoluteBalance,
      // What's already committed out of that balance + what's actually spendable.
      vat_owed:                   vatOwed,
      supplier_payables:          supplierPayables,
      payroll_tax_owed:           payrollTaxOwed,
      spendable_cash:             spendableCash,
      opening_balance_by_account: balanceFetchOk ? openingBalancesByAccount : null,
      current_balance_by_account: balanceFetchOk ? currentBalancesByAccount : null,
      fiscal_year_from:           fiscalYearFrom,
      fiscal_year_to:             fiscalYearTo,
    },
    coverage: {
      earliest_period:       allMonths[0] ? `${allMonths[0].year}-${String(allMonths[0].month).padStart(2,'0')}` : null,
      latest_period:         last ? `${last.year}-${String(last.month).padStart(2,'0')}` : null,
      is_provisional_latest: last?.is_provisional ?? false,
    },
    bookkeeping_lag: lagSignal,
  }, { headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=120' } })
}
