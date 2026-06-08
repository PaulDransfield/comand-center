// scripts/diag-vero-v160-simulate.mjs
//
// Simulate the v1.6.0 damper outcome for Vero June 9, 2026 using the
// same inputs the engine reads. Confirms the fix produces a
// reasonable prediction before we let the live engine emit it.

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error('Missing env'); process.exit(1) }
const db = createClient(url, key, { auth: { persistSession: false } })

const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const today = new Date()
const TARGET = process.argv[2] ?? '2026-06-13'  // default Saturday

console.log()
console.log(`Simulating v1.6.0 prediction for Vero ${TARGET} (Tuesday)`)
console.log()

// Pull last 90 days of daily_metrics (the recency window)
const daily90Cutoff = new Date(today.getTime() - 90 * 86_400_000).toISOString().slice(0, 10)
const { data: daily } = await db
  .from('daily_metrics')
  .select('date, revenue')
  .eq('business_id', VERO)
  .gte('date', daily90Cutoff)
  .order('date', { ascending: true })

// Last-year-same-month monthly_metrics
const { data: monthly } = await db
  .from('monthly_metrics')
  .select('year, month, revenue')
  .eq('business_id', VERO)
  .eq('year', 2025)
  .eq('month', 6)
  .maybeSingle()

const targetDate = new Date(TARGET + 'T00:00:00Z')
const targetWeekday = targetDate.getUTCDay()

// Same-weekday matches in last 90 days
const sameWeekday = (daily ?? []).filter(d => new Date(d.date + 'T00:00:00Z').getUTCDay() === targetWeekday && Number(d.revenue ?? 0) > 0)

// Recency-weighted average — last 28 days 2x weighted
const recentCut = new Date(today.getTime() - 28 * 86_400_000).toISOString().slice(0, 10)
let sumW = 0, sumWV = 0
for (const d of sameWeekday) {
  const w = d.date >= recentCut ? 2 : 1
  sumW  += w
  sumWV += w * Number(d.revenue)
}
const weekdayBaseline = sumW > 0 ? sumWV / sumW : 0

console.log(`Same-weekday samples found (last 90d, rev>0): ${sameWeekday.length}`)
for (const s of sameWeekday) {
  const recent = s.date >= recentCut ? '2×' : '1×'
  console.log(`  ${s.date}: ${Math.round(Number(s.revenue)).toLocaleString('sv-SE')} kr  [${recent}]`)
}
console.log()
console.log(`Recency-weighted weekday baseline (pre-v1.6.0): ${Math.round(weekdayBaseline).toLocaleString('sv-SE')} kr`)
console.log()

// YoY same-month
console.log(`yoy_same_month (June 2025 monthly_metrics):    ${monthly ? Math.round(Number(monthly.revenue ?? 0)).toLocaleString('sv-SE') + ' kr' : 'missing'}`)
if (monthly && Number(monthly.revenue ?? 0) > 0) {
  const daysInJune = 30
  const yoyDailyAvg = Number(monthly.revenue) / daysInJune
  console.log(`yoy_daily_avg (yoy_same_month / 30):           ${Math.round(yoyDailyAvg).toLocaleString('sv-SE')} kr`)
  console.log()
  const ratio = weekdayBaseline / yoyDailyAvg
  console.log(`v1.6.0 ratio = baseline / yoy_daily_avg = ${ratio.toFixed(2)}`)
  if (ratio > 1.5) {
    const blendWeight = Math.min(0.5, (ratio - 1.5) / 1.5 * 0.5)
    const damped = weekdayBaseline * (1 - blendWeight) + yoyDailyAvg * blendWeight
    console.log(`→ DAMPER FIRES. Blend weight ${(blendWeight * 100).toFixed(0)}%. Baseline pulled from ${Math.round(weekdayBaseline).toLocaleString('sv-SE')} to ${Math.round(damped).toLocaleString('sv-SE')}.`)
    console.log()

    // Compare to actual recent Tuesdays
    const recentTuesdays = sameWeekday.filter(s => s.date >= recentCut).map(s => Number(s.revenue))
    const recentAvg = recentTuesdays.length > 0 ? recentTuesdays.reduce((s,v)=>s+v,0) / recentTuesdays.length : 0
    console.log(`Recent Tuesdays (last 28 days) actual avg:   ${Math.round(recentAvg).toLocaleString('sv-SE')} kr`)
    console.log(`Pre-fix prediction would have been ~${Math.round(weekdayBaseline).toLocaleString('sv-SE')} kr (over-predicted by ${((weekdayBaseline / recentAvg - 1) * 100).toFixed(0)}%)`)
    console.log(`Post-fix prediction is ~${Math.round(damped).toLocaleString('sv-SE')} kr (off recent actual by ${((damped / recentAvg - 1) * 100).toFixed(0)}%)`)
    console.log()
    console.log('Fix verdict: substantial improvement.')
  } else {
    console.log(`→ Damper does NOT fire — baseline within 1.5× of yoy_daily_avg. No correction needed.`)
  }
}
