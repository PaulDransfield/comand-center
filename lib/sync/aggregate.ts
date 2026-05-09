// @ts-nocheck
// lib/sync/aggregate.ts
// Pre-compute summary tables from raw data
// Called after every sync to keep daily_metrics, monthly_metrics, dept_metrics up to date
//
// Source priority:
//   Revenue:    POS (revenue_logs) > Fortnox (tracker_data, source='fortnox') > manual (tracker_data, source='manual')
//   Staff cost: PK actual (cost_actual) > PK estimated > Fortnox (7xxx) > manual
//   Food cost:  Fortnox (4xxx) > manual (tracker_data)
//   Other cost: Fortnox > manual
//
// Important: a tracker_data row with source='manual' NEVER outranks POS
// for revenue, regardless of POS completeness. Manual is a baseline only —
// used when POS has zero days for the month. Pre-FIXES.md §0x, an early
// onboarding manual row of 115 k blocked the aggregator from surfacing
// 1.6 M of real April POS data because the 90 % completeness gate fell
// back to "trackerRev > 0 → Fortnox wins" without checking source.

import { createAdminClient } from '@/lib/supabase/server'

// ── Per-business advisory lock around aggregateMetrics ───────────────────────
//
// FIXES.md §0l surfaced a race where two concurrent paths (per-sync aggregate
// inside runSync + post-cron aggregate sweep) both rebuild daily_metrics for
// the same business at the same time, and the loser overwrites with stale data.
// The §0l fix mitigates by skipping per-sync aggregate when 0 rows synced;
// this lock is the structural cure — only one aggregateMetrics call per
// business runs at a time, others skip.
//
// Lock is held in the `aggregation_lock` table (M027). Stale rows >60 s old
// are stolen on the assumption the previous worker crashed. If the lock
// table doesn't exist (M027 not applied), we fall back to no-lock behaviour
// and log a structured error so Vercel surfaces the drift.

const LOCK_STALE_MS = 60_000

