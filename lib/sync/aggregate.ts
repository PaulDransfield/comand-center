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
  // .lte(toDate) was dropped. With the upper-bound chained, Supabase was returning
  // rows up to toDate - 1 — Apr 17 rows were silently excluded despite satisfying
  // `<= '2026-04-18'`. An .eq() on the same date worked fine. Without the upper
  // bound we rely on: (a) no sync writes future-dated rows; (b) in-memory
  // filtering below if we ever want a strict window.
  //
  // PostgREST / Supabase silently caps response size at `max_rows` (default 1000)
  // regardless of `.limit(N)` — we discovered this 2026-04-19 when Apr 18 daily
  // rows were missing. Vero has ~27 shifts/day × 90 days ≈ 2400 rows, so the
  // first 1000 truncated the most recent dates. Must paginate with `.range()`.
  async function fetchAllPaged<T = any>(
    buildQuery: (from: number, to: number) => any,
    pageSize = 1000,
  ): Promise<T[]> {
    const out: T[] = []
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await buildQuery(offset, offset + pageSize - 1)
      if (error) {
        console.error('[aggregate] fetch page failed', { offset, error: error.message })
        throw new Error(`paged fetch failed at offset ${offset}: ${error.message}`)
      }
      const rows = data ?? []
      out.push(...rows)
      if (rows.length < pageSize) break  // last page
      if (offset > 200000) {
        console.error('[aggregate] fetch pagination runaway — bailing', { offset })
        break
      }
    }
    return out
  }

  const [rawRevLogs, staffLogs, trackerRes] = await Promise.all([
    fetchAllPaged((lo, hi) =>
      db.from('revenue_logs')
        .select('revenue_date, revenue, covers, tip_revenue, food_revenue, bev_revenue, dine_in_revenue, takeaway_revenue, provider')
        .eq('org_id', orgId).eq('business_id', businessId)
        .gte('revenue_date', fromDate)
        .order('revenue_date', { ascending: true })
        .range(lo, hi)
    ),
    fetchAllPaged((lo, hi) =>
      db.from('staff_logs')
        .select('shift_date, cost_actual, estimated_salary, hours_worked, staff_group, is_late, ob_supplement_kr')
        .eq('org_id', orgId).eq('business_id', businessId)
        .gte('shift_date', fromDate)
        .or('cost_actual.gt.0,estimated_salary.gt.0')
        .not('pk_log_url', 'like', '%_scheduled')
        .order('shift_date', { ascending: true })
        .range(lo, hi)
    ),
    db.from('tracker_data')
      .select('period_year, period_month, revenue, food_cost, staff_cost, rent_cost, other_cost, net_profit, source')
      .eq('business_id', businessId)
      .gte('period_year', parseInt(fromDate.slice(0, 4)))
      .lte('period_year', parseInt(toDate.slice(0, 4))),
  ])

  const trackerRows = trackerRes.data ?? []

  // Single compact fetch summary. Expanded diagnostics can be re-added from git
  // history (`.lte` bug recovery, 2026-04-18) if another pipeline break surfaces.
  const latestRev = rawRevLogs.reduce((m: string, r: any) => r.revenue_date > m ? r.revenue_date : m, '')
  console.log('[aggregate] fetched', {
    business_id: businessId,
    fromDate,
    rev_rows:    rawRevLogs.length,
    staff_rows:  staffLogs.length,
    latest_rev:  latestRev,
  })

  // ── Deduplicate revenue_logs ──────────────────────────────────────────────
  // The sync engine writes BOTH an aggregate 'personalkollen' row AND per-dept
  // 'pk_*' rows for the same sales data. If we sum all providers, we double-count.
  // Priority: prefer per-dept rows (pk_*, inzii_*) over aggregate (personalkollen).
  //
  // IMPORTANT: filter per-date, not globally. A global hasDeptRows check caused
  // yesterday's data to vanish whenever per-dept matching failed for that day
  // (new workplace, timeout on getWorkplaces, sale without workplace_url).
  // Old dates would have pk_* rows → hasDeptRows=true → ALL 'personalkollen'
  // rows dropped, including yesterday's where only the aggregate row existed.
  const datesWithDeptRows = new Set(
    rawRevLogs
      .filter((r: any) => {
        const p = r.provider ?? ''
        return p.startsWith('pk_') || p.startsWith('inzii_')
      })
      .map((r: any) => r.revenue_date),
  )
  const revLogs = rawRevLogs.filter((r: any) => {
    const p = r.provider ?? ''
    // For the aggregate 'personalkollen' row: only drop it on dates where
    // per-dept rows exist (to avoid double-counting). If a date has NO pk_*
    // rows (e.g. per-dept matching failed that day), keep the aggregate so
    // the day is not silently zeroed.
    if (p === 'personalkollen') return !datesWithDeptRows.has(r.revenue_date)
    return true
  })

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

  // Upsert daily_metrics in batches.
  // CRITICAL: Supabase does NOT throw on constraint violations — it returns an
  // `error` object. If we don't check, a bad row silently drops the whole batch
  // and the log says "aggregate OK" with a fake row count. The "Apr 17 missing
  // for Vero" bug was exactly this: the upsert rejected the batch containing
  // Apr 17, but nothing surfaced.
  const BATCH = 50
  let daily_written = 0
  for (let i = 0; i < dailyRows.length; i += BATCH) {
    const batch = dailyRows.slice(i, i + BATCH)
    if (batch.length) {
      const { error } = await db.from('daily_metrics').upsert(batch, { onConflict: 'business_id,date' })
      if (error) {
        const sample = batch.slice(0, 2).map((r: any) => ({ date: r.date, revenue: r.revenue, staff_cost: r.staff_cost }))
        console.error('[aggregate] daily_metrics upsert FAILED', {
          business_id: businessId,
          batch_index: i / BATCH,
          batch_size:  batch.length,
          error:       error.message,
          code:        (error as any).code,
          details:     (error as any).details,
          hint:        (error as any).hint,
          sample_rows: sample,
        })
        throw new Error(`daily_metrics upsert failed (batch ${i / BATCH}): ${error.message}`)
      }
      daily_written += batch.length
    }
  }

  // ── 3. Build monthly_metrics ──────────────────────────────────────────────
  // Two data sources: POS-derived daily rows + Fortnox tracker_data rows.
  // We previously only created a monthly row when POS had data for that
  // month — which meant months with ONLY Fortnox data (e.g. a business
  // without Personalkollen coverage that uploaded Fortnox P&L PDFs)
  // produced no monthly_metrics row at all, and every downstream
  // consumer (budget generator, forecast calibration, weekly memo,
  // tracker page, cashflow, coach) saw an empty year.
  //
  // Now the month set is the UNION of months present in either source.
  // For each month:
  //   Revenue     = POS if any, else tracker_data.revenue
  //   Staff cost  = PK cost (existing), fall back to tracker_data.staff_cost
  //   Food cost   = tracker_data.food_cost
  //   Other cost  = tracker_data.other_cost
  //   Rent cost   = tracker_data.rent_cost
  // rev_source / cost_source fields record which feeder won for this month
  // so the UI can tell operators which numbers are accountant-authoritative.

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

  const trackerByMonth: Record<string, any> = {}
  for (const t of trackerRows) {
    // period_month=0 is the legacy annual-rollup convention; keep it in
    // tracker_data for display but don't inject into monthly_metrics.
    if (!t.period_month || t.period_month < 1 || t.period_month > 12) continue
    trackerByMonth[`${t.period_year}-${t.period_month}`] = t
  }

  // Seed accumulator with Fortnox-only months that have no POS data.
  for (const [key, t] of Object.entries(trackerByMonth)) {
    if (monthlyAcc[key]) continue
    monthlyAcc[key] = {
      year:         t.period_year,
      month:        t.period_month,
      revenue:      0, covers: 0, tips: 0, food_revenue: 0, bev_revenue: 0,
      staff_cost:   0, hours: 0, shifts: 0, late: 0, ob: 0,
      hasRev:       false,
      hasStaff:     false,
    }
  }

  const monthlyRows = Object.values(monthlyAcc).map((a: any) => {
    const tracker = trackerByMonth[`${a.year}-${a.month}`]

    // Revenue: POS wins if it saw anything (daily granularity > monthly rollup);
    //          otherwise fall back to Fortnox rollup.
    const trackerRev = Number(tracker?.revenue ?? 0)
    const revenue    = a.hasRev ? a.revenue : trackerRev
    const rev_source = a.hasRev ? 'pos' : (trackerRev > 0 ? 'fortnox' : 'none')

    // Staff cost: PK wins if present; otherwise Fortnox rollup.
    const trackerStaff = Number(tracker?.staff_cost ?? 0)
    const staff_cost   = a.hasStaff ? a.staff_cost : trackerStaff
    const cost_source  = a.hasStaff ? 'pk' : (trackerStaff > 0 ? 'fortnox' : 'none')

    const food_cost  = Number(tracker?.food_cost  ?? 0)
    const rent_cost  = Number(tracker?.rent_cost  ?? 0)
    const other_cost = Number(tracker?.other_cost ?? 0)
    const total_cost = staff_cost + food_cost + rent_cost + other_cost
    const net_profit = revenue - total_cost
    const margin_pct = revenue > 0 ? Math.round((net_profit / revenue) * 1000) / 10 : 0
    const labour_pct = revenue > 0 && staff_cost > 0 ? Math.round((staff_cost / revenue) * 1000) / 10 : null
    const food_pct   = revenue > 0 && food_cost  > 0 ? Math.round((food_cost  / revenue) * 1000) / 10 : null

    return {
      org_id:       orgId,
      business_id:  businessId,
      year:         a.year,
      month:        a.month,
      revenue:      Math.round(revenue),
      covers:       Math.round(a.covers),
      tips:         Math.round(a.tips),
      food_revenue: Math.round(a.food_revenue),
      bev_revenue:  Math.round(a.bev_revenue),
      staff_cost:   Math.round(staff_cost),
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
      rev_source,
      cost_source,
      updated_at:   new Date().toISOString(),
    }
  })

  let monthly_written = 0
  for (let i = 0; i < monthlyRows.length; i += BATCH) {
    const batch = monthlyRows.slice(i, i + BATCH)
    if (batch.length) {
      const { error } = await db.from('monthly_metrics').upsert(batch, { onConflict: 'business_id,year,month' })
      if (error) {
        console.error('[aggregate] monthly_metrics upsert FAILED', {
          business_id: businessId,
          batch_size:  batch.length,
          error:       error.message,
          code:        (error as any).code,
          details:     (error as any).details,
        })
        throw new Error(`monthly_metrics upsert failed: ${error.message}`)
      }
      monthly_written += batch.length
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

  let dept_written = 0
  for (let i = 0; i < deptRows.length; i += BATCH) {
    const batch = deptRows.slice(i, i + BATCH)
    if (batch.length) {
      const { error } = await db.from('dept_metrics').upsert(batch, { onConflict: 'business_id,dept_name,year,month' })
      if (error) {
        console.error('[aggregate] dept_metrics upsert FAILED', {
          business_id: businessId,
          batch_size:  batch.length,
          error:       error.message,
          code:        (error as any).code,
          details:     (error as any).details,
        })
        throw new Error(`dept_metrics upsert failed: ${error.message}`)
      }
      dept_written += batch.length
    }
  }

  // Return actual WRITTEN counts, not just the compute-intent counts.
  // Previously this returned `dailyRows.length` etc. even when upserts failed silently.
  return {
    daily_rows:   daily_written,
    monthly_rows: monthly_written,
    dept_rows:    dept_written,
  }
}

// ── Aggregate ALL data for a business (full rebuild) ──────────────────────────
// Used for initial setup or manual re-sync
export async function aggregateAll(orgId: string, businessId: string) {
  // Use a wide date range to cover all historical data
  return aggregateMetrics(orgId, businessId, '2020-01-01', '2030-12-31')
}
