// scripts/diag-prediction-input-audit.mjs
//
// Full audit of every data source available for the forecaster.
// Reads the schema, surveys row counts + coverage windows per table,
// then groups them into "currently used by lib/forecast/daily.ts"
// vs "available but unused." Tells us what the unrealised signal is.

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error('Missing env'); process.exit(1) }
const db = createClient(url, key, { auth: { persistSession: false } })

const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

// Tables grouped by the signal class they carry. For each we'll
// show: row count for Vero, earliest + latest record, and the
// notable columns.

const TABLES = [
  // ── Currently USED by lib/forecast/daily.ts ───────────────────
  { table: 'daily_metrics',          date: 'date',          used: true,  notes: 'Recency-weighted weekday baseline + YoY same-weekday lookup' },
  { table: 'monthly_metrics',        date: null,            used: true,  notes: 'YoY same-month anchor + trailing-12m growth (v1.6.0 damper)' },
  { table: 'weather_forecast',       date: 'date',          used: true,  notes: 'Weather bucket, lift %' },
  { table: 'holidays',               date: 'date',          used: true,  notes: 'Holiday class (high/low impact)' },

  // ── Available but UNUSED by the forecaster ────────────────────
  { table: 'staff_logs',             date: 'shift_date',    used: false, notes: 'SCHEDULED + LOGGED shifts. Forward-looking labour signal' },
  { table: 'revenue_logs',           date: 'revenue_date',  used: false, notes: 'Per-department revenue (pk_<dept>) — granular activity patterns' },
  { table: 'tracker_data',           date: null,            used: false, notes: 'Fortnox P&L: revenue + food/staff/other cost + margin per month' },
  { table: 'tracker_line_items',     date: null,            used: false, notes: 'Per-account spend (BAS subcategory). Activity-cost ratios' },
  { table: 'departments',            date: null,            used: false, notes: 'Per-dept config, opening hours' },
  { table: 'businesses',             date: null,            used: 'partial', notes: 'opening_days only. Could use: location, lat/lon, capacity, seats' },
  { table: 'reservations',           date: null,            used: false, notes: 'Booking system tables — exists?' },
  { table: 'events_local',           date: 'event_date',    used: false, notes: 'Ticketmaster events (M-something) — concerts/sports near Vero' },
  { table: 'alerts',                 date: null,            used: 'partial', notes: 'Confirmed anomalies filter baseline contamination' },
  { table: 'fortnox_vouchers_cache', date: 'transaction_date', used: false, notes: 'Daily voucher rows. Cash flow timing, supplier payment patterns' },
  { table: 'pos_sales',              date: null,            used: false, notes: 'POS-recipe mapping output (M097). Per-dish daily sales' },
  { table: 'school_holidays',        date: null,            used: true,  notes: 'In daily.ts as school_holiday_pct' },
]

console.log()
console.log(`Prediction input audit — surveying every data source for Vero`)
console.log()

const usedRows = []
const unusedRows = []
const missingRows = []

for (const t of TABLES) {
  try {
    let q = db.from(t.table).select('*', { count: 'exact', head: true }).eq('business_id', VERO)
    const { count, error } = await q
    if (error && error.message.includes('does not exist')) {
      missingRows.push({ ...t, count: null, status: 'table missing' })
      continue
    }
    if (error) {
      missingRows.push({ ...t, count: null, status: `error: ${error.message.slice(0, 60)}` })
      continue
    }

    // Get earliest + latest date if the table has a date column
    let earliest = null, latest = null
    if (t.date) {
      const { data: e } = await db.from(t.table).select(t.date).eq('business_id', VERO).order(t.date, { ascending: true }).limit(1).maybeSingle()
      const { data: l } = await db.from(t.table).select(t.date).eq('business_id', VERO).order(t.date, { ascending: false }).limit(1).maybeSingle()
      earliest = e?.[t.date]?.slice?.(0, 10) ?? null
      latest   = l?.[t.date]?.slice?.(0, 10) ?? null
    }

    const row = { ...t, count, earliest, latest }
    if (t.used === true) usedRows.push(row)
    else                 unusedRows.push(row)
  } catch (e) {
    missingRows.push({ ...t, count: null, status: `threw: ${String(e?.message ?? e).slice(0, 60)}` })
  }
}

const fmt = (n) => n == null ? '—' : Number(n).toLocaleString('sv-SE').padStart(8)

console.log('── USED by lib/forecast/daily.ts ─────────────────────────')
console.log('  Table                   rows    earliest    latest      notes')
for (const r of usedRows) {
  console.log(`  ${r.table.padEnd(22)} ${fmt(r.count)}   ${(r.earliest ?? '—').padEnd(11)} ${(r.latest ?? '—').padEnd(11)} ${r.notes}`)
}
console.log()

console.log('── AVAILABLE but NOT used by the forecaster ─────────────')
console.log('  Table                   rows    earliest    latest      notes')
for (const r of unusedRows) {
  if (r.count === 0) continue
  console.log(`  ${r.table.padEnd(22)} ${fmt(r.count)}   ${(r.earliest ?? '—').padEnd(11)} ${(r.latest ?? '—').padEnd(11)} ${r.notes}`)
}
console.log()

