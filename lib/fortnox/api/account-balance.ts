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
// Two fields come from the same API call but have different volatility:
//   - opening_balance (BalanceBroughtForward): year-start, stable
//   - current_balance (BalanceCarriedForward): live, updates with every voucher
// Cache TTL bounded by the volatile one. 15 min is a reasonable balance
// between freshness and Fortnox rate-limit kindness.
const CACHE_TTL_MS  = 15 * 60 * 1000

export interface AccountBalance {
  account:                  number
  description:              string
  fiscal_year_id:           number
  fiscal_year_from:         string
  fiscal_year_to:           string
  /** Ingående balans (IB) — opening balance at the start of this fiscal year,
   *  carried in from prior year close. Fortnox field: BalanceBroughtForward. */
  opening_balance:          number
  /** Utgående balans (UB) — current closing balance, updates with every
   *  voucher booked. THIS is the live "what's in the account now per Fortnox"
   *  number. Fortnox field: BalanceCarriedForward. */
  current_balance:          number
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

  // 3. Bulk cache lookup — single SELECT with .in() instead of N round-trips.
  //    Old code did one SQL hit per account inside the per-account loop;
  //    for ~30 accounts that's ~3 s of latency before any Fortnox call.
  const balances: Record<number, AccountBalance> = {}
  const cacheCategoryFor = (acc: number) => `__bank_balance_v2_${acc}_fy${fyId}__`
  const categories = accounts.map(cacheCategoryFor)

  const freshCutoff = Date.now() - CACHE_TTL_MS
  const cacheMissAccounts: number[] = []
  try {
    const { data: cachedRows } = await db
      .from('overhead_drilldown_cache')
      .select('category, payload, fetched_at')
      .eq('business_id', businessId)
      .eq('period_year', fyId)
      .eq('period_month', 0)
      .in('category', categories)

    const byCategory = new Map<string, { payload: any; fetched_at: string }>()
    for (const row of (cachedRows ?? [])) {
      byCategory.set(row.category as string, row as any)
    }
    for (const acc of accounts) {
      const hit = byCategory.get(cacheCategoryFor(acc))
      if (hit?.fetched_at && new Date(hit.fetched_at).getTime() >= freshCutoff && hit.payload) {
        balances[acc] = hit.payload as AccountBalance
      } else {
        cacheMissAccounts.push(acc)
      }
    }
  } catch {
    // If the bulk cache lookup itself failed, just refetch everything.
    cacheMissAccounts.push(...accounts)
  }

  // 4. Fortnox fetch in parallel chunks for cache-miss accounts.
  //    Concurrency cap of 5 — well under Fortnox's 250-per-5-min cap and
  //    avoids burst-throttling. Sequential pre-2026-05-23 took ~6 s for
  //    30 accounts; parallel-5 is ~1.5 s.
  let calls = 0
  const PARALLEL = 5
  const writeBatch: any[] = []
  const fetchOne = async (account: number) => {
    try {
      const res = await fetch(`${FORTNOX_API}/accounts/${account}?financialyear=${fyId}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept':        'application/json',
        },
      })
      calls++
      if (res.status === 404) return
      if (!res.ok) return
      const body: any = await res.json()
      const acc = body?.Account
      if (!acc) return

      // Field semantics verified empirically 2026-05-11:
      //   BalanceBroughtForward = opening (IB)
      //   BalanceCarriedForward = current closing (UB)
      const openingBalance = Number(acc.BalanceBroughtForward ?? 0)
      const currentBalance = Number(acc.BalanceCarriedForward ?? 0)
      if (!Number.isFinite(openingBalance) || !Number.isFinite(currentBalance)) return

      const balance: AccountBalance = {
        account,
        description:      String(acc.Description ?? ''),
        fiscal_year_id:   fyId,
        fiscal_year_from: currentYear.FromDate,
        fiscal_year_to:   currentYear.ToDate,
        opening_balance:  Math.round(openingBalance),
        current_balance:  Math.round(currentBalance),
        fetched_at:       new Date().toISOString(),
      }
      balances[account] = balance
      writeBatch.push({
        business_id:  businessId,
        period_year:  fyId,
        period_month: 0,
        category:     cacheCategoryFor(account),
        payload:      balance,
        fetched_at:   balance.fetched_at,
      })
    } catch { /* network error → silent skip per soft-fail contract */ }
  }
  for (let i = 0; i < cacheMissAccounts.length; i += PARALLEL) {
    const chunk = cacheMissAccounts.slice(i, i + PARALLEL)
    await Promise.all(chunk.map(fetchOne))
  }

  // 5. Bulk upsert the freshly-fetched payloads in one round-trip.
  if (writeBatch.length > 0) {
    try {
      await db.from('overhead_drilldown_cache').upsert(writeBatch, {
        onConflict: 'business_id,period_year,period_month,category',
      })
    } catch { /* cache write best-effort */ }
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
