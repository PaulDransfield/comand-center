// lib/fortnox/api/account-balance.ts
//
// Phase 5 (option 3) — fetch the Ingående Balans (opening balance) for a
// given BAS account in a given fiscal year. Combined with the per-period
// `bank_net_change` rollups we already store, this gives us the absolute
// current cash balance — not just "net change since tracking began".
//
// Fortnox's /3/vouchers endpoint does NOT return the IB voucher series (the
// special year-opening booking dated Jan 1). So summing voucher rows misses
// the year-start carryover. The single-account endpoint exposes it via the
// `BalanceCarriedForward` field on the Account response when queried with
// `financialyear={fyId}`.
//
// Endpoint: GET /3/accounts/{number}?financialyear={fyId}
// Returns: { Account: { Number, Description, BalanceCarriedForward, ... } }
//
// BalanceCarriedForward = opening balance at the start of the queried fiscal
// year (i.e. closing balance of prior year). For accounts 1xxx (assets):
//   positive = the customer started the year with cash in this account
//   negative = the customer started the year overdrawn (rare for cash accounts)
//
// Caching: balances are CACHED for 24h via the same `overhead_drilldown_cache`
// table the other Fortnox proxies use. Opening balance for the current fiscal
// year is fixed once the prior year closes — refreshing every 24h is plenty.

import { fetchFinancialYears } from './financial-years'
import { getFreshFortnoxAccessToken } from './auth'

const FORTNOX_API   = 'https://api.fortnox.se/3'
const CACHE_TTL_MS  = 24 * 60 * 60 * 1000   // 24h — opening balance for current FY is stable

export interface AccountBalance {
  account:                  number
  description:              string
  fiscal_year_id:           number
  fiscal_year_from:         string
  fiscal_year_to:           string
  opening_balance:          number          // BalanceCarriedForward
  fetched_at:               string
}

export interface BankBalancesResult {
  /** Keyed by account number. Missing keys = account not found in Fortnox
   *  (e.g. customer doesn't use account 1910 / 1930). */
  balances: Record<number, AccountBalance>
  /** Fiscal year ID used for the lookup (the year containing today's date). */
  fiscal_year_id:    number
  fiscal_year_from:  string
  fiscal_year_to:    string
  /** Number of fresh Fortnox API calls (excluding cache hits). */
  fortnox_calls:     number
  duration_ms:       number
}

/**
 * Fetch the opening balances for the given BAS accounts in the fiscal year
 * containing today's date. Uses 24h cache via overhead_drilldown_cache
 * (synthetic key: period_year=fyId, period_month=0, category=`__bank_opening__${account}__`).
 *
 * Accounts not found in Fortnox (e.g. customer doesn't use 1910) simply
 * don't appear in `balances`. Caller decides what to do.
 *
 * Soft-fails: if token refresh fails OR Fortnox returns 5xx, returns an
 * empty balances map with `fortnox_calls=0`. Caller can fall back to the
 * "since tracking began" estimate.
 */
export async function fetchBankAccountBalances(
  db:         any,
  orgId:      string,
  businessId: string,
  accounts:   number[],
): Promise<BankBalancesResult> {
  const started = Date.now()
  const empty: BankBalancesResult = {
    balances:         {},
    fiscal_year_id:   0,
    fiscal_year_from: '',
    fiscal_year_to:   '',
    fortnox_calls:    0,
    duration_ms:      0,
  }
  if (accounts.length === 0) return { ...empty, duration_ms: Date.now() - started }

  // 1. Token
  let accessToken: string | null
  try {
    accessToken = await getFreshFortnoxAccessToken(db, orgId, businessId)
  } catch {
    return { ...empty, duration_ms: Date.now() - started }
  }
  if (!accessToken) return { ...empty, duration_ms: Date.now() - started }

  // 2. Find current fiscal year
  let years
  try {
    ({ years } = await fetchFinancialYears(accessToken))
  } catch {
    return { ...empty, duration_ms: Date.now() - started }
  }
  if (!years || years.length === 0) return { ...empty, duration_ms: Date.now() - started }

  const todayIso = new Date().toISOString().slice(0, 10)
  const currentYear = years.find(y => y.FromDate <= todayIso && y.ToDate >= todayIso)
                   ?? years[0]   // fallback: most recent year
  const fyId = currentYear.Id

  // 3. For each account, cache lookup → Fortnox if cold
  const balances: Record<number, AccountBalance> = {}
  let calls = 0

  for (const account of accounts) {
    const cacheCategory = `__bank_opening_${account}_fy${fyId}__`
    const cacheKey = { business_id: businessId, period_year: fyId, period_month: 0, category: cacheCategory }

    // Cache check
    try {
      const { data: cached } = await db
        .from('overhead_drilldown_cache')
        .select('payload, fetched_at')
        .eq('business_id', cacheKey.business_id)
        .eq('period_year', cacheKey.period_year)
        .eq('period_month', cacheKey.period_month)
        .eq('category', cacheKey.category)
        .maybeSingle()
      if (cached?.fetched_at && (Date.now() - new Date(cached.fetched_at).getTime()) < CACHE_TTL_MS) {
        const p = cached.payload as AccountBalance
        if (p) { balances[account] = p; continue }
      }
    } catch { /* cache miss / table issue → fall through to fresh fetch */ }

    // Fresh Fortnox fetch
    try {
      const res = await fetch(`${FORTNOX_API}/accounts/${account}?financialyear=${fyId}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept':        'application/json',
        },
      })
      calls++
      if (res.status === 404) continue   // account not used by this customer
      if (!res.ok) continue              // 5xx etc — skip silently, soft-fail
      const body: any = await res.json()
      const acc = body?.Account
      if (!acc) continue

      const openingBalance = Number(acc.BalanceCarriedForward ?? 0)
      if (!Number.isFinite(openingBalance)) continue

      const balance: AccountBalance = {
        account,
        description:      String(acc.Description ?? ''),
        fiscal_year_id:   fyId,
        fiscal_year_from: currentYear.FromDate,
        fiscal_year_to:   currentYear.ToDate,
        opening_balance:  Math.round(openingBalance),
        fetched_at:       new Date().toISOString(),
      }
      balances[account] = balance

      // Persist to cache
      try {
        await db.from('overhead_drilldown_cache').upsert({
          business_id:  cacheKey.business_id,
          period_year:  cacheKey.period_year,
          period_month: cacheKey.period_month,
          category:     cacheKey.category,
          payload:      balance,
          fetched_at:   new Date().toISOString(),
        }, { onConflict: 'business_id,period_year,period_month,category' })
      } catch { /* cache write best-effort */ }
    } catch {
      // Network / parse error — skip account, soft-fail
      continue
    }
  }

  return {
    balances,
    fiscal_year_id:   fyId,
    fiscal_year_from: currentYear.FromDate,
    fiscal_year_to:   currentYear.ToDate,
    fortnox_calls:    calls,
    duration_ms:      Date.now() - started,
  }
}
