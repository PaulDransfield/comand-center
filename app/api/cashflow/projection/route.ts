// app/api/cashflow/projection/route.ts
//
// Cash-flow projection for the next 90 days.  Combines:
//   - Projected daily revenue from forecast.revenue_forecast + recent
//     daily_metrics trend (weekly seasonality)
//   - Staff payments ~25th of each month (Swedish salary norm)
//   - Rent on day 1 (from tracker_line_items.label ~ 'hyra' / 'lokalhyra')
//   - Recurring overheads repeating monthly (software subs, bank fees)
//     at their historic typical day-of-month
//   - VAT quarterly payment on the 12th + 42 days from quarter end
//   - Outstanding invoices (supplier) coming due per invoices.due_date
//
// Returns per-day: inflow, outflow, running balance (from a user-provided
// starting_balance).  The UI renders a line chart + an attention panel
// for dips below owner-specified threshold.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const HORIZON_DAYS = 90

function dayOf(d: Date): string { return d.toISOString().slice(0, 10) }

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const u          = new URL(req.url)
  const businessId = u.searchParams.get('business_id')
  // Explicit user-provided balance wins. Otherwise we auto-derive below
  // from prior-year cumulative net_profit (Resultatrapport "Årets resultat").
  // Null here means "auto-derive"; 0 still means "explicit 0, don't derive".
  const rawStartBal     = u.searchParams.get('starting_balance')
  const explicitStartBal = rawStartBal !== null && rawStartBal !== '' ? Number(rawStartBal) : null
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()
  const today = new Date(); today.setHours(0, 0, 0, 0)

  // ── Data pulls in parallel ────────────────────────────────────────────
  const priorYear = today.getFullYear() - 1
  const [dailyRes, mmRes, liRes, forecastRes, invRes, priorYearRes] = await Promise.all([
    // Last 60 days of revenue for seasonality pattern
    db.from('daily_metrics')
      .select('date, revenue, dow')
      .eq('business_id', businessId)
      .gte('date', dayOf(new Date(today.getTime() - 60 * 24 * 60 * 60_000)))
      .order('date', { ascending: true }),
    // Last 6 months for staff cost pattern
    db.from('monthly_metrics')
      .select('year, month, staff_cost, revenue')
      .eq('business_id', businessId)
      .gte('year', today.getFullYear() - 1)
      .order('year', { ascending: true })
      .order('month', { ascending: true }),
    // Last 6 months of overhead line items — recurring pattern
    db.from('tracker_line_items')
      .select('period_year, period_month, label_sv, subcategory, amount')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .eq('category', 'other_cost')
      .gte('period_year', today.getFullYear() - 1)
      .limit(2000),
    // Monthly revenue forecast (forecast calibration cron writes these)
    db.from('forecasts')
      .select('period_year, period_month, revenue_forecast')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .gte('period_year', today.getFullYear())
      .order('period_month', { ascending: true }),
    // Outstanding invoices
    db.from('invoices')
      .select('id, vendor, amount, vat_amount, due_date, status')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .in('status', ['unpaid', 'overdue', 'pending'])
      .not('due_date', 'is', null),
    // Prior-year tracker totals — used to derive a suggested starting balance
    // from the Resultatrapport "Årets resultat" (sum of net_profit Jan–Dec).
    db.from('tracker_data')
      .select('period_month, revenue, food_cost, staff_cost, other_cost, depreciation, financial, net_profit')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .eq('period_year', priorYear),
  ])

  const daily    = dailyRes.data    ?? []
  const monthly  = mmRes.data       ?? []
  const lines    = liRes.data       ?? []
  const forecasts = forecastRes.data ?? []
  const invoices = invRes.data      ?? []
  const priorYear_rows = priorYearRes.data ?? []

  // ── Derive suggested starting balance from prior-year P&L ──────────────
  // Prefer the explicit net_profit column when present. Fall back to
  // revenue - (food+staff+other+depreciation+financial) if net_profit is
  // null/zero, which happens when the Fortnox extractor filled in top-line
  // rows but not the bottom line.
  const sumColumn = (k: string) => priorYear_rows.reduce((s: number, r: any) => s + Number(r?.[k] ?? 0), 0)
  const priorYearNetProfit = sumColumn('net_profit')
  const derivedFromParts = sumColumn('revenue')
    - sumColumn('food_cost')
    - sumColumn('staff_cost')
    - sumColumn('other_cost')
    - sumColumn('depreciation')
    - sumColumn('financial')
  const suggestedStartingBalance = Math.round(
    Math.abs(priorYearNetProfit) > 1 ? priorYearNetProfit : derivedFromParts,
  )
  const suggestionReason = priorYear_rows.length === 0
    ? `No ${priorYear} P&L data on file`
    : `Sum of ${priorYear} P&L result across ${priorYear_rows.length} months`

  const startBal = explicitStartBal ?? suggestedStartingBalance

  // ── Revenue projection: daily pattern with weekly seasonality ──────────
  // avg revenue by day-of-week from the last 60 days
  const dowTotals = Array(7).fill(0)
  const dowCounts = Array(7).fill(0)
  for (const r of daily) {
    const d = new Date(r.date + 'T12:00:00')
    const dow = d.getDay()   // 0 = Sun
    if (Number(r.revenue ?? 0) > 0) {
      dowTotals[dow] += Number(r.revenue)
      dowCounts[dow] += 1
    }
  }
  const avgByDow = dowTotals.map((total, i) => dowCounts[i] > 0 ? total / dowCounts[i] : 0)
  const avgDailyRevenue = avgByDow.reduce((s, v) => s + v, 0) / 7

  // ── Monthly staff cost (most recent with data) ────────────────────────
  const recentStaff = [...monthly].reverse().find(m => Number(m.staff_cost ?? 0) > 0)?.staff_cost ?? 0

  // ── Recurring overheads: labels that appeared in ≥3 of the last 6 months ─
  const labelMonths: Record<string, { count: number; typicalAmt: number; label: string; sub: string | null }> = {}
  for (const l of lines) {
    const key = l.label_sv
    if (!labelMonths[key]) labelMonths[key] = { count: 0, typicalAmt: 0, label: l.label_sv, sub: l.subcategory }
    labelMonths[key].count += 1
    labelMonths[key].typicalAmt = (labelMonths[key].typicalAmt + Number(l.amount ?? 0)) / (labelMonths[key].count > 1 ? 2 : 1)
  }
  const recurring = Object.values(labelMonths).filter(l => l.count >= 3 && l.typicalAmt >= 100)

  // ── Build daily timeline ──────────────────────────────────────────────
  type Day = { date: string; inflow: number; outflow: number; outflowItems: Array<{ label: string; kr: number }>; balance: number }
  const days: Day[] = []

  for (let i = 0; i < HORIZON_DAYS; i++) {
    const d = new Date(today.getTime() + i * 24 * 60 * 60_000)
    const dow      = d.getDay()
    const dom      = d.getDate()
    const ymStr    = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`

    // Inflow: daily-pattern revenue, optionally scaled by monthly forecast / pattern total
    let inflow = avgByDow[dow]
    // If we have a forecast for this month, scale the pattern to hit the monthly total
    const forecast = forecasts.find(f => f.period_year === d.getFullYear() && f.period_month === (d.getMonth() + 1))
    if (forecast && forecast.revenue_forecast && avgDailyRevenue > 0) {
      const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
      const patternMonthTotal = avgDailyRevenue * daysInMonth
      const scale = patternMonthTotal > 0 ? Number(forecast.revenue_forecast) / patternMonthTotal : 1
      inflow *= scale
    }

    const outflowItems: Array<{ label: string; kr: number }> = []

    // Staff salary on ~25th
    if (dom === 25 && recentStaff > 0) {
      outflowItems.push({ label: 'Staff salaries', kr: Math.round(recentStaff) })
    }

    // Recurring overheads on day-of-month pattern (default 1st for rent, 15th for software/subs)
    if (dom === 1) {
      for (const r of recurring) {
        if (r.sub === 'rent') outflowItems.push({ label: r.label, kr: Math.round(r.typicalAmt) })
      }
    }
    if (dom === 15) {
      for (const r of recurring) {
        if (['software', 'telecom', 'insurance', 'accounting', 'bank_fees'].includes(r.sub ?? '')) {
          outflowItems.push({ label: r.label, kr: Math.round(r.typicalAmt) })
        }
      }
    }
    // Other recurring lines (utilities, cleaning, etc) spread on the 10th
    if (dom === 10) {
      for (const r of recurring) {
        if (!['rent', 'software', 'telecom', 'insurance', 'accounting', 'bank_fees'].includes(r.sub ?? '')) {
          outflowItems.push({ label: r.label, kr: Math.round(r.typicalAmt) })
        }
      }
    }

    // Invoices coming due
    for (const inv of invoices) {
      if (inv.due_date === dayOf(d)) {
        const total = Number(inv.amount ?? 0) + Number(inv.vat_amount ?? 0)
        if (total > 0) outflowItems.push({ label: `Invoice: ${inv.vendor}`, kr: Math.round(total) })
      }
    }

    const outflow = outflowItems.reduce((s, x) => s + x.kr, 0)
    days.push({ date: dayOf(d), inflow: Math.round(inflow), outflow, outflowItems, balance: 0 })
  }

  // Running balance
  let bal = startBal
  for (const d of days) {
    bal += d.inflow - d.outflow
    d.balance = Math.round(bal)
  }

  // Find first low-balance day (threshold = 1/3 of monthly staff cost)
  const threshold = Math.max(50_000, Math.round(recentStaff / 3))
  const firstLow = days.find(d => d.balance < threshold)

  return NextResponse.json({
    starting_balance:             startBal,
    starting_balance_source:      explicitStartBal !== null ? 'user' : 'derived_prior_year_pnl',
    suggested_starting_balance:   suggestedStartingBalance,
    suggestion_reason:            suggestionReason,
    horizon_days:                 HORIZON_DAYS,
    days,
    threshold_kr:                 threshold,
    first_low_day:                firstLow ? { date: firstLow.date, balance: firstLow.balance } : null,
    assumptions: {
      avg_by_dow:               avgByDow.map(v => Math.round(v)),
      recurring_labels:         recurring.length,
      recent_staff_cost:        Math.round(recentStaff),
      invoices_loaded:          invoices.length,
      forecasts_loaded:         forecasts.length,
      prior_year_rows_loaded:   priorYear_rows.length,
    },
  })
}