async function acquireAggregationLock(db: any, businessId: string, lockId: string): Promise<boolean | 'no_table'> {
  // Attempt insert. PK violation means another worker holds the lock.
  const { error: insErr } = await db.from('aggregation_lock').insert({
    business_id: businessId,
    locked_at:   new Date().toISOString(),
    locked_by:   lockId,
  })
  if (!insErr) return true

  // Distinguish "table missing" (M027 not applied) from "lock held".
  const code = insErr.code ?? ''
  const msg  = (insErr.message ?? '').toLowerCase()
  if (msg.includes('aggregation_lock') && msg.includes('does not exist')) return 'no_table'

  // 23505 = unique_violation on the PK → lock held. Check staleness.
  if (code !== '23505' && !msg.includes('duplicate key')) {
    // Some other error — surface it but don't block the aggregate.
    console.error('[aggregate] unexpected lock error', insErr)
    return false
  }

  const { data: existing } = await db
    .from('aggregation_lock')
    .select('locked_at, locked_by')
    .eq('business_id', businessId)
    .maybeSingle()

  if (!existing) return false  // race — someone deleted between insert + select; bail this round
  const ageMs = Date.now() - new Date(existing.locked_at).getTime()
  if (ageMs < LOCK_STALE_MS) return false  // fresh — another worker owns it

  // Stale — steal the lock by overwriting locked_by + timestamp.
  const { error: stealErr } = await db
    .from('aggregation_lock')
    .update({ locked_by: lockId, locked_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('locked_by', existing.locked_by)  // optimistic: only steal if previous owner unchanged
  if (stealErr) return false
  return true
}

async function releaseAggregationLock(db: any, businessId: string, lockId: string) {
  // Only delete if WE still own it — protects against the case where a
  // long-running aggregate got its lock stolen by a stale-lock sweep.
  await db.from('aggregation_lock')
    .delete()
    .eq('business_id', businessId)
    .eq('locked_by', lockId)
}

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

  // Acquire per-business lock. If held by another worker, skip — they'll do
  // the same work in a moment. If the lock table is missing (M027 pending)
  // we proceed without locking and log it loudly.
  const lockId = `${process.env.VERCEL_DEPLOYMENT_ID ?? 'local'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const acquired = await acquireAggregationLock(db, businessId, lockId)
  if (acquired === 'no_table') {
    const { log } = await import('@/lib/log/structured')
    log.error('aggregation_lock table missing', {
      route: 'sync/aggregate',
      hint:  'M027-AGGREGATION-LOCK.sql may not be applied — run it in Supabase SQL Editor',
    })
    // Continue without lock — preserves prior behaviour rather than blocking.
  } else if (!acquired) {
    console.log('[aggregate] skipped — lock held', { business_id: businessId })
    return { skipped: true, daily_rows: 0, monthly_rows: 0, dept_rows: 0 }
  }

  try {

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

  // Earliest staff_log date for this business — used to decide whether PK
  // covers a given period or was connected mid-period. If oldest is, say,
  // 2026-04-19 and we're aggregating March, PK's "staff cost" for March is
  // structurally partial (just whatever PK could backfill at connect time).
  // Using that as the canonical staff_cost would silently distort labour %
  // for every period before the integration came online.
  // Rosali March 2026 surfaced this: PK reported 386k staff vs Fortnox's
  // 1.15M, producing a fictional 13.6% labour ratio.
  const { data: oldestStaffRow } = await db
    .from('staff_logs')
    .select('shift_date')
    .eq('org_id', orgId)
    .eq('business_id', businessId)
    .order('shift_date', { ascending: true })
    .limit(1)
  const oldestStaffDate: string | null = oldestStaffRow?.[0]?.shift_date ?? null

  // Owner override: when the PK integration row has
  // config.canonical_for_staff_cost=true, the agreement gate is
  // INVERTED — PK wins even when its total disagrees with Fortnox by
  // >30 %. Use case: Fortnox PDF is stale (last filed 6 months ago)
  // and PK is the live source of truth. Without this override, the
  // disagreement check forces stale Fortnox over fresh PK.
  // Stored on integrations.config (existing JSONB column) so it lives
  // with the credential row it concerns.
  const { data: pkIntegRow } = await db
    .from('integrations')
    .select('config')
    .eq('org_id', orgId)
    .eq('business_id', businessId)
    .eq('provider', 'personalkollen')
    .maybeSingle()
  const pkIsCanonical: boolean = pkIntegRow?.config?.canonical_for_staff_cost === true

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
        .select('shift_date, cost_actual, estimated_salary, hours_worked, staff_group, is_late, ob_supplement_kr, pk_staff_url, pk_log_url')
        .eq('org_id', orgId).eq('business_id', businessId)
        .gte('shift_date', fromDate)
        .or('cost_actual.gt.0,estimated_salary.gt.0')
        // Include scheduled rows (pk_log_url ending in '_scheduled') — they
        // carry estimated_salary for shifts that haven't been logged yet,
        // which is how today's projected staff cost shows up before shifts
        // finish. Dedup against logged rows in-memory below so a shift that
        // moves from scheduled → logged later in the day doesn't double-count.
        // Pre-2026-05-08 the aggregator hard-filtered scheduled rows, so
        // today's daily_metrics.staff_cost stayed 0 all day until shifts
        // closed in PK.
        .order('shift_date', { ascending: true })
        .range(lo, hi)
    ),
    db.from('tracker_data')
      // depreciation/financial/alcohol_cost added in M028 (FIXES.md §0n).
      // dine_in_revenue/takeaway_revenue/alcohol_revenue added in M029
      // (FIXES.md §0o). All read here so downstream consumers (memo,
      // budget, scheduling AI prompts) can reach them through monthly_metrics
      // without re-summing line items.
      // is_provisional filter (M062): exclude not-yet-closed periods so
      // monthly_metrics — and everything downstream — sees only committed
      // P&L data. The current month + prior-month-before-15th are flagged
      // by the writer; including them would muddy YoY trends and AI prompts
      // with partial data (revenue=0 because Z-reports not booked yet,
      // staff_cost=0 because salary books on the 25th).
      .select('period_year, period_month, revenue, dine_in_revenue, takeaway_revenue, alcohol_revenue, food_cost, alcohol_cost, staff_cost, rent_cost, other_cost, depreciation, financial, net_profit, source, is_provisional')
      .eq('business_id', businessId)
      .gte('period_year', parseInt(fromDate.slice(0, 4)))
      .lte('period_year', parseInt(toDate.slice(0, 4)))
      .or('is_provisional.is.null,is_provisional.eq.false'),
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
  // Two classes of provider write to revenue_logs:
  //
  //   • Per-department slices (pk_<dept>, inzii_<dept>)  — these sum
  //     legitimately across departments to give the day's full revenue.
  //   • Full-business aggregates (personalkollen, onslip, ancon, swess)
  //     — each represents the FULL day's revenue. Only one is correct
  //     for a given date; summing two is a double-count.
  //
  // The PRE-2026-05-03 dedup only handled the personalkollen case. Any
  // business that had Personalkollen + a separate POS connector (or
  // pk_* per-dept rows + a non-PK aggregate) saw revenue inflated 2×
  // every aggregator run. Vero March 2026 surfaced the bug: PK reported
  // 1.42M kr, monthly_metrics held 2.84M kr, exact 2× signature.
  //
  // New rule, applied per-date:
  //   1. If the date has pk_* rows  → use ONLY pk_* (drop ALL aggregates)
  //   2. Else if inzii_* rows       → use ONLY inzii_* (drop ALL aggregates)
  //   3. Else                       → keep at most ONE aggregate provider
  //                                   per date, in priority order
  //                                   (personalkollen > onslip > ancon > swess)
  //   4. Unknown providers          → kept (defensive — better to count
  //                                   than to silently drop)
  //
  // Per-date filtering avoids the regression that bit us when a global
  // `hasDeptRows` check zeroed yesterday's `personalkollen`-only rows
  // because some older date in the window had pk_* rows.
  const FULL_AGGREGATE_PROVIDERS = ['personalkollen', 'onslip', 'ancon', 'swess'] as const
  const FULL_AGGREGATE_PRIORITY  = new Map(FULL_AGGREGATE_PROVIDERS.map((p, i) => [p as string, i]))

  const datesWithPkRows    = new Set<string>()
  const datesWithInziiRows = new Set<string>()
  for (const r of rawRevLogs) {
    const p = r.provider ?? ''
    if (p.startsWith('pk_'))    datesWithPkRows.add(r.revenue_date)
    if (p.startsWith('inzii_')) datesWithInziiRows.add(r.revenue_date)
  }

  // Pick the highest-priority aggregate for each date that has one. If
  // a date has both 'personalkollen' and 'ancon' rows (rare but seen),
  // personalkollen wins by index.
  const chosenAggregateByDate = new Map<string, string>()
  for (const r of rawRevLogs) {
    const p = r.provider ?? ''
    if (!FULL_AGGREGATE_PRIORITY.has(p)) continue
    const date = r.revenue_date
    const existing = chosenAggregateByDate.get(date)
    if (!existing || FULL_AGGREGATE_PRIORITY.get(p)! < FULL_AGGREGATE_PRIORITY.get(existing)!) {
      chosenAggregateByDate.set(date, p)
    }
  }

  let dedup_dropped = 0
  const revLogs = rawRevLogs.filter((r: any) => {
    const p = r.provider ?? ''
    // Per-dept slices always kept — they're meant to sum.
    if (p.startsWith('pk_') || p.startsWith('inzii_')) return true
    if (FULL_AGGREGATE_PRIORITY.has(p)) {
      // If per-dept rows exist for this date, drop ALL aggregates.
      if (datesWithPkRows.has(r.revenue_date) || datesWithInziiRows.has(r.revenue_date)) {
        dedup_dropped++
        return false
      }
      // Otherwise keep only the priority-winning aggregate for this date.
      const kept = chosenAggregateByDate.get(r.revenue_date) === p
      if (!kept) dedup_dropped++
      return kept
    }
    // Unknown provider — keep.
    return true
  })

  if (dedup_dropped > 0) {
    console.log('[aggregate] dedup dropped', { business_id: businessId, dropped: dedup_dropped, kept: revLogs.length })
  }

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

  // Dedupe: if a (staff, date) has BOTH a logged row and a scheduled row,
  // keep the logged one. PK promotes scheduled → logged when a shift
  // closes; until then, the scheduled row is the only source of cost data
  // for that staff/date. Without this dedupe, a shift that flips during
  // the day would double-count the second time the aggregator runs.
  const isScheduled = (s: any) => typeof s.pk_log_url === 'string' && s.pk_log_url.endsWith('_scheduled')
  const hasLogged   = new Set<string>()
  for (const s of staffLogs) {
    if (!isScheduled(s) && s.pk_staff_url && s.shift_date) {
      hasLogged.add(`${s.pk_staff_url}::${s.shift_date}`)
    }
  }

  // Aggregate staff cost by date
  const dailyStaff: Record<string, any> = {}
  for (const s of staffLogs) {
    if (isScheduled(s) && s.pk_staff_url && hasLogged.has(`${s.pk_staff_url}::${s.shift_date}`)) {
      continue  // logged sibling exists — skip the scheduled twin
    }
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
  //
  // FIXES §0uu (2026-04-28): build monthlyAcc from the FULL month's
  // daily_metrics in DB, NOT from this run's narrow dailyRows. Otherwise
  // a sync called with a 7-day window (catchup-sync's from7) overwrites
  // monthly_metrics.revenue with only-the-last-7-days, wiping the
  // full-month value the previous wider sync wrote. Symptom: April 2026
  // dropped from 812k (correct, full month) to 268k (last 7 days only)
  // overnight when catchup-sync ran. Re-aggregate fixed it temporarily,
  // then the next catchup-sync wiped it again.
  const monthsTouched = new Set<string>()
  for (const r of dailyRows) monthsTouched.add(r.date.slice(0, 7))  // 'YYYY-MM'
  for (const t of trackerRows) {
    if (t.period_month && t.period_month >= 1 && t.period_month <= 12) {
      monthsTouched.add(`${t.period_year}-${String(t.period_month).padStart(2, '0')}`)
    }
  }
  // Re-fetch FULL month of daily_metrics for every touched month. Uses the
  // rows we just upserted plus any earlier days that aren't in this run's
  // window. Cost: 1 query per touched month (typically 1–3 months).
  const fullMonthDailyRows: any[] = []
  for (const ym of monthsTouched) {
    const [yStr, mStr] = ym.split('-')
    const y = parseInt(yStr), m = parseInt(mStr)
    if (!y || !m) continue
    const lastDay = new Date(y, m, 0).getDate()
    const monthFrom = `${yStr}-${mStr}-01`
    const monthTo   = `${yStr}-${mStr}-${String(lastDay).padStart(2, '0')}`
    const { data, error } = await db
      .from('daily_metrics')
      .select('date, revenue, covers, tips, food_revenue, bev_revenue, staff_cost, hours_worked, shifts, late_shifts, ob_supplement')
      .eq('org_id', orgId)
      .eq('business_id', businessId)
      .gte('date', monthFrom)
      .lte('date', monthTo)
    if (error) {
      console.warn('[aggregate] full-month daily fetch failed', { ym, error: error.message })
      continue
    }
    if (data) fullMonthDailyRows.push(...data)
  }

  const monthlyAcc: Record<string, any> = {}
  for (const row of fullMonthDailyRows) {
    const y = parseInt(row.date.slice(0, 4))
    const m = parseInt(row.date.slice(5, 7))
    const key = `${y}-${m}`
    if (!monthlyAcc[key]) monthlyAcc[key] = {
      year: y, month: m,
      revenue: 0, covers: 0, tips: 0, food_revenue: 0, bev_revenue: 0,
      staff_cost: 0, hours: 0, shifts: 0, late: 0, ob: 0,
      hasRev: false, hasStaff: false,
      // Track distinct calendar dates with non-zero revenue. Used to
      // detect partial-month POS coverage (e.g. PK integration added
      // mid-month). See FIXES.md §0r — without this signal, partial POS
      // revenue would override full Fortnox revenue and produce the
      // "Vero Nov 2025 = -137 % margin" symptom.
      daysWithRevenue: new Set<string>(),
    }
    const a = monthlyAcc[key]
    // Coerce — Supabase returns numeric columns as strings (see toNum
    // helper higher in this file). fullMonthDailyRows came from a fresh
    // SELECT so all fields arrive as strings; without coercion the
    // += operator concatenates and Math.round on the result returns NaN
    // → the upsert lands as 0. Same class of bug as the daily upsert
    // had pre-fix.
    const revN = Number(row.revenue      ?? 0) || 0
    const cstN = Number(row.staff_cost   ?? 0) || 0
    a.revenue      += revN
    a.covers       += Number(row.covers       ?? 0) || 0
    a.tips         += Number(row.tips         ?? 0) || 0
    a.food_revenue += Number(row.food_revenue ?? 0) || 0
    a.bev_revenue  += Number(row.bev_revenue  ?? 0) || 0
    a.staff_cost   += cstN
    a.hours        += Number(row.hours_worked ?? 0) || 0
    a.shifts       += Number(row.shifts       ?? 0) || 0
    a.late         += Number(row.late_shifts  ?? 0) || 0
    a.ob           += Number(row.ob_supplement?? 0) || 0
    if (revN > 0) {
      a.hasRev = true
      a.daysWithRevenue.add(row.date)
    }
    if (cstN > 0) a.hasStaff = true
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
      year:           t.period_year,
      month:          t.period_month,
      revenue:        0, covers: 0, tips: 0, food_revenue: 0, bev_revenue: 0,
      staff_cost:     0, hours: 0, shifts: 0, late: 0, ob: 0,
      hasRev:         false,
      hasStaff:       false,
      daysWithRevenue: new Set<string>(),
    }
  }

  // POS-revenue completeness threshold: at least 90 % of calendar days
  // must have non-zero revenue for POS to be considered the authoritative
  // source over Fortnox. Below 90 %, POS is treated as PARTIAL and we
  // prefer Fortnox's full-month rollup (avoids the Vero Nov 2025 bug
  // where 9 days of POS data overrode the full-month Fortnox figure).
  const POS_COMPLETE_THRESHOLD = 0.90

  const monthlyRows = Object.values(monthlyAcc).map((a: any) => {
    const tracker = trackerByMonth[`${a.year}-${a.month}`]

    // Calendar days in this (year, month). new Date(y, m, 0) returns the
    // last day of the previous month — passing m gives us the last day of
    // the m-th month (1-indexed), which is the day count.
    const calendarDays = new Date(a.year, a.month, 0).getDate()
    const pos_days_with_revenue = a.daysWithRevenue.size
    const posCompletenessPct = calendarDays > 0 ? pos_days_with_revenue / calendarDays : 0
    const posIsComplete = posCompletenessPct >= POS_COMPLETE_THRESHOLD

    // Revenue source priority:
    //   1. Manual tracker_data NEVER outranks POS (FIXES §0x). If POS has
    //      any days for the month, POS wins — manual is a baseline only.
    //   2. POS if it covered ≥90 % of the month (complete)
    //   3. Fortnox if POS is partial AND Fortnox has data
    //   4. POS partial if no Fortnox data
    //   5. None
    const trackerRev      = Number(tracker?.revenue ?? 0)
    const trackerIsManual = tracker?.source === 'manual'
    let revenue: number
    let rev_source: string
    if (trackerIsManual && a.hasRev) {
      // Manual + any POS days → POS wins, regardless of completeness.
      // Closes the "stale onboarding entry blocks live POS" footgun.
      revenue = a.revenue
      rev_source = posIsComplete ? 'pos' : 'pos_partial'
    } else if (a.hasRev && (posIsComplete || trackerRev === 0)) {
      revenue = a.revenue
      rev_source = posIsComplete ? 'pos' : 'pos_partial'
    } else if (trackerRev > 0) {
      revenue = trackerRev
      rev_source = 'fortnox'
    } else if (a.hasRev) {
      revenue = a.revenue
      rev_source = 'pos_partial'
    } else {
      revenue = 0
      rev_source = 'none'
    }

    // Staff cost priority — pre-2026-05-03 the logic was "PK wins whenever
    // PK has any staff data", which broke in two ways:
    //   (a) PK connected mid-period → PK has partial backfill → silently
    //       overrode the complete Fortnox figure
    //   (b) PK historical backfill is structurally incomplete (only some
    //       workplaces / departments) → PK has rows for ALL period dates
    //       but the totals are far below Fortnox
    //
    // Rosali March 2026 case: oldest PK staff date is 2022-09-01 so a
    // simple "predates the period" check returns true, but PK staff total
    // is 386k vs Fortnox's 1.15M (33%) — clearly incomplete.
    //
    // New rule, two-signal:
    //   - Coverage: oldest PK staff date predates the period start (PK
    //     was running for at least the start of the period)
    //   - Agreement: when Fortnox ALSO has staff data, PK is within 30%
    //     of it (small differences from accruals / employer contributions
    //     / owner draws are normal; > 30% gap means a workplace or
    //     department isn't mapped)
    //
    // Order of preference:
    //   1. PK when both signals agree (or Fortnox has nothing to compare)
    //   2. Fortnox when present (PK partial OR PK disagrees materially)
    //   3. PK partial as last resort if Fortnox is also empty
    //   4. None
    //
    // The cost_source field surfaces the decision so /api/tracker and the
    // Performance page can show it (and a future "data confidence" badge
    // can render the partial states differently).
    const trackerStaff   = Number(tracker?.staff_cost ?? 0)
    const periodStartIso = `${a.year}-${String(a.month).padStart(2, '0')}-01`
    const pkPredatesPeriod = a.hasStaff && oldestStaffDate != null && oldestStaffDate <= periodStartIso
    const PK_FORTNOX_AGREEMENT_MIN = 0.70   // PK ≥ 70 % of Fortnox = "agrees"
    const PK_FORTNOX_AGREEMENT_MAX = 1.30   // PK ≤ 130 % of Fortnox = "agrees"
    const pkVsFortnoxRatio = (a.hasStaff && trackerStaff > 0)
      ? a.staff_cost / trackerStaff
      : null
    const pkAgreesWithFortnox =
      pkVsFortnoxRatio === null
      || (pkVsFortnoxRatio >= PK_FORTNOX_AGREEMENT_MIN && pkVsFortnoxRatio <= PK_FORTNOX_AGREEMENT_MAX)

    let staff_cost: number
    let cost_source: string
    // Override path first: when the owner has flipped PK to canonical,
    // PK wins as long as it has rows for the period — disagreement and
    // coverage gates are bypassed. Surfaced via 'pk_canonical' so the
    // disagreement alert pipeline still records the override decision.
    if (a.hasStaff && pkIsCanonical) {
      staff_cost  = a.staff_cost
      cost_source = 'pk_canonical'
    } else if (a.hasStaff && pkPredatesPeriod && pkAgreesWithFortnox) {
      staff_cost  = a.staff_cost
      cost_source = 'pk'
    } else if (trackerStaff > 0) {
      // Fortnox has data and PK either doesn't cover or disagrees materially.
      staff_cost  = trackerStaff
      cost_source = a.hasStaff
        ? (pkPredatesPeriod ? 'fortnox_pk_disagrees' : 'fortnox_pk_partial')
        : 'fortnox'
    } else if (a.hasStaff) {
      // No Fortnox to fall back to — use PK with a partial flag.
      staff_cost  = a.staff_cost
      cost_source = pkPredatesPeriod ? 'pk' : 'pk_partial'
    } else {
      staff_cost  = 0
      cost_source = 'none'
    }

    const food_cost    = Number(tracker?.food_cost    ?? 0)
    const rent_cost    = Number(tracker?.rent_cost    ?? 0)
    const other_cost   = Number(tracker?.other_cost   ?? 0)
    const depreciation = Number(tracker?.depreciation ?? 0)
    // financial is signed: negative = net interest expense, positive = net
    // interest income. See lib/finance/conventions.ts.
    const financial    = Number(tracker?.financial    ?? 0)
    // total_cost = positive cost components only (excludes signed financial).
    // Used for cost/revenue ratios where mixing in net interest income
    // would be misleading.
    const total_cost = staff_cost + food_cost + rent_cost + other_cost + depreciation
    // net_profit applies the canonical formula from lib/finance/conventions.ts.
    // PRIOR BUG (FIXES.md §0n): aggregator omitted depreciation entirely and
    // monthly_metrics.net_profit was overstated by exactly the depreciation
    // amount on every Fortnox-sourced month.
    const net_profit = revenue - total_cost + financial
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
      // M031: distinct calendar days where POS had non-zero revenue.
      // Used by /api/tracker to detect partial-month POS coverage and
      // surface the gap to operators if needed.
      pos_days_with_revenue,
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
  // Group staff by department + month. Same scheduled/logged dedupe as the
  // daily aggregation above — drop a scheduled row when its logged sibling
  // exists for the same (staff, date).
  const deptAcc: Record<string, any> = {}
  for (const s of staffLogs) {
    const dept = s.staff_group
    if (!dept) continue
    if (isScheduled(s) && s.pk_staff_url && hasLogged.has(`${s.pk_staff_url}::${s.shift_date}`)) {
      continue
    }
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
  } finally {
    if (acquired === true) {
      await releaseAggregationLock(db, businessId, lockId)
    }
  }
}

// ── Aggregate ALL data for a business (full rebuild) ──────────────────────────
// Used for initial setup or manual re-sync
export async function aggregateAll(orgId: string, businessId: string) {
  // Use a wide date range to cover all historical data
  return aggregateMetrics(orgId, businessId, '2020-01-01', '2030-12-31')
}
