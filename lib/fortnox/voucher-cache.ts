// lib/fortnox/voucher-cache.ts
//
// Cache-aware Fortnox voucher fetcher. Wraps fetchVouchersForRange()
// from lib/fortnox/api/vouchers with a Postgres read-through cache.
//
// First call for a (business, year, month) tuple is slow (the underlying
// Fortnox API trip — 90-120s for a busy restaurant month). Every
// subsequent call is < 50 ms. Closed periods stay cached indefinitely;
// current + previous month get auto-refreshed by the daily cron at
// /api/cron/voucher-cache-refresh (separate commit).
//
// Contract:
//   getCachedVouchersForRange({ db, orgId, businessId, fromDate, toDate, refreshCurrent? })
//     → FortnoxVoucher[]  ← same shape as fetchVouchersForRange().vouchers
//
// The caller doesn't need to know if data came from Fortnox or the
// cache. Force-refresh (e.g. after the owner edits a voucher in
// Fortnox web and wants to see the change immediately) by passing
// `refreshCurrent: true` which deletes the cache rows for the range
// before re-fetching.

import { fetchVouchersForRange, type FortnoxVoucher } from '@/lib/fortnox/api/vouchers'

export interface CachedVoucherFetchOptions {
  db:          any
  orgId:       string
  businessId:  string
  fromDate:    string                          // YYYY-MM-DD inclusive
  toDate:      string                          // YYYY-MM-DD inclusive
  /** Force a Fortnox re-fetch even when cache has rows for the range. */
  refreshCurrent?: boolean
}

export interface CachedVoucherFetchResult {
  vouchers:     FortnoxVoucher[]
  cache_hits:   number                         // how many vouchers came from cache
  cache_misses: number                         // how many fetched fresh from Fortnox
  duration_ms:  number
  source:       'cache' | 'fortnox' | 'mixed'
}

/**
 * Read-through cache. The cache key is (business_id, period_year,
 * period_month) — if any voucher exists for a given month in the range,
 * we trust that we have the full month. This keeps the logic simple
 * and matches the actual usage pattern (revisor surfaces always read a
 * whole month at a time).
 *
 * Note: this means if a month was partially cached due to a previous
 * fetch interruption, we'd incorrectly return partial data. Defensive
 * mitigation: the daily refresh cron always re-writes whole months;
 * and we never delete partial sets. In practice fetches either
 * complete or fail-and-retry without writing.
 */
export async function getCachedVouchersForRange(
  opts: CachedVoucherFetchOptions,
): Promise<CachedVoucherFetchResult> {
  const t0 = Date.now()

  // 1. Determine which (year, month) tuples the range covers.
  const months = monthsInRange(opts.fromDate, opts.toDate)

  // 2. Optional force-refresh: drop cache for the range first.
  if (opts.refreshCurrent) {
    for (const { y, m } of months) {
      await opts.db
        .from('fortnox_vouchers_cache')
        .delete()
        .eq('business_id', opts.businessId)
        .eq('period_year',  y)
        .eq('period_month', m)
    }
  }

  // 3. Read cache for the range, page-aware (Supabase 1000-row cap).
  const cached = await readCachedMonths(opts.db, opts.businessId, months)
  const cachedMonthsKeys = new Set(
    cached.map(v => `${dateToYM(v.TransactionDate).y}-${dateToYM(v.TransactionDate).m}`)
  )
  const missingMonths = months.filter(({ y, m }) => !cachedMonthsKeys.has(`${y}-${m}`))

  // 4. Determine cache hit/miss + decide whether to call Fortnox.
  const cacheHits = cached.length
  let fresh: FortnoxVoucher[] = []
  let cacheMisses = 0

  if (missingMonths.length > 0) {
    // Fortnox call: fetch for the union of missing months (single API
    // call with the widest range is more efficient than N small calls).
    const missingFrom = isoFirstOfMonth(missingMonths[0])
    const missingTo   = isoLastOfMonth(missingMonths[missingMonths.length - 1])
    const fetchResult = await fetchVouchersForRange({
      db:         opts.db,
      orgId:      opts.orgId,
      businessId: opts.businessId,
      fromDate:   missingFrom,
      toDate:     missingTo,
    })
    fresh = fetchResult.vouchers
    cacheMisses = fresh.length

    // 5. Write the fresh vouchers to the cache. Upsert by the unique
    // constraint so a re-fetch overwrites (e.g. owner edits voucher in
    // Fortnox web → daily cron pulls again → cache row replaced).
    if (fresh.length > 0) {
      const cacheRows = fresh.map(v => {
        const ym  = dateToYM(v.TransactionDate)
        const rows = (v.VoucherRows ?? []).filter(r => !r.Removed)
        const debit  = rows.reduce((s, r) => s + (Number(r.Debit)  || 0), 0)
        const credit = rows.reduce((s, r) => s + (Number(r.Credit) || 0), 0)
        return {
          org_id:           opts.orgId,
          business_id:      opts.businessId,
          voucher_series:   v.VoucherSeries,
          voucher_number:   Number(v.VoucherNumber),
          transaction_date: v.TransactionDate,
          description:      v.Description ?? null,
          reference_number: (v as any).ReferenceNumber ?? null,
          reference_type:   (v as any).ReferenceType ?? null,
          comments:         v.Comments ?? null,
          fortnox_year:     Number(v.Year) || null,
          rows:             rows,
          rows_count:       rows.length,
          debit_total:      debit,
          credit_total:     credit,
          fetched_at:       new Date().toISOString(),
          period_year:      ym.y,
          period_month:     ym.m,
        }
      })
      // Batch upsert; Supabase handles arrays of up to ~1000 rows fine.
      for (let i = 0; i < cacheRows.length; i += 500) {
        const slice = cacheRows.slice(i, i + 500)
        await opts.db
          .from('fortnox_vouchers_cache')
          .upsert(slice, { onConflict: 'business_id,period_year,voucher_series,voucher_number' })
      }
    }
  }

  // 6. Merge + filter to the requested date range (cache may include
  //    rows from elsewhere in the month; we trim to the caller's
  //    explicit fromDate/toDate).
  const all = [...cached, ...fresh].filter(v => {
    const d = String(v.TransactionDate ?? '').slice(0, 10)
    return d >= opts.fromDate && d <= opts.toDate
  })

  return {
    vouchers:     all,
    cache_hits:   cacheHits,
    cache_misses: cacheMisses,
    duration_ms:  Date.now() - t0,
    source:       missingMonths.length === 0 ? 'cache' : cacheHits > 0 ? 'mixed' : 'fortnox',
  }
}

