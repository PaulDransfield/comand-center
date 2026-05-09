// app/api/admin/fortnox/diagnose-vouchers/route.ts
//
// Admin diagnostic — fetches one month of vouchers via the Fortnox API,
// runs them through the translator + projectRollup, and returns:
//   - voucher count
//   - account-bucket totals (raw debit/credit per BAS range, before sign convention)
//   - translated rollup (revenue / food_cost / staff_cost / etc.)
//   - top 20 accounts by absolute net amount
//   - optional comparison against tracker_data's existing PDF baseline for the same month
//
// Use this BEFORE re-running the API backfill on a customer to verify the
// translator produces numbers that match the PDF baseline.
//
// Inputs (POST JSON body):
//   - business_id: required
//   - year: required (e.g. 2026)
//   - month: required (1-12)
//
// Returns the full analysis as JSON. No DB writes.

import { NextRequest, NextResponse }   from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { requireAdmin }                from '@/lib/admin/require-admin'
import { createAdminClient }           from '@/lib/supabase/server'
import { fetchVouchersForRange }       from '@/lib/fortnox/api/vouchers'
import { translateVouchersToPeriods }  from '@/lib/fortnox/api/voucher-to-aggregator'
import { projectRollup }               from '@/lib/finance/projectRollup'

export const runtime         = 'nodejs'
export const dynamic         = 'force-dynamic'
export const preferredRegion = 'fra1'   // EU; Supabase is Frankfurt
// Single-month fetch is well under 300s for any restaurant we'll see
// (Vero's busiest month is ~280 vouchers).
export const maxDuration     = 300

