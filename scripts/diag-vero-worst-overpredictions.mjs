// Diagnose the systematic +31.6% bias on Vero low-confidence days.
//
// Phase 0 confidence-calibration view (M070) showed:
//   Vero consolidated_daily low conf:  88.2% MAPE, +31.6% bias (n=60)
//
// +31.6% bias means we systematically OVER-predict by ~32% on the worst-
// uncertainty days. The fix-direction matters: if it's late-December
// samples leaking past the holiday filter, we need to widen the filter;
// if it's the zero-baseline fallback overshooting on cold-start January,
// we need to clamp the fallback magnitude; if it's something else,
// we'll see the pattern.
//
// What this script does:
//   1. Pull the top-N most over-predicted (highest positive error_pct)
//      Vero rows from daily_forecast_outcomes where:
//        - surface = 'consolidated_daily'
//        - confidence = 'low'
//        - resolution_status = 'resolved'
//   2. For each, dump:
//        - forecast_date, predicted, actual, error_pct, model_version
//        - inputs_snapshot.weekday_baseline (recency_weighted_avg, samples,
//          zero_fallback_active, holiday_filter_active)
//        - inputs_snapshot.data_quality_flags
//        - inputs_snapshot.components (multiplicative factors applied)
//
// Run: node scripts/diag-vero-worst-overpredictions.mjs [N]   (default N=10)

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const VERO_BUSINESS_ID = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const N = Number(process.argv[2] ?? '10')

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const db = createClient(url, key)

console.log(`\n═══ Vero — top ${N} most over-predicted low-confidence days ═══\n`)

const { data, error } = await db
  .from('daily_forecast_outcomes')
  .select('forecast_date, predicted_revenue, actual_revenue, error_pct, model_version, inputs_snapshot, llm_reasoning')
  .eq('business_id', VERO_BUSINESS_ID)
  .eq('surface', 'consolidated_daily')
  .eq('confidence', 'low')
  .eq('resolution_status', 'resolved')
  .order('error_pct', { ascending: false })   // most over-predicted first
  .limit(N)

if (error) {
  console.error('ERR:', error.message)
  process.exit(1)
}
if (!data?.length) {
  console.log('No resolved low-confidence consolidated_daily rows for Vero.')
  process.exit(0)
}

// ── Per-row dump ────────────────────────────────────────────────────
for (const r of data) {
  const snap = r.inputs_snapshot ?? {}
  const wb   = snap.weekday_baseline ?? {}
  const comps = snap.components ?? {}
  const errPct = Number(r.error_pct)
  const errPctStr = (errPct * 100).toFixed(1) + '%'
  const overBy = Math.round(Number(r.predicted_revenue) - Number(r.actual_revenue))

  console.log(`── ${r.forecast_date} ──  predicted ${num(r.predicted_revenue)} kr · actual ${num(r.actual_revenue)} kr · err ${errPctStr} (over by ${num(overBy)} kr)`)
  console.log(`   model:               ${r.model_version}`)
  console.log(`   weekday_baseline:`)
  console.log(`     recency_weighted:   ${num(wb.recency_weighted_avg)} kr`)
  console.log(`     recent_28d_samples: ${wb.recent_28d_samples}`)
  console.log(`     older_samples:      ${wb.older_samples}`)
  console.log(`     holiday_filter:     active=${wb.holiday_filter_active} · excluded=${wb.holiday_samples_excluded}`)
  console.log(`     zero_fallback:      active=${wb.zero_fallback_active} · overall_samples=${wb.zero_fallback_overall_samples ?? 0}`)
  console.log(`   data_quality_flags:  ${JSON.stringify(snap.data_quality_flags ?? [])}`)
  console.log(`   components applied:`)
  for (const [k, v] of Object.entries(comps)) {
    if (v == null) continue
    const n = Number(v)
    if (!Number.isFinite(n)) continue
    if (n === 1) continue  // skip neutral
    console.log(`     ${k.padEnd(24)} ${n.toFixed(3)}`)
  }
  // YoY
  const yom = snap.yoy_same_month
  if (yom?.available) {
    console.log(`   yoy_same_month:      ${yom.monthly_revenue} kr · growth_mult ${yom.trailing_12m_growth_multiplier}`)
  }
  console.log()
}

// ── Aggregated pattern detection ────────────────────────────────────
console.log('═══ Pattern detection ═══\n')

const monthCounts = {}
const dowCounts   = {}
let holidayFilterActiveCount = 0
let zeroFallbackActiveCount  = 0
let scalerClampedMaxCount    = 0
let scalerClampedMinCount    = 0
let flagSet = {}

for (const r of data) {
  const date = new Date(r.forecast_date + 'T12:00:00Z')
  const m = date.getUTCMonth() + 1
  const dow = date.getUTCDay()
  monthCounts[m] = (monthCounts[m] ?? 0) + 1
  dowCounts[dow] = (dowCounts[dow] ?? 0) + 1

  const snap = r.inputs_snapshot ?? {}
  const wb = snap.weekday_baseline ?? {}
  const tws = snap.this_week_scaler ?? {}
  if (wb.holiday_filter_active) holidayFilterActiveCount++
  if (wb.zero_fallback_active)  zeroFallbackActiveCount++
  if (tws.clamped_at_max)       scalerClampedMaxCount++
  if (tws.clamped_at_min)       scalerClampedMinCount++
  for (const f of snap.data_quality_flags ?? []) flagSet[f] = (flagSet[f] ?? 0) + 1
}

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
console.log('By month:')
for (const [m, c] of Object.entries(monthCounts).sort()) console.log(`  ${m.padStart(2, '0')}: ${c}`)
console.log('\nBy day-of-week:')
for (let d = 0; d < 7; d++) console.log(`  ${DOW_NAMES[d]}: ${dowCounts[d] ?? 0}`)
console.log('\nFlag counts:')
for (const [f, c] of Object.entries(flagSet).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.toString().padStart(3)}  ${f}`)
}
console.log('\nSnapshot signals:')
console.log(`  holiday_filter_active:  ${holidayFilterActiveCount} / ${data.length}`)
console.log(`  zero_fallback_active:   ${zeroFallbackActiveCount} / ${data.length}`)
console.log(`  scaler clamped at MAX:  ${scalerClampedMaxCount} / ${data.length}`)
console.log(`  scaler clamped at MIN:  ${scalerClampedMinCount} / ${data.length}`)

// Helpers
function num(n) {
  if (n == null) return '(null)'
  return Number(n).toLocaleString('en-GB')
}
