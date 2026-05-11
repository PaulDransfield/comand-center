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

  // Find next 25th in the window
  function nextSalaryDate(from: Date, days: number): string | null {
    for (let i = 0; i <= days; i++) {
      const d = new Date(from.getTime() + i * 86_400_000)
      if (d.getUTCDate() === 25) return d.toISOString().slice(0, 10)
    }
    return null
  }
  const salaryDate = estimatedMonthlySalary > 0 ? nextSalaryDate(today, daysAhead) : null

  // ── Build day-by-day projection ──────────────────────────────────────
  interface ProjectionDay {
    date:         string
    balance:      number          // running balance at end of day
    events:       Array<{ type: 'supplier_due' | 'customer_due' | 'salary'; amount: number; label: string }>
  }
  const projection: ProjectionDay[] = []
  let running = startingBalance ?? 0

  // Index outflows / inflows by date
  const byDate: Record<string, ProjectionDay['events']> = {}
  function addEvent(date: string, type: 'supplier_due' | 'customer_due' | 'salary', amount: number, label: string) {
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
      total_outflows_30d: Math.round(supplierResult.total + estimatedMonthlySalary),
      total_inflows_30d:  Math.round(customerResult.total),
      net_30d:            Math.round(customerResult.total - supplierResult.total - estimatedMonthlySalary),
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
    },
    projection,
    supplier_invoices: supplierResult.invoices,
    customer_invoices: customerResult.invoices,
  }, { headers: { 'Cache-Control': 'private, max-age=120, stale-while-revalidate=300' } })
}
