// scripts/diag-vero-yoy-coverage.mjs
//
// For the forecaster's YoY anchor to fire, Vero needs:
//   1. daily_metrics rows from same period 12 months ago (yoy_same_weekday)
//   2. monthly_metrics row from same month 12 months ago (yoy_same_month)
//
// Check both, and also the trailing 12 months to confirm the growth
// multiplier has a basis.

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error('Missing env'); process.exit(1) }
const db = createClient(url, key, { auth: { persistSession: false } })

const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

// Window: last 18 months
const today = new Date()
const from = new Date(today.getFullYear() - 2, today.getMonth(), 1).toISOString().slice(0, 10)

// daily_metrics coverage by month
const daily = []
for (let pageFrom = 0; ; pageFrom += 1000) {
  const { data, error } = await db
    .from('daily_metrics')
    .select('date, revenue, staff_cost, covers')
    .eq('business_id', VERO)
    .gte('date', from)
    .order('date', { ascending: true })
    .range(pageFrom, pageFrom + 999)
  if (error) { console.error(error.message); process.exit(1) }
  if (!data || data.length === 0) break
  daily.push(...data)
  if (data.length < 1000) break
}

// monthly_metrics coverage
const { data: monthly } = await db
  .from('monthly_metrics')
  .select('year, month, revenue, staff_cost, food_cost')
  .eq('business_id', VERO)
  .gte('year', 2024)
  .order('year').order('month')

console.log()
console.log('Vero — last-year-same-period data coverage')
console.log(`daily_metrics rows since ${from}:  ${daily.length}`)
console.log(`monthly_metrics rows since 2024:   ${monthly?.length ?? 0}`)
console.log()

// Build monthly buckets from daily
const dailyByMonth = new Map()
for (const d of daily) {
  const ym = d.date.slice(0, 7)
  if (!dailyByMonth.has(ym)) dailyByMonth.set(ym, { days: 0, days_with_rev: 0, total_rev: 0 })
  const b = dailyByMonth.get(ym)
  b.days++
  if (Number(d.revenue ?? 0) > 0) {
    b.days_with_rev++
    b.total_rev += Number(d.revenue)
  }
}

const monthlyByYM = new Map()
for (const m of monthly ?? []) {
  const ym = `${m.year}-${String(m.month).padStart(2, '0')}`
  monthlyByYM.set(ym, m)
}

// Walk Jan 2025 → today (2026-06)
console.log('Month      daily_rows  rev_days   daily_total_rev   monthly_metrics_rev')
const months = []
for (let y = 2025; y <= today.getFullYear(); y++) {
  const mEnd = y === today.getFullYear() ? today.getMonth() + 1 : 12
  for (let m = 1; m <= mEnd; m++) {
    months.push(`${y}-${String(m).padStart(2, '0')}`)
  }
}
for (const ym of months) {
  const d = dailyByMonth.get(ym)
  const mm = monthlyByYM.get(ym)
  const dailyStr  = d ? `${String(d.days).padStart(3)}        ${String(d.days_with_rev).padStart(3)}        ${Math.round(d.total_rev).toLocaleString('sv-SE').padStart(12)}` : '  0          0                  0'
  const mmStr     = mm ? Math.round(Number(mm.revenue ?? 0)).toLocaleString('sv-SE').padStart(14) : '          —'
  console.log(`${ym}    ${dailyStr}    ${mmStr}`)
}
console.log()

// Specific YoY lookups for the current forecast horizon (next 14 days)
console.log('── YoY same-weekday lookups for the next 14 days')
console.log('   Forecast date  YoY date     Revenue (yoy_same_weekday)')
for (let i = 0; i <= 14; i++) {
  const fc = new Date(today.getTime() + i * 86_400_000)
  const fcIso = fc.toISOString().slice(0, 10)
  const yoy = new Date(fc.getTime() - 364 * 86_400_000)
  const yoyIso = yoy.toISOString().slice(0, 10)
  const dayRow = daily.find(d => d.date === yoyIso)
  const rev = dayRow ? Math.round(Number(dayRow.revenue ?? 0)) : null
  const status = rev > 0 ? `${rev.toLocaleString('sv-SE')} (will anchor)` : (rev === 0 ? 'rev=0 (skipped)' : 'missing (skipped)')
  console.log(`   ${fcIso}     ${yoyIso}   ${status}`)
}
console.log()

// Trailing 12-month growth basis
const last24M = months.slice(-24)
const sumWindow = (windowMonths) => {
  let s = 0
  for (const ym of windowMonths) {
    const mm = monthlyByYM.get(ym)
    if (mm) s += Number(mm.revenue ?? 0)
  }
  return s
}
const last12   = last24M.slice(-12)
const prior12  = last24M.slice(-24, -12)
const last12Sum   = sumWindow(last12)
const prior12Sum  = sumWindow(prior12)
const trailing12mGrowth = prior12Sum > 0 ? last12Sum / prior12Sum : null
console.log(`── Trailing-12m growth basis`)
console.log(`   Last 12m sum:    ${Math.round(last12Sum).toLocaleString('sv-SE')}`)
console.log(`   Prior 12m sum:   ${Math.round(prior12Sum).toLocaleString('sv-SE')}`)
console.log(`   Growth ratio:    ${trailing12mGrowth?.toFixed(3) ?? '—'}`)
console.log(`   Applied as multiplier on every forecast.`)
