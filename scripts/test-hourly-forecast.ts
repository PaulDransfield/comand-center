// scripts/test-hourly-forecast.ts
//
// Backtest the hourly forecaster against the last N days of actuals.
// For each (business_date, hour) cell in the test window, predict with
// asOfDate = business_date - 1 (one-day-ahead horizon), then compare to
// the actual hourly_metrics row.
//
// Run:
//   npx -y dotenv-cli -e .env.production.local -- npx tsx scripts/test-hourly-forecast.ts <business_id> [days=7]

import { createClient } from '@supabase/supabase-js'
import { hourlyForecast, detectMealPeriods, detectClosedHours } from '../lib/forecast/hourly'

const businessId = process.argv[2]
const days       = parseInt(process.argv[3] ?? '7', 10)

if (!businessId) {
  console.error('Usage: npx tsx scripts/test-hourly-forecast.ts <business_id> [days=7]')
  process.exit(1)
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing Supabase env')
  process.exit(1)
}
const db: any = createClient(url, key)

// ── Helpers ─────────────────────────────────────────────────────────
function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
function daysAgo(n: number): Date {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d
}

// ── Load full hourly history ───────────────────────────────────────
const { data: historyRows } = await db
  .from('hourly_metrics')
  .select('business_date, hour, revenue, covers')
  .eq('business_id', businessId)
  .order('business_date', { ascending: true })

if (!historyRows?.length) {
  console.error('No hourly_metrics for business — run the backfill first.')
  process.exit(1)
}

console.log(`\n═══ Hourly forecast backtest — ${businessId} ═══`)
console.log(`History: ${historyRows.length} rows`)

// ── Auto-detected meal periods ─────────────────────────────────────
const mealPeriods = detectMealPeriods(historyRows as any)
console.log('\nAuto-detected meal periods:')
for (const mp of mealPeriods) {
  const hours = mp.hours.map(h => String(h).padStart(2, '0')).join(', ')
  console.log(`  ${mp.label.padEnd(12)} hours=[${hours}]  peak=${String(mp.peak_hour).padStart(2, '0')}:00 (${(mp.peak_share * 100).toFixed(1)}%)  total=${(mp.total_share * 100).toFixed(1)}%`)
}

// ── Closed-hour detection ──────────────────────────────────────────
const closed = detectClosedHours(historyRows as any)
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const closedByDow: Record<number, number[]> = {}
for (let wd = 0; wd < 7; wd++) closedByDow[wd] = []
for (const k of closed) {
  const [wd, h] = k.split('|').map(Number)
  closedByDow[wd].push(h)
}
console.log('\nClosed hours per weekday (Stockholm-local):')
for (let wd = 0; wd < 7; wd++) {
  const hours = closedByDow[wd].sort((a: number, b: number) => a - b)
  if (hours.length === 0) console.log(`  ${DOW[wd]}: (none)`)
  else                    console.log(`  ${DOW[wd]}: ${hours.map((h: number) => String(h).padStart(2, '0')).join(',')}`)
}

// ── Backtest window ────────────────────────────────────────────────
const windowStart = daysAgo(days)
const windowEnd   = daysAgo(1)
console.log(`\nBacktest window: ${ymd(windowStart)} → ${ymd(windowEnd)} (${days} days)`)

// Load actuals
const { data: actuals } = await db
  .from('hourly_metrics')
  .select('business_date, hour, revenue, covers')
  .eq('business_id', businessId)
  .gte('business_date', ymd(windowStart))
  .lte('business_date', ymd(windowEnd))

const actualByKey: Record<string, any> = {}
for (const r of (actuals ?? []) as any[]) actualByKey[`${r.business_date}|${r.hour}`] = r

// MAPE accumulator per meal period
const errorsByMeal: Record<string, { sumAbsErr: number; sumErr: number; n: number }> = {}
for (const mp of mealPeriods) errorsByMeal[mp.label] = { sumAbsErr: 0, sumErr: 0, n: 0 }

let predictedCount = 0
const lastDay = ymd(windowEnd)
const lastDayBreakdown: any[] = []

for (let d = 0; d < days; d++) {
  const day = daysAgo(days - d)
  const dayIso = ymd(day)

  for (const mp of mealPeriods) {
    for (const hour of mp.hours) {
      const key = `${dayIso}|${hour}`
      const actualRow = actualByKey[key]
      const actual = actualRow?.revenue ?? 0
      try {
        const fc = await hourlyForecast(businessId, day, hour, { db })
        predictedCount++
        if (fc.is_closed_hour) continue
        if (actual <= 0)        continue

        const err    = (fc.predicted_revenue - actual) / actual
        errorsByMeal[mp.label].sumAbsErr += Math.abs(err)
        errorsByMeal[mp.label].sumErr    += err
        errorsByMeal[mp.label].n         += 1

        if (dayIso === lastDay) {
          lastDayBreakdown.push({
            label: mp.label, hour, predicted: fc.predicted_revenue, actual: Number(actual), err_pct: err * 100,
            samples: fc.baseline_samples, tier: fc.baseline_tier, scaler: fc.components.this_week_scaler,
          })
        }
      } catch (e: any) {
        console.warn(`Failed ${dayIso} ${hour}:00 — ${e?.message ?? e}`)
      }
    }
  }
}

console.log(`\nForecasts run: ${predictedCount}`)

// MAPE per meal period
console.log(`\nMAPE per meal period (across ${days}-day window):`)
console.log('  Period        n    MAPE       Bias')
console.log('  ─────────────────────────────────────')
for (const mp of mealPeriods) {
  const e = errorsByMeal[mp.label]
  if (e.n === 0) {
    console.log(`  ${mp.label.padEnd(12)}  ${String(e.n).padStart(3)}  (no resolved samples)`)
  } else {
    const mape = (e.sumAbsErr / e.n) * 100
    const bias = (e.sumErr    / e.n) * 100
    console.log(`  ${mp.label.padEnd(12)}  ${String(e.n).padStart(3)}  ${mape.toFixed(1).padStart(5)}%   ${(bias > 0 ? '+' : '') + bias.toFixed(1).padStart(6)}%`)
  }
}

// Last-day breakdown
console.log(`\nLast-day breakdown (${lastDay}):`)
console.log('  Period        Hr   Predicted    Actual         Err      n  Tier              Scaler')
console.log('  ──────────────────────────────────────────────────────────────────────────────────')
for (const r of lastDayBreakdown) {
  const sign = r.err_pct > 0 ? '+' : ''
  console.log(
    `  ${r.label.padEnd(12)} ${String(r.hour).padStart(2, '0')}:00  ` +
    `${String(r.predicted).padStart(8)}  ` +
    `${String(r.actual).padStart(8)}  ` +
    `${(sign + r.err_pct.toFixed(1) + '%').padStart(8)}  ` +
    `${String(r.samples).padStart(2)}  ${r.tier.padEnd(16)}  ` +
    `${r.scaler.toFixed(2)}`,
  )
}
