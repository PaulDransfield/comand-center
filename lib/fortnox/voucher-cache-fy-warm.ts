// lib/fortnox/voucher-cache-fy-warm.ts
//
// Pre-warm the M080 Fortnox voucher cache for a business's CURRENT
// fiscal year. Idempotent + incremental: each call only fetches the
// months that aren't already cached. Cold start (empty cache) takes
// minutes; warm calls are no-ops.
//
// Use cases:
//   1. Customer onboarding hook — fires after Fortnox OAuth completes
//      so the first balance sheet load is instant.
//   2. Daily catch-up cron — opportunistically backfills missing FY
//      months for existing customers (covers cache drift / new fiscal
//      years rolling over).
//   3. Admin one-off — same helper drives /api/admin/voucher-cache/warm.
//
// Why current FY (not all years): the balance sheet needs FY-start IB
// to compute closing balances; for any prior FY we'd need to walk
// further back. Current-FY-only covers the 95 % case (active period)
// and stops the runaway cost on multi-year customers.

import { getCachedVouchersForRange } from './voucher-cache'
import { getFreshFortnoxAccessToken } from './api/auth'
import { fetchFinancialYears } from './api/financial-years'

export interface FyWarmOptions {
  db:                any
  orgId:             string
  businessId:        string
  /** Wall-clock cap. The helper stops starting new month-fetches once
   *  this budget is exhausted and returns what it managed. Lets the
   *  daily cron bound per-customer work so one slow customer can't
   *  starve the others. Default 240 s (4 min). */
  budgetMs?:         number
  /** If true, refresh EVERY month in the FY even if cached. Useful for
   *  a customer-side cache refresh button. Default false. */
  refreshAll?:       boolean
  /** Optional logger — typically `console.log` or structured log fn. */
  log?:              (msg: string, fields?: Record<string, unknown>) => void
}

export interface FyWarmResult {
  ok:                boolean
  reason?:           string
  business_id:       string
  fiscal_year_from?: string
  fiscal_year_to?:   string
  months_in_fy:      number
  months_already_cached: number
  months_warmed:     number
  months_skipped_budget: number
  total_vouchers_after: number
  duration_ms:       number
}

