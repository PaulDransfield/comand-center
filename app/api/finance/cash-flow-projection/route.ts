// app/api/finance/cash-flow-projection/route.ts
//
// Phase 2 cash visibility — 30-day forward cash-flow projection. Combines:
//   - Current bank balance (sum of BAS 1910-1979 BalanceCarriedForward via
//     existing fetchBankAccountBalances helper)
//   - Outflows: unpaid supplier invoices, due in window
//   - Outflows: estimated salary payment on the next 25th (from last 3
//     months' average staff_logs.cost_actual / estimated_salary)
//   - Inflows: unpaid customer invoices, due in window
//
// Produces a day-by-day projection plus a summary identifying the cash
// trough (lowest projected balance + date).
//
// Honest about limits: the starting balance is Fortnox's BOOKED bank
// position, not necessarily the live bank — same caveat as the cash
// position tile. POS revenue inflows are NOT projected (they're not
// reliably booked into Fortnox until the accountant reconciles).
//
// GET /api/finance/cash-flow-projection?business_id=<uuid>[&days=30]

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { getFreshFortnoxAccessToken } from '@/lib/fortnox/api/auth'
import { fetchBankAccountBalances }    from '@/lib/fortnox/api/account-balance'
import {
  fetchUnpaidSupplierInvoices,
  fetchUnpaidCustomerInvoices,
  type UnpaidInvoice,
} from '@/lib/fortnox/api/unpaid-invoices'

export const runtime         = 'nodejs'
export const dynamic         = 'force-dynamic'
export const preferredRegion = 'fra1'
export const maxDuration     = 30