// ─────────────────────────────────────────────────────────────────
// Cache reader — pages past Supabase's 1000-row cap
// ─────────────────────────────────────────────────────────────────

async function readCachedMonths(
  db: any,
  businessId: string,
  months: Array<{ y: number; m: number }>,
): Promise<FortnoxVoucher[]> {
  if (months.length === 0) return []
  const out: FortnoxVoucher[] = []
  const PAGE = 1000
  // We page per-month so the unique-month detection works correctly.
  // Within a month we still page if the count > 1000.
  for (const { y, m } of months) {
    let from = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { data } = await db
        .from('fortnox_vouchers_cache')
        .select('voucher_series, voucher_number, transaction_date, description, comments, reference_number, reference_type, fortnox_year, rows')
        .eq('business_id', businessId)
        .eq('period_year', y)
        .eq('period_month', m)
        .order('transaction_date', { ascending: true })
        .range(from, from + PAGE - 1)
      const rows = (data ?? []) as any[]
      if (rows.length === 0) break
      for (const r of rows) {
        out.push({
          Url:                  '',
          VoucherSeries:        r.voucher_series,
          VoucherNumber:        Number(r.voucher_number),
          Year:                 Number(r.fortnox_year ?? 0),
          TransactionDate:      typeof r.transaction_date === 'string' ? r.transaction_date : new Date(r.transaction_date).toISOString().slice(0, 10),
          Description:          r.description ?? undefined,
          ReferenceNumber:      r.reference_number ?? undefined,
          ReferenceType:        r.reference_type ?? undefined,
          Comments:             r.comments ?? undefined,
          VoucherRows:          Array.isArray(r.rows) ? r.rows : [],
        } as FortnoxVoucher)
      }
      if (rows.length < PAGE) break
      from += PAGE
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────────

function monthsInRange(fromDate: string, toDate: string): Array<{ y: number; m: number }> {
  const out: Array<{ y: number; m: number }> = []
  const start = new Date(fromDate + 'T00:00:00Z')
  const end   = new Date(toDate + 'T00:00:00Z')
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

function dateToYM(iso: string): { y: number; m: number } {
  const s = String(iso ?? '').slice(0, 10)
  return { y: parseInt(s.slice(0, 4), 10), m: parseInt(s.slice(5, 7), 10) }
}

function isoFirstOfMonth({ y, m }: { y: number; m: number }): string {
  return `${y}-${String(m).padStart(2, '0')}-01`
}

function isoLastOfMonth({ y, m }: { y: number; m: number }): string {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`
}
