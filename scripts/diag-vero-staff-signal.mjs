// scripts/diag-vero-staff-signal.mjs
//
// Standalone deep-dive on Vero's staff_logs as a forecast signal.
// Three questions:
//   1. Are scheduled hours a forward-looking signal? Compare scheduled
//      hours per shift_date to realised revenue on that date.
//   2. Is scheduled hours correlated with revenue at the weekday level?
//   3. Is there leakage between scheduled and logged that would make
//      it hard to use scheduled-only as a forward signal?

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error('Missing env'); process.exit(1) }
const db = createClient(url, key, { auth: { persistSession: false } })

const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

const recentDateFrom = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)

const staff = []
for (let pageFrom = 0; ; pageFrom += 1000) {
  const { data, error } = await db
    .from('staff_logs')
    .select('shift_date, estimated_salary, cost_actual, hours_worked, pk_log_url, pk_staff_url, staff_group')
    .eq('business_id', VERO)
    .gte('shift_date', recentDateFrom)
    .order('shift_date', { ascending: false })
    .range(pageFrom, pageFrom + 999)
  if (error) { console.error(error.message); process.exit(1) }
  if (!data || data.length === 0) break
  staff.push(...data)
  if (data.length < 1000) break
}

const daily = []
for (let pageFrom = 0; ; pageFrom += 1000) {
  const { data, error } = await db
    .from('daily_metrics')
    .select('date, revenue, covers')
    .eq('business_id', VERO)
    .gte('date', recentDateFrom)
    .order('date', { ascending: true })
    .range(pageFrom, pageFrom + 999)
  if (error) { console.error(error.message); process.exit(1) }
  if (!data || data.length === 0) break
  daily.push(...data)
  if (data.length < 1000) break
}

console.log()
console.log(`Vero staff signal audit — staff_logs rows: ${staff.length}, daily_metrics: ${daily.length}`)

// Group staff per shift_date
const staffByDate = new Map()
for (const s of staff) {
  if (!staffByDate.has(s.shift_date)) staffByDate.set(s.shift_date, { scheduled_hrs: 0, logged_hrs: 0, scheduled_cost: 0, logged_cost: 0, scheduled_shifts: 0, logged_shifts: 0 })
  const b = staffByDate.get(s.shift_date)
  const isScheduled = String(s.pk_log_url ?? '').includes('_scheduled')
  if (isScheduled) {
    b.scheduled_shifts++
    b.scheduled_hrs  += Number(s.hours_worked ?? 0)
    b.scheduled_cost += Number(s.estimated_salary ?? 0)
  } else {
    b.logged_shifts++
    b.logged_hrs  += Number(s.hours_worked ?? 0)
    b.logged_cost += Number(s.cost_actual ?? 0) || Number(s.estimated_salary ?? 0)
  }
}

const revByDate = new Map()
for (const d of daily) revByDate.set(d.date, Number(d.revenue ?? 0))

// Correlation: scheduled_hrs (from morning of) vs revenue (end of day)
// For trading days where revenue > 0, compute correlation between
// total_hrs (scheduled + logged) and revenue. Group by weekday too.
const points = []
for (const [date, s] of staffByDate) {
  const rev = revByDate.get(date) ?? 0
  if (rev <= 0) continue
  const totalHrs = s.scheduled_hrs + s.logged_hrs
  if (totalHrs <= 0) continue
  points.push({
    date,
    weekday: new Date(date + 'T00:00:00Z').getUTCDay(),
    scheduled_hrs: s.scheduled_hrs,
    logged_hrs: s.logged_hrs,
    total_hrs: totalHrs,
    revenue: rev,
    rev_per_hr: rev / totalHrs,
    scheduled_pct: s.scheduled_hrs / totalHrs,
  })
}

console.log()
console.log(`Trading-day samples with both staff + revenue: ${points.length}`)
console.log()

function corr(xs, ys) {
  const n = xs.length
  if (n < 3) return null
  const mx = xs.reduce((s, v) => s + v, 0) / n
  const my = ys.reduce((s, v) => s + v, 0) / n
  let num = 0, dx2 = 0, dy2 = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    dx2 += (xs[i] - mx) ** 2
    dy2 += (ys[i] - my) ** 2
  }
  if (dx2 === 0 || dy2 === 0) return null
  return num / Math.sqrt(dx2 * dy2)
}

const totalHrs = points.map(p => p.total_hrs)
const revenues = points.map(p => p.revenue)
const overall  = corr(totalHrs, revenues)
console.log(`Pearson correlation (total_hrs ↔ revenue), all days: ${overall?.toFixed(3) ?? '—'}`)

// Per-weekday correlation
const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
for (let wd = 0; wd < 7; wd++) {
  const slice = points.filter(p => p.weekday === wd)
  if (slice.length < 3) continue
  const c = corr(slice.map(p => p.total_hrs), slice.map(p => p.revenue))
  const meanRev = slice.reduce((s, p) => s + p.revenue, 0) / slice.length
  const meanHrs = slice.reduce((s, p) => s + p.total_hrs, 0) / slice.length
  console.log(`  ${days[wd]} (n=${slice.length}):  corr ${c?.toFixed(3) ?? '—'}   mean_rev ${Math.round(meanRev).toLocaleString('sv-SE').padStart(7)}   mean_hrs ${meanHrs.toFixed(1).padStart(5)}`)
}
console.log()

// Are scheduled hours alone a strong forward signal?
const schedOnly = points.filter(p => p.scheduled_hrs > 0)
if (schedOnly.length > 0) {
  const c = corr(schedOnly.map(p => p.scheduled_hrs), schedOnly.map(p => p.revenue))
  console.log(`Pearson correlation (SCHEDULED_HRS only ↔ revenue), n=${schedOnly.length}: ${c?.toFixed(3) ?? '—'}`)
  console.log(`  → if this is > 0.5, schedules ARE a strong forward-looking signal we can use.`)
}

// How many trading days have schedules entered for tomorrow + onwards?
const today = new Date().toISOString().slice(0, 10)
const futureDates = [...staffByDate.keys()].filter(d => d > today).sort()
console.log()
console.log(`Days with schedules entered for the future (tomorrow+): ${futureDates.length}`)
if (futureDates.length > 0) {
  for (const d of futureDates.slice(0, 10)) {
    const b = staffByDate.get(d)
    console.log(`  ${d}: ${b.scheduled_shifts} shifts, ${b.scheduled_hrs.toFixed(1)} hrs, ${Math.round(b.scheduled_cost).toLocaleString('sv-SE')} cost`)
  }
}
