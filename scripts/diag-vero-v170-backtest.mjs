// scripts/diag-vero-v170-backtest.mjs
//
// Backtest v1.7.0 staff_factor on Vero historical days where we have:
//   - Actual revenue (daily_metrics)
//   - Resolved staff_logs total hours
//
// Compute what v1.7.0 would have predicted (vs the pre-v1.7.0 baseline),
// and the MAPE delta. This is the empirical impact estimate.

import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

// Window: last 90 days
const today = new Date()
const from = new Date(today.getTime() - 90 * 86_400_000).toISOString().slice(0, 10)

const daily = []
for (let p = 0; ; p += 1000) {
  const { data } = await db.from('daily_metrics').select('date, revenue').eq('business_id', VERO).gte('date', from).order('date').range(p, p + 999)
  if (!data || data.length === 0) break
  daily.push(...data)
  if (data.length < 1000) break
}

const staff = []
for (let p = 0; ; p += 1000) {
  const { data } = await db.from('staff_logs').select('shift_date, hours_worked').eq('business_id', VERO).gte('shift_date', from).range(p, p + 999)
  if (!data || data.length === 0) break
  staff.push(...data)
  if (data.length < 1000) break
}

// Aggregate staff per date
const hrsByDate = new Map()
for (const s of staff) {
  const h = Number(s.hours_worked ?? 0)
  if (!Number.isFinite(h) || h <= 0) continue
  hrsByDate.set(s.shift_date, (hrsByDate.get(s.shift_date) ?? 0) + h)
}

// For each trading day, compute weekday baseline (recency-weighted) and v1.7.0 staff_factor
// Walk forward chronologically so each day's baseline only uses prior days.
const points = []
for (let i = 28; i < daily.length; i++) {
  const target = daily[i]
  const revActual = Number(target.revenue ?? 0)
  if (revActual <= 0) continue
  const targetDate = new Date(target.date + 'T00:00:00Z')
  const targetWeekday = targetDate.getUTCDay()
  const targetHrs = hrsByDate.get(target.date) ?? 0
  if (targetHrs <= 0) continue

  // Recency-weighted baseline: same weekday in last 84 days, last 28d × 2
  const baseFrom = new Date(targetDate.getTime() - 84 * 86_400_000).toISOString().slice(0, 10)
  const recentCut = new Date(targetDate.getTime() - 28 * 86_400_000).toISOString().slice(0, 10)
  const sameWeekday = daily.slice(0, i).filter(d => d.date >= baseFrom && new Date(d.date + 'T00:00:00Z').getUTCDay() === targetWeekday && Number(d.revenue ?? 0) > 0)
  if (sameWeekday.length < 3) continue
  let sumW = 0, sumWV = 0
  for (const d of sameWeekday) {
    const w = d.date >= recentCut ? 2 : 1
    sumW  += w
    sumWV += w * Number(d.revenue)
  }
  const baseline = sumW > 0 ? sumWV / sumW : 0
  if (baseline <= 0) continue

  // Staff weekday avg from same-weekday recent
  const sameWeekdayDates = sameWeekday.map(d => d.date)
  const sameWeekdayHrs = sameWeekdayDates.map(d => hrsByDate.get(d)).filter(h => h > 0)
  if (sameWeekdayHrs.length < 3) continue
  const weekdayAvgHrs = sameWeekdayHrs.reduce((s, h) => s + h, 0) / sameWeekdayHrs.length

  // v1.7.0 staff factor
  const rawFactor = targetHrs / weekdayAvgHrs
  const factor = Math.max(0.6, Math.min(1.5, rawFactor))

  const preFix    = baseline
  const postFix   = baseline * factor

  points.push({
    date: target.date,
    weekday: targetWeekday,
    actual: revActual,
    pre_err_pct: ((preFix - revActual) / revActual * 100),
    post_err_pct: ((postFix - revActual) / revActual * 100),
    factor,
    target_hrs: targetHrs,
    weekday_avg_hrs: weekdayAvgHrs,
  })
}

console.log()
console.log(`v1.7.0 backtest — Vero last 90d, ${points.length} trading days with full signal`)
console.log()

const mape = (vals) => vals.reduce((s, v) => s + Math.abs(v), 0) / vals.length
const bias = (vals) => vals.reduce((s, v) => s + v, 0) / vals.length

console.log(`Pre-fix  (weekday baseline only):  MAPE ${mape(points.map(p => p.pre_err_pct)).toFixed(1)}%  bias ${bias(points.map(p => p.pre_err_pct)).toFixed(1)}%`)
console.log(`Post-fix (× v1.7.0 staff_factor):  MAPE ${mape(points.map(p => p.post_err_pct)).toFixed(1)}%  bias ${bias(points.map(p => p.post_err_pct)).toFixed(1)}%`)

const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
console.log()
console.log('Per weekday:')
for (let wd = 0; wd < 7; wd++) {
  const slice = points.filter(p => p.weekday === wd)
  if (slice.length < 3) continue
  const pre  = mape(slice.map(p => p.pre_err_pct))
  const post = mape(slice.map(p => p.post_err_pct))
  const delta = post - pre
  console.log(`  ${days[wd]} (n=${slice.length}): pre MAPE ${pre.toFixed(1)}%  →  post ${post.toFixed(1)}%  Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp`)
}