export async function warmFiscalYearMissing(opts: FyWarmOptions): Promise<FyWarmResult> {
  const t0 = Date.now()
  const budget = Math.max(30_000, Math.min(opts.budgetMs ?? 240_000, 750_000))
  const log = opts.log ?? (() => {})

  const blankResult: FyWarmResult = {
    ok:                    false,
    business_id:           opts.businessId,
    months_in_fy:          0,
    months_already_cached: 0,
    months_warmed:         0,
    months_skipped_budget: 0,
    total_vouchers_after:  0,
    duration_ms:           0,
  }

  // 1. Resolve fresh token.
  let accessToken: string | null
  try {
    accessToken = await getFreshFortnoxAccessToken(opts.db, opts.orgId, opts.businessId)
  } catch (e: any) {
    return { ...blankResult, reason: `token_failed: ${e?.message ?? e}`, duration_ms: Date.now() - t0 }
  }
  if (!accessToken) return { ...blankResult, reason: 'no_token', duration_ms: Date.now() - t0 }

  // 2. Discover the customer's current FY.
  let years
  try {
    ({ years } = await fetchFinancialYears(accessToken))
  } catch (e: any) {
    return { ...blankResult, reason: `fy_failed: ${e?.message ?? e}`, duration_ms: Date.now() - t0 }
  }
  if (!years || years.length === 0) {
    return { ...blankResult, reason: 'no_fy', duration_ms: Date.now() - t0 }
  }

  const todayIso = new Date().toISOString().slice(0, 10)
  const currentFy = years.find(y => y.FromDate <= todayIso && y.ToDate >= todayIso) ?? years[0]

  // 3. Enumerate every (year, month) in the FY through today (no point
  //    pre-warming future months — they're empty).
  const fyFrom = currentFy.FromDate
  const fyTo   = currentFy.ToDate < todayIso ? currentFy.ToDate : todayIso
  const months = monthsInRange(fyFrom, fyTo)

  // 4. Find which months are already cached.
  const cachedMonths = new Set<string>()
  if (!opts.refreshAll) {
    for (const { y, m } of months) {
      const { count } = await opts.db
        .from('fortnox_vouchers_cache')
        .select('*', { count: 'exact', head: true })
        .eq('business_id', opts.businessId)
        .eq('period_year',  y)
        .eq('period_month', m)
      if ((count ?? 0) > 0) cachedMonths.add(`${y}-${m}`)
    }
  }

  const todoMonths = months.filter(({ y, m }) => !cachedMonths.has(`${y}-${m}`))
  log('voucher-cache-fy-warm.start', {
    business_id:       opts.businessId,
    fy:                `${fyFrom} → ${fyTo}`,
    months_in_fy:      months.length,
    months_to_warm:    todoMonths.length,
    refresh_all:       opts.refreshAll === true,
  })

  // 5. Warm missing months in sequence, bounded by the time budget.
  //    We do months one-at-a-time rather than parallel to stay safe with
  //    Fortnox's 250-per-5-min throttle — each /vouchers month fetch
  //    pages through ~300 vouchers + per-voucher detail calls.
  let warmedCount = 0
  let skippedBudgetCount = 0
  for (const { y, m } of todoMonths) {
    const elapsed = Date.now() - t0
    if (elapsed >= budget) {
      skippedBudgetCount++
      continue
    }
    const monthFrom = `${y}-${String(m).padStart(2, '0')}-01`
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
    const monthTo   = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    try {
      const r = await getCachedVouchersForRange({
        db:              opts.db,
        orgId:           opts.orgId,
        businessId:      opts.businessId,
        fromDate:        monthFrom,
        toDate:          monthTo,
        refreshCurrent:  opts.refreshAll === true,
      })
      warmedCount++
      log('voucher-cache-fy-warm.month_ok', {
        business_id: opts.businessId,
        year:        y,
        month:       m,
        vouchers:    r.vouchers.length,
        duration_ms: r.duration_ms,
      })
    } catch (e: any) {
      log('voucher-cache-fy-warm.month_failed', {
        business_id: opts.businessId,
        year:        y,
        month:       m,
        error:       String(e?.message ?? e),
      })
      // Continue to next month — partial progress is still useful.
    }
  }

  // 6. Final cache stats.
  let totalAfter = 0
  for (const { y, m } of months) {
    const { count } = await opts.db
      .from('fortnox_vouchers_cache')
      .select('*', { count: 'exact', head: true })
      .eq('business_id', opts.businessId)
      .eq('period_year',  y)
      .eq('period_month', m)
    totalAfter += count ?? 0
  }

  return {
    ok:                    true,
    business_id:           opts.businessId,
    fiscal_year_from:      fyFrom,
    fiscal_year_to:        currentFy.ToDate,
    months_in_fy:          months.length,
    months_already_cached: months.length - todoMonths.length,
    months_warmed:         warmedCount,
    months_skipped_budget: skippedBudgetCount,
    total_vouchers_after:  totalAfter,
    duration_ms:           Date.now() - t0,
  }
}

function monthsInRange(fromDate: string, toDate: string): Array<{ y: number; m: number }> {
  const out: Array<{ y: number; m: number }> = []
  const start = new Date(fromDate + 'T00:00:00Z')
  const end   = new Date(toDate   + 'T00:00:00Z')
  let y = start.getUTCFullYear()
  let m = start.getUTCMonth() + 1
  const endY = end.getUTCFullYear()
  const endM = end.getUTCMonth() + 1
  while (y < endY || (y === endY && m <= endM)) {
    out.push({ y, m })
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}
