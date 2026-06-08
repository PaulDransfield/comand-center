// scripts/diag-vero-combined-backtest.mjs
//
// Backtest the combined v1.6.0 + v1.7.0 + v1.8.0 stack vs the legacy
// weekday-baseline-only model on Vero's last 90 days. Shows the
// cumulative impact of today's three forecaster improvements.
//
// Stack:
//   v1.6.0 — YoY-month seasonality damper (smooth proportional)
//   v1.7.0 — staff_factor multiplier (clamped [0.6, 1.5])
//   v1.8.0 — synthetic yoy_same_weekday from monthly_metrics

import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

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

const { data: monthly } = await db
  .from('monthly_metrics')
  .select('year, month, revenue')
  .eq('business_id', VERO)
  .gte('year', 2024)

const monthlyByYM = new Map()
for (const m of monthly ?? []) monthlyByYM.set(`${m.year}-${m.month}`, Number(m.revenue ?? 0))

const hrsByDate = new Map()
for (const s of staff) {
  const h = Number(s.hours_worked ?? 0)
  if (!Number.isFinite(h) || h <= 0) continue
  hrsByDate.set(s.shift_date, (hrsByDate.get(s.shift_date) ?? 0) + h)
}

const points = []
for (let i = 28; i < daily.length; i++) {
  const target = daily[i]
  const revActual = Number(target.revenue ?? 0)
  if (revActual <= 0) continue
  const tDate = new Date(target.date + 'T00:00:00Z')
  const targetWeekday = tDate.getUTCDay()

  // Recency-weighted weekday baseline from prior days
  const baseFrom = new Date(tDate.getTime() - 84 * 86_400_000).toISOString().slice(0, 10)
  const recentCut = new Date(tDate.getTime() - 28 * 86_400_000).toISOString().slice(0, 10)
  const sameWeekday = daily.slice(0, i).filter(d => d.date >= baseFrom && new Date(d.date + 'T00:00:00Z').getUTCDay() === targetWeekday && Number(d.revenue ?? 0) > 0)
  if (sameWeekday.length < 3) continue
  let sumW = 0, sumWV = 0
  for (const d of sameWeekday) {
    const w = d.date >= recentCut ? 2 : 1
    sumW  += w
    sumWV += w * Number(d.revenue)
  }
  let baseline = sumW > 0 ? sumWV / sumW : 0
  if (baseline <= 0) continue

  // v1.8.0 — synthetic yoy_same_weekday from monthly_metrics
  // For target date 2026-06-XX (Monday-Sat), look up 2025-06-XX monthly,
  // divide by open days in June 2025 (Vero closed Sunday), weight by
  // recent weekday share.
  let yoySameWeekdayValue = 0
  let yoyAvailable = false
  const yoyKey = `${tDate.getUTCFullYear() - 1}-${tDate.getUTCMonth() + 1}`
  const yoyMonthRev = monthlyByYM.get(yoyKey) ?? 0
  if (yoyMonthRev > 0) {
    yoyAvailable = true
    const lastYearYear  = tDate.getUTCFullYear() - 1
    const lastYearMonth = tDate.getUTCMonth() + 1
    const daysInMonth   = new Date(lastYearYear, lastYearMonth, 0).getUTCDate()
    // Assume Vero closed Sundays (matches opening_days)
    let openDays = 0
    for (let d = 1; d <= daysInMonth; d++) {
      const dt = new Date(Date.UTC(lastYearYear, lastYearMonth - 1, d))
      if (dt.getUTCDay() !== 0) openDays++
    }
    if (openDays === 0) openDays = daysInMonth
    const flatDaily = yoyMonthRev / openDays

    // Weekday weighting from recent 28d
    const recent28 = daily.filter(d => d.date >= recentCut && Number(d.revenue ?? 0) > 0)
    let weekdayWeight = 1
    if (recent28.length >= 7) {
      const sumByWd = new Array(7).fill(0)
      const cntByWd = new Array(7).fill(0)
      for (const r of recent28) {
        const wd = new Date(r.date + 'T12:00:00Z').getUTCDay()
        sumByWd[wd] += Number(r.revenue ?? 0)
        cntByWd[wd]++
      }
      const avgByWd = sumByWd.map((s, i) => cntByWd[i] > 0 ? s / cntByWd[i] : 0)
      const totalAvg = avgByWd.reduce((s, v) => s + v, 0)
      const openWeekdayCount = avgByWd.filter(v => v > 0).length
      if (totalAvg > 0 && openWeekdayCount > 0) {
        const targetAvg = avgByWd[targetWeekday]
        const equalShare = totalAvg / openWeekdayCount
        if (equalShare > 0 && targetAvg > 0) {
          weekdayWeight = Math.max(0.4, Math.min(2.5, targetAvg / equalShare))
        }
      }
    }
    yoySameWeekdayValue = flatDaily * weekdayWeight
  }

  // v1.9.0 — adaptive blend weight on top of v1.8.0 synthetic
  let v160 = baseline
  if (yoyAvailable && yoySameWeekdayValue > 0) {
    let blendW = 0.30
    const ratio = baseline / yoySameWeekdayValue
    if (ratio > 1.5) blendW = Math.min(0.60, 0.30 + (ratio - 1.5) / 1.5 * 0.30)
    v160 = baseline * (1 - blendW) + yoySameWeekdayValue * blendW
  } else if (yoyAvailable) {
    // Damper case (v1.6.0 only path)
    const yoyMonth = monthlyByYM.get(yoyKey) ?? 0
    const daysInMonth = new Date(tDate.getUTCFullYear() - 1, tDate.getUTCMonth() + 1, 0).getUTCDate()
    if (yoyMonth > 0 && daysInMonth > 0) {
      const yoyDailyAvg = yoyMonth / daysInMonth
      const ratio = v160 / yoyDailyAvg
      if (ratio > 1.5) {
        const blendWeight = Math.min(0.5, (ratio - 1.5) / 1.5 * 0.5)
        v160 = v160 * (1 - blendWeight) + yoyDailyAvg * blendWeight
      }
    }
  }

  // v1.7.0 staff_factor
  const targetHrs = hrsByDate.get(target.date) ?? 0
  let staffFactor = 1
  if (targetHrs > 0) {
    const sameWdHrs = sameWeekday.map(d => hrsByDate.get(d.date)).filter(h => h > 0)
    if (sameWdHrs.length >= 3) {
      const avg = sameWdHrs.reduce((s, h) => s + h, 0) / sameWdHrs.length
      if (avg > 0) {
        const raw = targetHrs / avg
        staffFactor = Math.max(0.6, Math.min(1.5, raw))
      }
    }
  }

  const v180 = v160 * staffFactor

  points.push({
    date: target.date,
    weekday: targetWeekday,
    actual: revActual,
    legacy: baseline,
    v180,
    legacy_err: (baseline - revActual) / revActual * 100,
    v180_err: (v180 - revActual) / revActual * 100,
  })
}