console.log('── EMPTY or MISSING ─────────────────────────────────────')
for (const r of [...unusedRows.filter(r => r.count === 0), ...missingRows]) {
  console.log(`  ${r.table.padEnd(22)}   ${r.status ?? 'empty'}   ${r.notes}`)
}
console.log()

// ── Deep-dive on the unused sources with high signal value ────
console.log('── Deep dive on high-value unused tables for Vero ────────')
console.log()

// staff_logs — scheduled vs logged distribution
const recentDateFrom = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10)
const { data: staffSample } = await db
  .from('staff_logs')
  .select('shift_date, estimated_salary, cost_actual, work_time, pk_log_url')
  .eq('business_id', VERO)
  .gte('shift_date', recentDateFrom)
  .order('shift_date', { ascending: false })
  .limit(2000)
if (staffSample && staffSample.length > 0) {
  const byDate = new Map()
  for (const s of staffSample) {
    if (!byDate.has(s.shift_date)) byDate.set(s.shift_date, { scheduled: 0, logged: 0, scheduled_cost: 0, logged_cost: 0, scheduled_work: 0, logged_work: 0 })
    const b = byDate.get(s.shift_date)
    const isScheduled = String(s.pk_log_url ?? '').includes('_scheduled')
    if (isScheduled) {
      b.scheduled++
      b.scheduled_cost += Number(s.estimated_salary ?? 0)
      b.scheduled_work += Number(s.work_time ?? 0)
    } else {
      b.logged++
      b.logged_cost += Number(s.cost_actual ?? 0) || Number(s.estimated_salary ?? 0)
      b.logged_work += Number(s.work_time ?? 0)
    }
  }
  const dates = [...byDate.keys()].sort().reverse()
  console.log('staff_logs — last 60 days, per-date scheduled vs logged:')
  console.log('  Date         sched_shifts  sched_cost  sched_hrs   logged_shifts  logged_cost  logged_hrs')
  for (const d of dates.slice(0, 15)) {
    const b = byDate.get(d)
    console.log(`  ${d}    ${String(b.scheduled).padStart(12)}  ${Math.round(b.scheduled_cost).toLocaleString('sv-SE').padStart(10)}  ${b.scheduled_work.toFixed(1).padStart(8)}   ${String(b.logged).padStart(13)}  ${Math.round(b.logged_cost).toLocaleString('sv-SE').padStart(11)}  ${b.logged_work.toFixed(1).padStart(9)}`)
  }
  console.log()
}

// revenue_logs — provider mix
const { data: revSample } = await db
  .from('revenue_logs')
  .select('revenue_date, provider, revenue, covers')
  .eq('business_id', VERO)
  .gte('revenue_date', recentDateFrom)
  .limit(2000)
if (revSample && revSample.length > 0) {
  const byProvider = new Map()
  for (const r of revSample) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, { rows: 0, rev: 0, covers: 0 })
    const b = byProvider.get(r.provider)
    b.rows++
    b.rev += Number(r.revenue ?? 0)
    b.covers += Number(r.covers ?? 0)
  }
  console.log('revenue_logs — last 60 days, provider mix:')
  console.log('  Provider                         rows   total_rev   total_covers')
  for (const [p, b] of [...byProvider.entries()].sort((a, b) => b[1].rev - a[1].rev)) {
    console.log(`  ${String(p ?? '?').padEnd(30)}   ${String(b.rows).padStart(4)}  ${Math.round(b.rev).toLocaleString('sv-SE').padStart(12)}  ${b.covers.toLocaleString('sv-SE').padStart(12)}`)
  }
  console.log()
}

// tracker_data — per-month financial state
const { data: trackerSample } = await db
  .from('tracker_data')
  .select('period_year, period_month, revenue, food_cost, staff_cost, other_cost, net_profit, margin_pct, dine_in_revenue, takeaway_revenue, alcohol_revenue, source, created_via, is_provisional')
  .eq('business_id', VERO)
  .or('is_provisional.is.null,is_provisional.eq.false')
  .order('period_year', { ascending: false })
  .order('period_month', { ascending: false })
  .limit(18)
if (trackerSample && trackerSample.length > 0) {
  console.log('tracker_data — last 18 closed months (Fortnox P&L):')
  console.log('  Period   revenue   dine_in   takeaway  alcohol   food_cost staff_cost other_cost  margin%')
  for (const t of trackerSample.reverse()) {
    const ym = `${t.period_year}-${String(t.period_month).padStart(2, '0')}`
    console.log(`  ${ym}   ${Math.round(Number(t.revenue ?? 0)).toLocaleString('sv-SE').padStart(8)}  ${Math.round(Number(t.dine_in_revenue ?? 0)).toLocaleString('sv-SE').padStart(8)}  ${Math.round(Number(t.takeaway_revenue ?? 0)).toLocaleString('sv-SE').padStart(8)}  ${Math.round(Number(t.alcohol_revenue ?? 0)).toLocaleString('sv-SE').padStart(7)}  ${Math.round(Number(t.food_cost ?? 0)).toLocaleString('sv-SE').padStart(9)}  ${Math.round(Number(t.staff_cost ?? 0)).toLocaleString('sv-SE').padStart(9)}  ${Math.round(Number(t.other_cost ?? 0)).toLocaleString('sv-SE').padStart(9)}  ${Number(t.margin_pct ?? 0).toFixed(1).padStart(6)}`)
  }
  console.log()
}
