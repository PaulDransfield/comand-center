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

  let absoluteBalance: number | null = null
  let openingBalancesByAccount: Record<number, number> = {}
  let currentBalancesByAccount: Record<number, { description: string; current: number; opening: number }> = {}
  let fiscalYearFrom: string | null = null
  let fiscalYearTo: string | null = null
  let balanceFetchOk = false

  if (accountsSeen.size > 0) {
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
  }, { headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=120' } })
}
