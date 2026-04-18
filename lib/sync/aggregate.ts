// @ts-nocheck
// lib/sync/aggregate.ts
// Pre-compute summary tables from raw data
// Called after every sync to keep daily_metrics, monthly_metrics, dept_metrics up to date
//
// Source priority:
//   Revenue:    POS (revenue_logs) > Fortnox > manual (tracker_data)
//   Staff cost: PK actual (cost_actual) > PK estimated > Fortnox (7xxx) > manual
//   Food cost:  Fortnox (4xxx) > manual (tracker_data)
//   Other cost: Fortnox > manual

import { createAdminClient } from '@/lib/supabase/server'

// ── Aggregate for a specific business + date range ────────────────────────────
// This is the main function called after sync. It re-computes summaries for the
// date range that was just synced, not the entire history.
export async function aggregateMetrics(
  orgId: string,
  businessId: string,
  fromDate: string,  // YYYY-MM-DD
  toDate: string,    // YYYY-MM-DD
) {
  const db = createAdminClient()

  // ── 1. Fetch raw data for the date range ──────────────────────────────────
  const [revRes, staffRes, trackerRes] = await Promise.all([
    // Note: Supabase defaults to 1000 rows. Restaurants can have 1000+ shifts/month.
    // Use limit(50000) to ensure we get all data.
    db.from('revenue_logs')
      .select('revenue_date, revenue, covers, tip_revenue, food_revenue, bev_revenue, dine_in_revenue, takeaway_revenue, provider')
      .eq('org_id', orgId).eq('business_id', businessId)
      .gte('revenue_date', fromDate).lte('revenue_date', toDate)
      .limit(50000),

    // Exclude scheduled shifts (_scheduled suffix) — only count actual logged hours
    db.from('staff_logs')
      .select('shift_date, cost_actual, estimated_salary, hours_worked, staff_group, is_late, ob_supplement_kr')
      .eq('org_id', orgId).eq('business_id', businessId)
      .gte('shift_date', fromDate).lte('shift_date', toDate)
      .or('cost_actual.gt.0,estimated_salary.gt.0')
      .not('pk_log_url', 'like', '%_scheduled')
      .limit(50000),

    db.from('tracker_data')
      .select('period_year, period_month, revenue, food_cost, staff_cost, net_profit')
      .eq('business_id', businessId)
      .gte('period_year', parseInt(fromDate.slice(0, 4)))
      .lte('period_year', parseInt(toDate.slice(0, 4)))
      .limit(1000),
  ])

  const rawRevLogs = revRes.data ?? []
  const staffLogs  = staffRes.data ?? []
  const trackerRows = trackerRes.data ?? []

  // ── Deduplicate revenue_logs ──────────────────────────────────────────────
  // The sync engine writes BOTH an aggregate 'personalkollen' row AND per-dept
  // 'pk_*' rows for the same sales data. If we sum all providers, we double-count.
  // Priority: prefer per-dept rows (pk_*, inzii_*) over aggregate (personalkollen).
  const hasDeptRows = rawRevLogs.some((r: any) => (r.provider ?? '').startsWith('pk_') || (r.provider ?? '').startsWith('inzii_'))
  const revLogs = hasDeptRows
    ? rawRevLogs.filter((r: any) => {
        const p = r.provider ?? ''
        // Keep per-dept rows (pk_*, inzii_*) and any non-PK aggregate (e.g. fortnox, manual)
        // Skip the aggregate 'personalkollen' row since pk_* rows contain the same data
        return p !== 'personalkollen'
      })
    : rawRevLogs

  // ── 2. Build daily_metrics ────────────────────────────────────────────────
  // Aggregate revenue by date.
  //
  // IMPORTANT: Supabase returns `numeric` columns as STRINGS, not JS numbers.
  // Without Number() coercion, `0 + "23899.00"` becomes `"023899.00"` (string
  // concatenation), every subsequent row keeps concatenating, and Math.round
  // on the final string returns NaN → upserted as 0. That was the "revenue=0
  // in daily_metrics despite non-zero raw rows" bug. Always coerce.
  const toNum = (v: any): number => {
    if (v == null) return 0
    const n = typeof v === 'number' ? v : parseFloat(String(v))
    return Number.isFinite(n) ? n : 0
  }
  const dailyRev: Record<string, any> = {}
  for (const r of revLogs) {
    const d = r.revenue_date
    if (!dailyRev[d]) dailyRev[d] = { revenue: 0, covers: 0, tips: 0, food_revenue: 0, bev_revenue: 0, dine_in: 0, takeaway: 0 }
    dailyRev[d].revenue      += toNum(r.revenue)
    dailyRev[d].covers       += toNum(r.covers)
    dailyRev[d].tips         += toNum(r.tip_revenue)
    dailyRev[d].food_revenue += toNum(r.food_revenue)
    dailyRev[d].bev_revenue  += toNum(r.bev_revenue)
    dailyRev[d].dine_in      += toNum(r.dine_in_revenue)
    dailyRev[d].takeaway     += toNum(r.takeaway_revenue)
  }

  // Aggregate staff cost by date
  const dailyStaff: Record<string, any> = {}
  for (const s of staffLogs) {
    const d = s.shift_date
    if (!dailyStaff[d]) dailyStaff[d] = { cost: 0, hours: 0, shifts: 0, late: 0, ob: 0 }
    const cost = Number(s.cost_actual ?? 0) > 0 ? Number(s.cost_actual) : Number(s.estimated_salary ?? 0)
    dailyStaff[d].cost   += cost
    dailyStaff[d].hours  += Number(s.hours_worked ?? 0)
    dailyStaff[d].shifts += 1
    if (s.is_late) dailyStaff[d].late += 1
    dailyStaff[d].ob += Number(s.ob_supplement_kr ?? 0)
  }

  // Merge into daily_metrics rows
  const allDates = new Set([...Object.keys(dailyRev), ...Object.keys(dailyStaff)])
  const dailyRows = Array.from(allDates).map(date => {
    const rev  = dailyRev[date] ?? {}
    const st   = dailyStaff[date] ?? {}
    const revenue    = Math.round(rev.revenue ?? 0)
    const staff_cost = Math.round(st.cost ?? 0)
    return {
      org_id:       orgId,
      business_id:  businessId,
      date,
      revenue,
      covers:       Math.round(rev.covers ?? 0),
      rev_per_cover: rev.covers > 0 ? Math.round(revenue / rev.covers) : 0,
      tips:         Math.round(rev.tips ?? 0),
      food_revenue: Math.round(rev.food_revenue ?? 0),
      bev_revenue:  Math.round(rev.bev_revenue ?? 0),
      dine_in:      Math.round(rev.dine_in ?? 0),
      takeaway:     Math.round(rev.takeaway ?? 0),
      staff_cost,
      hours_worked: Math.round((st.hours ?? 0) * 10) / 10,
      shifts:       st.shifts ?? 0,
      late_shifts:  st.late ?? 0,
      ob_supplement: Math.round(st.ob ?? 0),
      labour_pct:   revenue > 0 && staff_cost > 0 ? Math.round((staff_cost / revenue) * 1000) / 10 : null,
      rev_source:   rev.revenue > 0 ? 'pos' : 'none',
      cost_source:  st.cost > 0 ? 'pk' : 'none',
      updated_at:   new Date().toISOString(),
    }
  })

  // Upsert daily_metrics in batches
  const BATCH = 50
  for (let i = 0; i < dailyRows.length; i += BATCH) {
    const batch = dailyRows.slice(i, i + BATCH)
    if (batch.length) {
      await db.from('daily_metrics').upsert(batch, { onConflict: 'business_id,date' })
    }
  }

  // ── 3. Build monthly_metrics ──────────────────────────────────────────────
  // Group daily data by month
  const monthlyAcc: Record<string, any> = {}
  for (const row of dailyRows) {
    const y = parseInt(row.date.slice(0, 4))
    const m = parseInt(row.date.slice(5, 7))
    const key = `${y}-${m}`
    if (!monthlyAcc[key]) monthlyAcc[key] = { year: y, month: m, revenue: 0, covers: 0, tips: 0, food_revenue: 0, bev_revenue: 0, staff_cost: 0, hours: 0, shifts: 0, late: 0, ob: 0, hasRev: false, hasStaff: false }
    const a = monthlyAcc[key]
    a.revenue      += row.revenue
    a.covers       += row.covers
    a.tips         += row.tips
    a.food_revenue += row.food_revenue
    a.bev_revenue  += row.bev_revenue
    a.staff_cost   += row.staff_cost
    a.hours        += row.hours_worked
    a.shifts       += row.shifts
    a.late         += row.late_shifts
    a.ob           += row.ob_supplement
    if (row.revenue > 0) a.hasRev = true
    if (row.staff_cost > 0) a.hasStaff = true
  }

  // Merge with tracker_data for food_cost, rent, other
  const trackerByMonth: Record<string, any> = {}
  for (const t of trackerRows) trackerByMonth[`${t.period_year}-${t.period_month}`] = t

  const monthlyRows = Object.values(monthlyAcc).map((a: any) => {
    const tracker    = trackerByMonth[`${a.year}-${a.month}`]
    const food_cost  = Number(tracker?.food_cost ?? 0)
    const rent_cost  = 0  // will come from Fortnox
    const other_cost = 0  // will come from Fortnox
    const total_cost = a.staff_cost + food_cost + rent_cost + other_cost
    const net_profit = a.revenue - total_cost
    const margin_pct = a.revenue > 0 ? Math.round((net_profit / a.revenue) * 1000) / 10 : 0
    const labour_pct = a.revenue > 0 && a.staff_cost > 0 ? Math.round((a.staff_cost / a.revenue) * 1000) / 10 : null
    const food_pct   = a.revenue > 0 && food_cost > 0 ? Math.round((food_cost / a.revenue) * 1000) / 10 : null

    return {
      org_id:       orgId,
      business_id:  businessId,
      year:         a.year,
      month:        a.month,
      revenue:      Math.round(a.revenue),
      covers:       Math.round(a.covers),
      tips:         Math.round(a.tips),
      food_revenue: Math.round(a.food_revenue),
      bev_revenue:  Math.round(a.bev_revenue),
      staff_cost:   Math.round(a.staff_cost),
      food_cost:    Math.round(food_cost),
      rent_cost:    Math.round(rent_cost),
      other_cost:   Math.round(other_cost),
      total_cost:   Math.round(total_cost),
      hours_worked: Math.round(a.hours * 10) / 10,
      shifts:       a.shifts,
      late_shifts:  a.late,
      ob_supplement: Math.round(a.ob),
      net_profit:   Math.round(net_profit),
      margin_pct,
      labour_pct,
      food_pct,
      rev_source:   a.hasRev ? 'pos' : 'none',
      cost_source:  a.hasStaff ? 'pk' : 'none',
      updated_at:   new Date().toISOString(),
    }
  })

  for (let i = 0; i < monthlyRows.length; i += BATCH) {
    const batch = monthlyRows.slice(i, i + BATCH)
    if (batch.length) {
      await db.from('monthly_metrics').upsert(batch, { onConflict: 'business_id,year,month' })
    }
  }

  // ── 4. Build dept_metrics ─────────────────────────────────────────────────
  // Group staff by department + month
  const deptAcc: Record<string, any> = {}
  for (const s of staffLogs) {
    const dept = s.staff_group
    if (!dept) continue
    const y = parseInt(s.shift_date.slice(0, 4))
    const m = parseInt(s.shift_date.slice(5, 7))
    const key = `${dept}|${y}-${m}`
    if (!deptAcc[key]) deptAcc[key] = { dept, year: y, month: m, cost: 0, hours: 0, shifts: 0, late: 0, ob: 0 }
    const cost = Number(s.cost_actual ?? 0) > 0 ? Number(s.cost_actual) : Number(s.estimated_salary ?? 0)
    deptAcc[key].cost   += cost
    deptAcc[key].hours  += Number(s.hours_worked ?? 0)
    deptAcc[key].shifts += 1
    if (s.is_late) deptAcc[key].late += 1
    deptAcc[key].ob += Number(s.ob_supplement_kr ?? 0)
  }

  // Build a slug→name lookup from all known department names (from staff_group)
  const knownDepts: Record<string, string> = {}  // slug → original name
  for (const key of Object.keys(deptAcc)) {
    const name = key.split('|')[0]
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '_')
    knownDepts[slug] = name
  }

  // Group revenue by department (provider = 'pk_<slug>' or 'inzii_<slug>')
  const deptRevAcc: Record<string, any> = {}
  for (const r of revLogs) {
    const provider = r.provider ?? ''
    let dept = null
    if (provider.startsWith('pk_') || provider.startsWith('inzii_')) {
      const slug = provider.replace(/^(pk_|inzii_)/, '')
      // Look up the original mixed-case name from staff_group data
      dept = knownDepts[slug] ?? null
      // If no staff data for this dept, capitalize the slug as a best-effort name
      if (!dept) dept = slug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    }
    if (!dept) continue

    const y = parseInt(r.revenue_date.slice(0, 4))
    const m = parseInt(r.revenue_date.slice(5, 7))
    const key = `${dept}|${y}-${m}`
    if (!deptRevAcc[key]) deptRevAcc[key] = { revenue: 0, covers: 0 }
    deptRevAcc[key].revenue += r.revenue ?? 0
    deptRevAcc[key].covers  += r.covers ?? 0
  }

  // Merge dept staff + revenue into dept_metrics
  const allDeptKeys = new Set([...Object.keys(deptAcc), ...Object.keys(deptRevAcc)])
  const deptRows = Array.from(allDeptKeys).map(key => {
    const staff = deptAcc[key] ?? {}
    const rev   = deptRevAcc[key] ?? {}
    const parts = key.split('|')
    const dept  = parts[0]
    const [y, m] = (parts[1] ?? '').split('-').map(Number)

    const revenue    = Math.round(rev.revenue ?? 0)
    const staff_cost = Math.round(staff.cost ?? 0)
    const labour_pct = revenue > 0 && staff_cost > 0 ? Math.round((staff_cost / revenue) * 1000) / 10 : null
    const gp_pct     = revenue > 0 ? Math.round(((revenue - staff_cost) / revenue) * 1000) / 10 : null

    return {
      org_id:       orgId,
      business_id:  businessId,
      dept_name:    dept,
      year:         y,
      month:        m,
      revenue,
      covers:       Math.round(rev.covers ?? 0),
      staff_cost,
      hours_worked: Math.round((staff.hours ?? 0) * 10) / 10,
      shifts:       staff.shifts ?? 0,
      late_shifts:  staff.late ?? 0,
      ob_supplement: Math.round(staff.ob ?? 0),
      labour_pct,
      gp_pct,
      updated_at:   new Date().toISOString(),
    }
  }).filter(r => r.year && r.month)

  for (let i = 0; i < deptRows.length; i += BATCH) {
    const batch = deptRows.slice(i, i + BATCH)
    if (batch.length) {
      await db.from('dept_metrics').upsert(batch, { onConflict: 'business_id,dept_name,year,month' })
    }
  }

  return {
    daily_rows:   dailyRows.length,
    monthly_rows: monthlyRows.length,
    dept_rows:    deptRows.length,
  }
}

// ── Aggregate ALL data for a business (full rebuild) ──────────────────────────
// Used for initial setup or manual re-sync
export async function aggregateAll(orgId: string, businessId: string) {
  // Use a wide date range to cover all historical data
  return aggregateMetrics(orgId, businessId, '2020-01-01', '2030-12-31')
}