// BAS bank accounts in scope — matches lib/fortnox/api/voucher-to-aggregator.ts
const BANK_ACCOUNT_RANGE = Array.from({ length: 70 }, (_, i) => 1910 + i)
  .filter(n => n <= 1979)

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const businessId = String(req.nextUrl.searchParams.get('business_id') ?? '').trim()
  const daysParam  = Number(req.nextUrl.searchParams.get('days') ?? 30)
  const daysAhead  = Number.isFinite(daysParam) ? Math.min(Math.max(daysParam, 7), 90) : 30
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id, currency')
    .eq('id', businessId)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'Business not found in your org' }, { status: 404 })

  const todayIso     = new Date().toISOString().slice(0, 10)
  const today        = new Date(todayIso + 'T00:00:00Z')
  const horizonDate  = new Date(today.getTime() + daysAhead * 86_400_000)
  const horizonIso   = horizonDate.toISOString().slice(0, 10)

  // ── Starting balance: sum of Fortnox bank CarriedForward ─────────────
  // Probe the same range used by the voucher translator. Empty accounts
  // (404 from Fortnox) are filtered out naturally.
  // Pre-discover which accounts the business actually uses by querying
  // tracker_data — saves N API calls vs blind-probing 70 accounts.
  const { data: usedRows } = await db
    .from('tracker_data')
    .select('bank_accounts')
    .eq('business_id', businessId)
    .not('bank_accounts', 'is', null)
    .order('period_year', { ascending: false })
    .order('period_month', { ascending: false })
    .limit(12)
  const accountsUsed = new Set<number>()
  for (const r of (usedRows ?? [])) {
    const ba = (r as any).bank_accounts ?? {}
    for (const k of Object.keys(ba)) accountsUsed.add(Number(k))
  }
  // Fallback: if we have no tracker_data yet, probe the BAS bank-range default.
  const accountsToProbe = accountsUsed.size > 0
    ? Array.from(accountsUsed)
    : [1910, 1920, 1930, 1940]

  const balances = await fetchBankAccountBalances(db, auth.orgId, businessId, accountsToProbe)
  const haveBalances = Object.keys(balances.balances).length > 0
  const startingBalance = haveBalances
    ? Object.values(balances.balances).reduce((s, b) => s + b.current_balance, 0)
    : null

  // ── Fortnox access for invoice lists ─────────────────────────────────
  let accessToken: string | null = null
  try { accessToken = await getFreshFortnoxAccessToken(db, auth.orgId, businessId) } catch { accessToken = null }

  const supplierResult = accessToken
    ? await fetchUnpaidSupplierInvoices(accessToken, horizonIso)
    : { invoices: [], total: 0, count: 0, error: 'no_fortnox_token' as string | undefined }
  const customerResult = accessToken
    ? await fetchUnpaidCustomerInvoices(accessToken, horizonIso)
    : { invoices: [], total: 0, count: 0, error: 'no_fortnox_token' as string | undefined }

  // ── Salary outflow on next 25th ──────────────────────────────────────
  // Pull last 3 months of staff_logs to estimate next payroll. Use
  // cost_actual when set, fall back to estimated_salary.
  const threeMonthsAgo = new Date(today.getTime() - 90 * 86_400_000).toISOString().slice(0, 10)
  const { data: staffRows } = await db
    .from('staff_logs')
    .select('cost_actual, estimated_salary, shift_date')
    .eq('business_id', businessId)
    .gte('shift_date', threeMonthsAgo)
    .lte('shift_date', todayIso)
  let estimatedMonthlySalary = 0
  if (staffRows && staffRows.length > 0) {
    const totalCost = staffRows.reduce((s, r: any) => {
      const v = Number(r.cost_actual ?? r.estimated_salary ?? 0)
      return s + (Number.isFinite(v) ? v : 0)
    }, 0)
    // Average across the period covered: assume ~3 months of data
    const monthsCovered = 3
    estimatedMonthlySalary = Math.round(totalCost / monthsCovered)
  }

  // Find next occurrence of a specific day-of-month in the window
  function nextDayOfMonth(from: Date, days: number, dom: number): string | null {
    for (let i = 0; i <= days; i++) {
      const d = new Date(from.getTime() + i * 86_400_000)
      if (d.getUTCDate() === dom) return d.toISOString().slice(0, 10)
    }
    return null
  }
  const salaryDate = estimatedMonthlySalary > 0 ? nextDayOfMonth(today, daysAhead, 25) : null

  // ── F-skatt (employer tax + preliminary income tax) ──────────────────
  // Skatteverket payment due 12th of each month for previous month's
  // PAYE (källskatt) + employer fees (arbetsgivaravgift) + own preliminary
  // income tax (F-skatt). Approximation: ~25% of monthly staff_cost
  // captures most of it (arbetsgivaravgift ≈ 31.42% of gross salary,
  // PAYE varies but ~28% of staff_cost on average for SE restaurants;
  // we use 25% as a conservative single-number proxy).
  //
  // This is rough but useful. Owners forget the 12th hit and a rough
  // projection beats none. Phase 4+ could replace with voucher-derived
  // account 2510 debit history once the translator captures liability
  // accounts.
  const estimatedFskattMonthly = Math.round(estimatedMonthlySalary * 0.25)
  const fskattDate = estimatedFskattMonthly > 0 ? nextDayOfMonth(today, daysAhead, 12) : null

  // ── VAT (Mervärdesskatt) settlement ─────────────────────────────────
  // Skatteverket payment dates assume QUARTERLY reporting (default for
  // SE businesses under ~40M SEK turnover — covers virtually all
  // restaurants in our segment):
  //   Q1 (Jan-Mar): due 12 May
  //   Q2 (Apr-Jun): due 26 Aug
  //   Q3 (Jul-Sep): due 26 Nov
  //   Q4 (Oct-Dec): due 27 Feb
  //
  // Net VAT estimate from per-quarter monthly_metrics: output VAT on
  // revenue (12% dine-in, 6% takeaway, 25% alcohol, 25% on other
  // revenue components) minus a rough input VAT credit (~12% on food
  // cost, 25% on other cost). Net is typically positive (restaurant
  // owes Skatteverket).
  //
  // Magnitude is rough (±20%) but useful — owners forget VAT entirely,
  // so even a directional projection is a step up. Phase 5+ could
  // pull the precise VAT-account voucher data once the translator
  // captures 2611/2614/2640/2641.
  type VatQuarter = { quarter: 1 | 2 | 3 | 4; year: number; due: string }
  function nextVatSettlement(from: Date, days: number): VatQuarter | null {
    const candidates: VatQuarter[] = [
      { quarter: 1, year: 0, due: '__-05-12' },
      { quarter: 2, year: 0, due: '__-08-26' },
      { quarter: 3, year: 0, due: '__-11-26' },
      { quarter: 4, year: 0, due: '__-02-27' },   // due in following year
    ]
    for (let i = 0; i <= days; i++) {
      const d   = new Date(from.getTime() + i * 86_400_000)
      const iso = d.toISOString().slice(0, 10)
      for (const c of candidates) {
        const dueDay   = c.due.slice(-5)   // MM-DD
        const isoTail  = iso.slice(-5)
        if (dueDay !== isoTail) continue
        const year  = d.getUTCFullYear()
        // For Q4 (Feb settlement), Q4 belongs to prior year
        const quarterYear = c.quarter === 4 ? year - 1 : year
        return { quarter: c.quarter, year: quarterYear, due: iso }
      }
    }
    return null
  }
  const vatSettlement = nextVatSettlement(today, daysAhead)
  let estimatedVatAmount = 0
  if (vatSettlement) {
    const months = vatSettlement.quarter === 1 ? [1, 2, 3]
                 : vatSettlement.quarter === 2 ? [4, 5, 6]
                 : vatSettlement.quarter === 3 ? [7, 8, 9]
                 : [10, 11, 12]
    const { data: quarterRows } = await db
      .from('monthly_metrics')
      .select('year, month, revenue, dine_in_revenue, takeaway_revenue, alcohol_revenue, food_cost, other_cost')
      .eq('business_id', businessId)
      .eq('year', vatSettlement.year)
      .in('month', months)
    const q = quarterRows ?? []
    if (q.length > 0) {
      const sum = (k: string) => q.reduce((s, r: any) => s + Number(r[k] ?? 0), 0)
      const dineIn   = sum('dine_in_revenue')
      const takeaway = sum('takeaway_revenue')
      const alcohol  = sum('alcohol_revenue')
      const totalRev = sum('revenue')
      const otherRev = Math.max(0, totalRev - dineIn - takeaway - alcohol)
      const foodCost = sum('food_cost')
      const otherCost = sum('other_cost')

      // Output VAT (revenue figures are ex-VAT in BAS; apply rate directly)
      const outputVat = dineIn   * 0.12
                      + takeaway * 0.06
                      + alcohol  * 0.25
                      + otherRev * 0.25
      // Input VAT (rough — most food at 12%, other at 25%)
      const inputVat = foodCost * 0.12 + otherCost * 0.25
      estimatedVatAmount = Math.max(0, Math.round(outputVat - inputVat))
    }
  }
  const vatDate = vatSettlement && estimatedVatAmount > 0 ? vatSettlement.due : null

  // ── Build day-by-day projection ──────────────────────────────────────
  interface ProjectionDay {
    date:         string
    balance:      number          // running balance at end of day
    events:       Array<{ type: 'supplier_due' | 'customer_due' | 'salary' | 'fskatt' | 'vat'; amount: number; label: string }>
  }
  const projection: ProjectionDay[] = []
  let running = startingBalance ?? 0

  // Index outflows / inflows by date
  const byDate: Record<string, ProjectionDay['events']> = {}
  function addEvent(date: string, type: 'supplier_due' | 'customer_due' | 'salary' | 'fskatt' | 'vat', amount: number, label: string) {
    if (!byDate[date]) byDate[date] = []
    byDate[date].push({ type, amount, label })
  }
  for (const inv of supplierResult.invoices) {
    // Outflow — negative
    addEvent(inv.due_date, 'supplier_due', -Math.round(inv.total), `${inv.counterparty} — invoice ${inv.given_number}`)
  }
  for (const inv of customerResult.invoices) {
    // Inflow — positive
    addEvent(inv.due_date, 'customer_due', Math.round(inv.total), `${inv.counterparty} — invoice ${inv.given_number}`)
  }
  if (salaryDate && estimatedMonthlySalary > 0) {
    addEvent(salaryDate, 'salary', -estimatedMonthlySalary, `Estimated salary payment (3-month average)`)
  }
  if (fskattDate && estimatedFskattMonthly > 0) {
    addEvent(fskattDate, 'fskatt', -estimatedFskattMonthly, `Estimated F-skatt / employer tax (≈ 25% of staff cost)`)
  }
  if (vatDate && vatSettlement && estimatedVatAmount > 0) {
    addEvent(vatDate, 'vat', -estimatedVatAmount, `Estimated VAT settlement (Q${vatSettlement.quarter} ${vatSettlement.year})`)
  }

  for (let i = 0; i <= daysAhead; i++) {
    const d        = new Date(today.getTime() + i * 86_400_000)
    const iso      = d.toISOString().slice(0, 10)
    const events   = byDate[iso] ?? []
    for (const e of events) running += e.amount
    projection.push({ date: iso, balance: Math.round(running), events })
  }

  // Find cash trough — lowest projected balance + its date
  let trough = projection[0]
  for (const day of projection) {
    if (day.balance < trough.balance) trough = day
  }

  return NextResponse.json({
    business_id:        businessId,
    currency:           biz.currency ?? 'SEK',
    horizon_days:       daysAhead,
    starting_balance:   startingBalance,
    starting_balance_source: haveBalances ? 'fortnox_accounts' : 'unavailable',
    summary: {
      cash_trough_date:   trough.date,
      cash_trough_amount: trough.balance,
      ending_balance:     projection[projection.length - 1]?.balance ?? null,
      total_outflows_30d: Math.round(supplierResult.total + estimatedMonthlySalary + estimatedFskattMonthly + estimatedVatAmount),
      total_inflows_30d:  Math.round(customerResult.total),
      net_30d:            Math.round(customerResult.total - supplierResult.total - estimatedMonthlySalary - estimatedFskattMonthly - estimatedVatAmount),
    },
    sources: {
      supplier_invoices: {
        count: supplierResult.count,
        total: supplierResult.total,
        error: supplierResult.error ?? null,
      },
      customer_invoices: {
        count: customerResult.count,
        total: customerResult.total,
        error: customerResult.error ?? null,
      },
      salary_estimate: {
        next_payday:     salaryDate,
        monthly_amount:  estimatedMonthlySalary,
        source:          estimatedMonthlySalary > 0 ? 'staff_logs_3m_avg' : 'unavailable',
      },
      fskatt_estimate: {
        next_due:        fskattDate,
        monthly_amount:  estimatedFskattMonthly,
        source:          estimatedFskattMonthly > 0 ? 'approx_25pct_of_staff_cost' : 'unavailable',
      },
      vat_estimate: {
        next_due:        vatDate,
        quarter:         vatSettlement?.quarter ?? null,
        quarter_year:    vatSettlement?.year    ?? null,
        amount:          estimatedVatAmount,
        source:          estimatedVatAmount > 0 ? 'approx_from_monthly_metrics_revenue_costs' : 'unavailable',
      },
    },
    projection,
    supplier_invoices: supplierResult.invoices,
    customer_invoices: customerResult.invoices,
  }, { headers: { 'Cache-Control': 'private, max-age=120, stale-while-revalidate=300' } })
}