export async function POST(req: NextRequest) {
  noStore()

  const body = await req.json().catch(() => ({} as any))
  const businessId: string | undefined = body?.business_id
  const year:       number | undefined = Number(body?.year)
  const month:      number | undefined = Number(body?.month)

  if (!businessId) {
    return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  }
  if (!Number.isFinite(year)  || year! < 2020 || year! > 2099) {
    return NextResponse.json({ error: 'year required (2020-2099)' }, { status: 400 })
  }
  if (!Number.isFinite(month) || month! < 1 || month! > 12) {
    return NextResponse.json({ error: 'month required (1-12)' }, { status: 400 })
  }

  const db = createAdminClient()

  // Look up the integration's org so requireAdmin can verify properly.
  const { data: integ } = await db
    .from('integrations')
    .select('id, org_id, business_id')
    .eq('business_id', businessId)
    .eq('provider', 'fortnox')
    .maybeSingle()

  if (!integ) {
    return NextResponse.json({ error: 'No Fortnox integration found for that business' }, { status: 404 })
  }

  const guard = await requireAdmin(req, { orgId: integ.org_id, businessId })
  if (!('ok' in guard)) return guard

  // Date range: full calendar month.
  const lastDay = new Date(year!, month!, 0).getDate()   // month is 1-indexed; Date(year, month, 0) = last day of month
  const fromDate = `${year}-${String(month).padStart(2, '0')}-01`
  const toDate   = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

  // ── Fetch vouchers ──────────────────────────────────────────────────────
  const startedAt = Date.now()
  let fetchResult
  try {
    fetchResult = await fetchVouchersForRange({
      db,
      orgId:       integ.org_id,
      businessId:  integ.business_id ?? undefined,
      fromDate,
      toDate,
    })
  } catch (err: any) {
    return NextResponse.json({
      error: `Voucher fetch failed: ${err?.message ?? String(err)}`,
      cause: err?.cause?.message ?? null,
    }, { status: 502 })
  }

  // ── Translate ──────────────────────────────────────────────────────────
  const translation = translateVouchersToPeriods(fetchResult.vouchers)
  const period = translation.periods.find(p => p.year === year && p.month === month)

  if (!period) {
    return NextResponse.json({
      ok:               false,
      message:          `No vouchers translated for ${year}-${month}`,
      voucher_count:    fetchResult.vouchers.length,
      list_requests:    fetchResult.listRequests,
      detail_requests:  fetchResult.detailRequests,
      skipped:          translation.skipped,
      periods_in_translation: translation.periods.map(p => `${p.year}-${p.month}`),
    })
  }

  const projected = projectRollup(period.rollup, period.lines)

  // ── Account-bucket histogram (raw, before sign convention) ─────────────
  const byAccount = new Map<number, { debit: number; credit: number; rows: number }>()
  for (const v of fetchResult.vouchers) {
    if (!v.TransactionDate?.startsWith(fromDate.slice(0, 7))) continue
    for (const r of v.VoucherRows ?? []) {
      if (r.Removed) continue
      const acct = Number(r.Account)
      if (!Number.isFinite(acct)) continue
      const cur = byAccount.get(acct) ?? { debit: 0, credit: 0, rows: 0 }
      cur.debit  += Number(r.Debit  ?? 0)
      cur.credit += Number(r.Credit ?? 0)
      cur.rows   += 1
      byAccount.set(acct, cur)
    }
  }

  const acctRows = Array.from(byAccount.entries())
    .map(([acct, t]) => ({ account: acct, debit: Math.round(t.debit), credit: Math.round(t.credit), net_credit_minus_debit: Math.round(t.credit - t.debit), rows: t.rows }))
    .sort((a, b) => a.account - b.account)

  const buckets = {
    revenue_3000_3999_credit_minus_debit:  0,
    food_cost_4000_4999_debit_minus_credit: 0,
    other_5000_6999_debit_minus_credit:    0,
    staff_7000_7799_debit_minus_credit:    0,
    depreciation_7800_7899:                0,
    staff_7900_7999_debit_minus_credit:    0,
    financial_8000_8899_credit_minus_debit: 0,
    tax_8900_8999_debit_minus_credit:      0,
    ignored_other_ranges:                  0,
  }
  for (const r of acctRows) {
    if (r.account >= 3000 && r.account <= 3999)      buckets.revenue_3000_3999_credit_minus_debit  += r.credit - r.debit
    else if (r.account >= 4000 && r.account <= 4999) buckets.food_cost_4000_4999_debit_minus_credit += r.debit - r.credit
    else if (r.account >= 5000 && r.account <= 6999) buckets.other_5000_6999_debit_minus_credit    += r.debit - r.credit
    else if (r.account >= 7000 && r.account <= 7799) buckets.staff_7000_7799_debit_minus_credit    += r.debit - r.credit
    else if (r.account >= 7800 && r.account <= 7899) buckets.depreciation_7800_7899                += r.debit - r.credit
    else if (r.account >= 7900 && r.account <= 7999) buckets.staff_7900_7999_debit_minus_credit    += r.debit - r.credit
    else if (r.account >= 8000 && r.account <= 8899) buckets.financial_8000_8899_credit_minus_debit += r.credit - r.debit
    else if (r.account >= 8900 && r.account <= 8999) buckets.tax_8900_8999_debit_minus_credit       += r.debit - r.credit
    else                                              buckets.ignored_other_ranges                  += r.debit + r.credit
  }
  for (const k of Object.keys(buckets) as Array<keyof typeof buckets>) {
    buckets[k] = Math.round(buckets[k])
  }

  // Top 20 accounts by absolute net amount
  const topAccounts = [...acctRows]
    .sort((a, b) => Math.abs(b.net_credit_minus_debit) - Math.abs(a.net_credit_minus_debit))
    .slice(0, 20)

  // ── Optional comparison against existing tracker_data baseline ─────────
  let baselineCompare: any = null
  const { data: baseline } = await db
    .from('tracker_data')
    .select('source, created_via, revenue, food_cost, staff_cost, other_cost, dine_in_revenue, takeaway_revenue, alcohol_revenue, alcohol_cost')
    .eq('business_id', businessId)
    .eq('period_year', year)
    .eq('period_month', month)
    .maybeSingle()

  if (baseline) {
    baselineCompare = {
      baseline_source: baseline.source,
      baseline_created_via: baseline.created_via,
      diffs: {
        revenue:    { api: projected.revenue,    pdf: Number(baseline.revenue ?? 0),    diff: projected.revenue    - Number(baseline.revenue ?? 0) },
        food_cost:  { api: projected.food_cost,  pdf: Number(baseline.food_cost ?? 0),  diff: projected.food_cost  - Number(baseline.food_cost ?? 0) },
        staff_cost: { api: projected.staff_cost, pdf: Number(baseline.staff_cost ?? 0), diff: projected.staff_cost - Number(baseline.staff_cost ?? 0) },
        other_cost: { api: projected.other_cost, pdf: Number(baseline.other_cost ?? 0), diff: projected.other_cost - Number(baseline.other_cost ?? 0) },
      },
    }
  }

  return NextResponse.json({
    ok:               true,
    period:           { year, month, from_date: fromDate, to_date: toDate },
    fetch: {
      voucher_count:    fetchResult.vouchers.length,
      list_requests:    fetchResult.listRequests,
      detail_requests:  fetchResult.detailRequests,
      duration_ms:      Date.now() - startedAt,
      token_refreshed:  fetchResult.tokenRefreshed,
    },
    translation: {
      periods_seen: translation.periods.map(p => ({ year: p.year, month: p.month, voucher_count: p.voucherCount, line_count: p.lines.length })),
      skipped_count: translation.skipped.length,
      voucher_count_in_target_period: period.voucherCount,
      line_count_in_target_period:    period.lines.length,
    },
    bucket_totals: buckets,
    projected,
    top_accounts: topAccounts,
    baseline_compare: baselineCompare,
  })
}