const mape = (vs) => vs.reduce((s, v) => s + Math.abs(v), 0) / vs.length
const bias = (vs) => vs.reduce((s, v) => s + v, 0) / vs.length
const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

console.log()
console.log(`Combined v1.6.0 + v1.7.0 + v1.8.0 backtest — Vero, ${points.length} trading days`)
console.log()
console.log(`Legacy (baseline only):       MAPE ${mape(points.map(p => p.legacy_err)).toFixed(1)}%   bias ${bias(points.map(p => p.legacy_err)).toFixed(1)}%`)
console.log(`v1.8.0 (combined stack):      MAPE ${mape(points.map(p => p.v180_err)).toFixed(1)}%   bias ${bias(points.map(p => p.v180_err)).toFixed(1)}%`)
const dMape = mape(points.map(p => p.v180_err)) - mape(points.map(p => p.legacy_err))
const dBias = bias(points.map(p => p.v180_err)) - bias(points.map(p => p.legacy_err))
console.log(`Delta:                        MAPE ${dMape >= 0 ? '+' : ''}${dMape.toFixed(1)}pp   bias ${dBias >= 0 ? '+' : ''}${dBias.toFixed(1)}pp`)
console.log()
console.log('Per weekday:')
for (let wd = 0; wd < 7; wd++) {
  const slice = points.filter(p => p.weekday === wd)
  if (slice.length < 3) continue
  const m1 = mape(slice.map(p => p.legacy_err))
  const m2 = mape(slice.map(p => p.v180_err))
  const b1 = bias(slice.map(p => p.legacy_err))
  const b2 = bias(slice.map(p => p.v180_err))
  console.log(`  ${days[wd]} (n=${slice.length}): MAPE ${m1.toFixed(1)}% → ${m2.toFixed(1)}% (Δ ${(m2 - m1) >= 0 ? '+' : ''}${(m2 - m1).toFixed(1)}pp)   bias ${b1.toFixed(1)}% → ${b2.toFixed(1)}%`)
}
