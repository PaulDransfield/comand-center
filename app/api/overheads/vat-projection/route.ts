// app/api/overheads/vat-projection/route.ts
//
// Projects the next Swedish VAT payment due date + estimated amount.
//
// Swedish restaurant VAT split:
//   - Food served on premises: 12% output VAT
//   - Takeaway food:            6% output VAT
//   - Beverages (incl. alcohol): 25% output VAT (except non-alcoholic in some cases)
//   - Input VAT on overheads:   mostly 25% (rent, utilities, services)
//
// VAT filing: quarterly for most small restaurants, monthly once turnover
// passes 40 MSEK.  Swedish defaults are quarterly — file within 42 days
// of period end (Q1 due 12-May, Q2 12-Aug, Q3 12-Nov, Q4 12-Feb).
//
// This is an ESTIMATE, not a filing.  Owner must verify with their
// accountant before paying.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { requireFinanceAccess, requireBusinessAccess } from '@/lib/auth/require-role'

export const dynamic = 'force-dynamic'

// VAT rates as fractions of GROSS (ex-VAT from inclusive).  Swedish revenue
// is reported ex-VAT in Fortnox P&L, so these turn ex-VAT amounts into
// the VAT portion owed.
const RATE = {
  food_onsite:  0.12,
  takeaway:     0.06,
  beverage:     0.25,
  overheads_in: 0.25,   // input VAT we reclaim on overheads
}

function currentQuarter(date: Date): { year: number; q: number; from: Date; to: Date; dueDate: Date } {
  const y = date.getFullYear()
  const m = date.getMonth()       // 0-11
  const q = Math.floor(m / 3) + 1 // 1-4
  const from = new Date(y, (q - 1) * 3, 1)
  const to   = new Date(y, q * 3, 0)     // last day of quarter
  // Filing due 42 days after period end (Swedish Tax Agency standard).
  const dueDate = new Date(to); dueDate.setDate(dueDate.getDate() + 42)
  return { year: y, q, from, to, dueDate }
}

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const finForbidden = requireFinanceAccess(auth); if (finForbidden) return finForbidden

  const businessId = new URL(req.url).searchParams.get('business_id')
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const bizForbidden = requireBusinessAccess(auth, businessId); if (bizForbidden) return bizForbidden

  const db = createAdminClient()

  // Work in the current quarter so the number matches what the owner will
  // file next.  If the quarter hasn't finished, we still estimate using
  // month-to-date and project to quarter-end pro-rata.
  const now = new Date()
  const { year, q, from, to, dueDate } = currentQuarter(now)

  // Revenue sources — split by channel where we have the detail
  // (daily_metrics is per-day and splits food / bev / takeaway / dine-in).
  const { data: daily } = await db
    .from('daily_metrics')
    .select('revenue, food_revenue, bev_revenue, takeaway_revenue, dine_in_revenue, date')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .gte('date', from.toISOString().slice(0, 10))
    .lte('date', to.toISOString().slice(0, 10))

  const agg = (daily ?? []).reduce((s, r) => ({
    revenue:  s.revenue  + Number(r.revenue           ?? 0),
    food:     s.food     + Number(r.food_revenue      ?? 0),
    bev:      s.bev      + Number(r.bev_revenue       ?? 0),
    takeaway: s.takeaway + Number(r.takeaway_revenue  ?? 0),
    dine_in:  s.dine_in  + Number(r.dine_in_revenue   ?? 0),
  }), { revenue: 0, food: 0, bev: 0, takeaway: 0, dine_in: 0 })

  // Input VAT from Fortnox overheads in the quarter
  const qYears  = [from.getFullYear(), to.getFullYear()]
  const { data: overheads } = await db
    .from('tracker_line_items')
    .select('amount, period_year, period_month')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .eq('category', 'other_cost')
    .in('period_year', [...new Set(qYears)])
    .gte('period_month', from.getMonth() + 1)
    .lte('period_month', to.getMonth() + 1)

  const overheadTotal = (overheads ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0)

  // Compute output VAT (payable) from the revenue channels we have.
  // If we have the full dine-in/takeaway split, use it.  Otherwise fall
  // back to a blended 12% on food revenue as a safe conservative rate.
  let outputVat = 0
  if (agg.takeaway > 0 && agg.dine_in > 0) {
    // We have the channel split — apply correct rates per channel.
    outputVat += agg.dine_in  * RATE.food_onsite
    outputVat += agg.takeaway * RATE.takeaway
  } else if (agg.food > 0) {
    outputVat += agg.food * RATE.food_onsite
  } else {
    // No channel split — treat all revenue as on-site food (safe upper bound).
    outputVat += agg.revenue * RATE.food_onsite
  }
  if (agg.bev > 0) outputVat += agg.bev * RATE.beverage

  const inputVat = overheadTotal * RATE.overheads_in
  const payable  = Math.max(0, outputVat - inputVat)

  // Projection — if we're mid-quarter, scale MTD revenue to full-quarter
  // size by fraction of quarter elapsed.
  const msElapsed = now.getTime() - from.getTime()
  const msTotal   = to.getTime()   - from.getTime() + 24 * 60 * 60 * 1000
  const fraction  = Math.min(1, Math.max(0.05, msElapsed / msTotal))
  const projectedPayable = fraction < 1 ? payable / fraction : payable

  const daysToDue = Math.ceil((dueDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))

  return NextResponse.json({
    period: { year, quarter: q, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    due_date:   dueDate.toISOString().slice(0, 10),
    days_to_due: daysToDue,
    revenue_mtd: Math.round(agg.revenue),
    output_vat:  Math.round(outputVat),
    input_vat:   Math.round(inputVat),
    payable_mtd: Math.round(payable),
    projected_quarter_payable: Math.round(projectedPayable),
    fraction_of_quarter_elapsed: Math.round(fraction * 100) / 100,
    note: 'Estimate only. Verify with your accountant before filing.',
  })
}
