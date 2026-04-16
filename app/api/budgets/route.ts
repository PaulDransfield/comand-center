// @ts-nocheck
// app/api/budgets/route.ts
// GET  — fetch budgets + actuals + last year for a business/year
// POST — save budget for a month (upsert)

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

const getAuth = getRequestAuth

export async function GET(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const businessId = searchParams.get('business_id')
  const year       = parseInt(searchParams.get('year') ?? String(new Date().getFullYear()))

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()

  // Fetch budgets for this year
  const { data: budgets } = await db
    .from('budgets')
    .select('*')
    .eq('business_id', businessId)
    .eq('year', year)
    .order('month')

  // Fetch actuals (tracker_data) for this year
  const { data: actuals } = await db
    .from('tracker_data')
    .select('period_month, revenue, staff_cost, food_cost, rent_cost, other_cost, net_profit, margin_pct')
    .eq('business_id', businessId)
    .eq('period_year', year)
    .order('period_month')

  // Fetch last year's actuals for reference
  const { data: lastYear } = await db
    .from('tracker_data')
    .select('period_month, revenue, staff_cost, food_cost, rent_cost, net_profit, margin_pct')
    .eq('business_id', businessId)
    .eq('period_year', year - 1)

  // Fetch AI-generated forecasts to use as smart budget defaults
  const { data: forecasts } = await db
    .from('forecasts')
    .select('period_month, revenue_forecast, staff_cost_forecast, food_cost_forecast, net_profit_forecast, margin_forecast, confidence')
    .eq('business_id', businessId)
    .eq('period_year', year)
    .order('period_month')

  // Fetch covers for this year
  const { data: coversData } = await db
    .from('covers')
    .select('date, total, revenue_per_cover')
    .eq('business_id', businessId)
    .gte('date', `${year}-01-01`)
    .lte('date', `${year}-12-31`)

  // Aggregate covers by month
  const coversByMonth: Record<number, { total: number; rpc: number; count: number }> = {}
  for (const c of coversData ?? []) {
    const m = parseInt(c.date.slice(5, 7))
    if (!coversByMonth[m]) coversByMonth[m] = { total: 0, rpc: 0, count: 0 }
    coversByMonth[m].total += c.total ?? 0
    coversByMonth[m].rpc   += Number(c.revenue_per_cover ?? 0)
    coversByMonth[m].count++
  }

  // Build indexed maps
  const budgetMap:   Record<number, any> = {}
  const actualMap:   Record<number, any> = {}
  const lastYearMap: Record<number, any> = {}

  for (const b of budgets  ?? []) budgetMap[b.month]          = b
  for (const a of actuals  ?? []) actualMap[a.period_month]   = a
  for (const l of lastYear ?? []) lastYearMap[l.period_month] = l

  // Build 12-month combined view
  const months = Array.from({ length: 12 }, (_, i) => {
    const m       = i + 1
    const budget  = budgetMap[m]  ?? null
    const actual  = actualMap[m]  ?? null
    const ly      = lastYearMap[m] ?? null
    const covers  = coversByMonth[m] ?? null

    const actualRev    = Number(actual?.revenue    ?? 0)
    const actualStaff  = Number(actual?.staff_cost ?? 0)
    const actualFood   = Number(actual?.food_cost  ?? 0)
    const actualProfit = Number(actual?.net_profit ?? 0)
    const actualMargin = Number(actual?.margin_pct ?? 0)

    const staffPct  = actualRev > 0 ? (actualStaff / actualRev) * 100 : 0
    const foodPct   = actualRev > 0 ? (actualFood  / actualRev) * 100 : 0

    // Variance = actual - budget (positive = over budget on costs, under on revenue)
    const revVariance     = budget?.revenue_target        ? actualRev    - Number(budget.revenue_target)       : null
    const foodVariance    = budget?.food_cost_pct_target  ? foodPct      - Number(budget.food_cost_pct_target)  : null
    const staffVariance   = budget?.staff_cost_pct_target ? staffPct     - Number(budget.staff_cost_pct_target) : null
    const profitVariance  = budget?.net_profit_target     ? actualProfit - Number(budget.net_profit_target)    : null

    return {
      month: m,
      budget: budget ? {
        revenue_target:          Number(budget.revenue_target         ?? 0),
        food_cost_pct_target:    Number(budget.food_cost_pct_target   ?? 0),
        staff_cost_pct_target:   Number(budget.staff_cost_pct_target  ?? 0),
        net_profit_target:       Number(budget.net_profit_target      ?? 0),
        margin_pct_target:       Number(budget.margin_pct_target      ?? 0),
        covers_target:           Number(budget.covers_target          ?? 0),
        revenue_per_cover_target:Number(budget.revenue_per_cover_target ?? 0),
      } : null,
      actual: actual ? {
        revenue: actualRev, staff_cost: actualStaff, food_cost: actualFood, net_profit: actualProfit,
        margin_pct: actualMargin, staff_pct: staffPct, food_pct: foodPct,
        covers:     covers?.total ?? 0,
        revenue_per_cover: covers?.count ? covers.rpc / covers.count : 0,
      } : null,
      last_year: ly ? {
        revenue:    Number(ly.revenue    ?? 0),
        food_pct:   ly.revenue > 0 ? (Number(ly.food_cost ?? 0)  / Number(ly.revenue)) * 100 : 0,
        staff_pct:  ly.revenue > 0 ? (Number(ly.staff_cost ?? 0) / Number(ly.revenue)) * 100 : 0,
        net_profit: Number(ly.net_profit ?? 0),
        margin_pct: Number(ly.margin_pct ?? 0),
      } : null,
      variance: {
        revenue:    revVariance,
        food_pct:   foodVariance,
        staff_pct:  staffVariance,
        net_profit: profitVariance,
      },
    }
  })

  return NextResponse.json({ year, months })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json()
  const { business_id, year, month, ...targets } = body

  if (!business_id || !year || !month) {
    return NextResponse.json({ error: 'business_id, year and month required' }, { status: 400 })
  }

  const db = createAdminClient()
  const { data, error } = await db
    .from('budgets')
    .upsert({
      org_id:      auth.orgId,
      business_id,
      year:        Number(year),
      month:       Number(month),
      updated_at:  new Date().toISOString(),
      created_by:  auth.userId,
      ...Object.fromEntries(
        Object.entries(targets)
          .filter(([_, v]) => v !== '' && v !== null && v !== undefined)
          .map(([k, v]) => [k, Number(v)])
      ),
    }, { onConflict: 'business_id,year,month' })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
