// scripts/diag-vero-forecast-gap.mjs
//
// Investigate the April-mid May 2026 gap in Vero's resolved forecast
// outcomes. Three possible explanations, all checked here:
//   1. Forecasts WEREN'T WRITTEN — captureForecastOutcome stopped
//   2. Forecasts WRITTEN but UNRESOLVABLE — reconciler couldn't pair
//   3. Forecasts WRITTEN + RESOLVED + correct, but earlier query missed
//      them somehow (filter / surface mismatch / data gap in source)
//
// Output: per-week breakdown of daily_forecast_outcomes counts by status
// for the full Jan-Jun 2026 window, plus daily_metrics actuals coverage
// for the same window so we can tell whether revenue was even being
// captured.

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing env')
  process.exit(1)
}
const db = createClient(url, key, { auth: { persistSession: false } })

const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const FROM = '2026-01-01'
const TO   = '2026-06-30'

// 1. Pull EVERY daily_forecast_outcomes row regardless of status
const { data: outcomes, error: oErr } = await db
  .from('daily_forecast_outcomes')
  .select('forecast_date, surface, resolution_status, actual_revenue, predicted_revenue, predicted_at, model_version')
  .eq('business_id', VERO)
  .gte('forecast_date', FROM)
  .lte('forecast_date', TO)
  .order('forecast_date', { ascending: true })
  .limit(50000)
if (oErr) { console.error('outcomes read failed:', oErr.message); process.exit(1) }

// 2. Pull daily_metrics revenue presence in the same window (paginated)
const dailyMetrics = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await db
    .from('daily_metrics')
    .select('date, revenue, staff_cost, covers, updated_at')
    .eq('business_id', VERO)
    .gte('date', FROM)
    .lte('date', TO)
    .order('date', { ascending: true })
    .range(from, from + 999)
  if (error) { console.error('daily_metrics read failed:', error.message); process.exit(1) }
  if (!data || data.length === 0) break
  dailyMetrics.push(...data)
  if (data.length < 1000) break
}

console.log()
console.log(`Vero forecast-gap investigation — Jan-Jun 2026`)
console.log(`daily_forecast_outcomes rows:   ${outcomes.length}`)
console.log(`daily_metrics rows in window:   ${dailyMetrics.length}`)
console.log()

// ── Per-week breakdown ────────────────────────────────────────────
function weekKey(dateStr) {
  // ISO Monday-week. Returns the Monday of the week.
  const d = new Date(dateStr + 'T00:00:00Z')
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() - (day - 1))
  return d.toISOString().slice(0, 10)
}

// Group outcomes by week + surface
const outBySurface = {}
const allSurfaces = new Set()
for (const r of outcomes) {
  allSurfaces.add(r.surface)
  const wk = weekKey(r.forecast_date)
  if (!outBySurface[r.surface]) outBySurface[r.surface] = new Map()
  if (!outBySurface[r.surface].has(wk)) outBySurface[r.surface].set(wk, { resolved: 0, pending: 0, unresolvable_no_actual: 0, unresolvable_data_quality: 0, unresolvable_zero_actual: 0, total: 0 })
  const bucket = outBySurface[r.surface].get(wk)
  bucket.total++
  bucket[r.resolution_status] = (bucket[r.resolution_status] ?? 0) + 1
}

// daily_metrics revenue by week
const revByWeek = new Map()
for (const d of dailyMetrics) {
  const wk = weekKey(d.date)
  if (!revByWeek.has(wk)) revByWeek.set(wk, { days_with_revenue: 0, total_revenue: 0, total_days: 0 })
  const b = revByWeek.get(wk)
  b.total_days++
  if (Number(d.revenue ?? 0) > 0) {
    b.days_with_revenue++
    b.total_revenue += Number(d.revenue)
  }
}

// Build a union of all weeks in window
const allWeeks = new Set()
for (const s of Object.values(outBySurface)) for (const k of s.keys()) allWeeks.add(k)
for (const k of revByWeek.keys()) allWeeks.add(k)
const sortedWeeks = [...allWeeks].sort()

// Print per-surface tables
for (const surface of allSurfaces) {
  console.log(`── Surface: ${surface} — per-week status counts`)
  console.log('   Week start   | total | resolved | pending | unres_no_actual | unres_dq | unres_zero | actual_rev_days')
  for (const wk of sortedWeeks) {
    const b = outBySurface[surface]?.get(wk)
    if (!b) continue   // skip weeks with no rows on this surface
    const rev = revByWeek.get(wk)
    const revStr = rev ? `${rev.days_with_revenue}/${rev.total_days}` : '0/0'
    const totalRevStr = rev ? Math.round(rev.total_revenue).toLocaleString('sv-SE') : '0'
    console.log(`   ${wk}  | ${String(b.total).padStart(5)} | ${String(b.resolved).padStart(8)} | ${String(b.pending).padStart(7)} | ${String(b.unresolvable_no_actual).padStart(15)} | ${String(b.unresolvable_data_quality).padStart(8)} | ${String(b.unresolvable_zero_actual).padStart(10)} | ${revStr.padStart(7)} (${totalRevStr})`)
  }
  console.log()
}

// ── Per-week WRITE rate (any surface) ──────────────────────────────
console.log(`── Per-week: total daily_forecast_outcomes write rate across all surfaces`)
console.log('   Week start   | rows_written | revenue_days')
const totalWrites = new Map()
for (const r of outcomes) {
  const wk = weekKey(r.forecast_date)
  totalWrites.set(wk, (totalWrites.get(wk) ?? 0) + 1)
}
for (const wk of sortedWeeks) {
  const w = totalWrites.get(wk) ?? 0
  const rev = revByWeek.get(wk)
  const revStr = rev ? `${rev.days_with_revenue}/${rev.total_days}` : '0/0'
  const marker = w === 0 ? '  ← NO FORECASTS WRITTEN' : ''
  console.log(`   ${wk}  | ${String(w).padStart(12)} | ${revStr.padStart(12)} ${marker}`)
}
console.log()

// ── Headline diagnostics ──────────────────────────────────────────
const aprilGapStart = '2026-04-01'
const aprilGapEnd   = '2026-05-15'
const aprilOutcomes = outcomes.filter(r => r.forecast_date >= aprilGapStart && r.forecast_date <= aprilGapEnd)
const aprilDailyMetrics = dailyMetrics.filter(d => d.date >= aprilGapStart && d.date <= aprilGapEnd)
const aprilRevDays = aprilDailyMetrics.filter(d => Number(d.revenue ?? 0) > 0).length

console.log(`── April 1 → May 15 window (45 days)`)
console.log(`   daily_forecast_outcomes rows written: ${aprilOutcomes.length}`)
const byStatus = {}
for (const r of aprilOutcomes) byStatus[r.resolution_status] = (byStatus[r.resolution_status] ?? 0) + 1
console.log(`     by status:  ${JSON.stringify(byStatus)}`)
const bySurface = {}
for (const r of aprilOutcomes) bySurface[r.surface] = (bySurface[r.surface] ?? 0) + 1
console.log(`     by surface: ${JSON.stringify(bySurface)}`)
console.log(`   daily_metrics rows: ${aprilDailyMetrics.length}`)
console.log(`   days with revenue > 0: ${aprilRevDays}`)
console.log()

// Earliest + latest predicted_at in the gap to see WHEN they were written
if (aprilOutcomes.length > 0) {
  const sortedByPredAt = [...aprilOutcomes].sort((a, b) => (a.predicted_at ?? '').localeCompare(b.predicted_at ?? ''))
  console.log(`   First predicted_at in window: ${sortedByPredAt[0]?.predicted_at}`)
  console.log(`   Last  predicted_at in window: ${sortedByPredAt[sortedByPredAt.length - 1]?.predicted_at}`)
  const modelVersions = [...new Set(aprilOutcomes.map(r => r.model_version))]
  console.log(`   model_versions in window: ${modelVersions.join(', ')}`)
}

// ── Verdict logic ─────────────────────────────────────────────────
console.log()
console.log('── Diagnosis')
if (aprilOutcomes.length === 0 && aprilRevDays > 0) {
  console.log('  No forecasts were WRITTEN during Apr-May 15 even though')
  console.log('  daily_metrics has revenue. The forecaster (consolidated_daily) was')
  console.log('  not being called during this window — capture path was broken.')
} else if (aprilOutcomes.length > 0 && (byStatus.resolved ?? 0) === 0) {
  console.log('  Forecasts were written but NONE got resolved. Reconciler')
  console.log('  failed to pair them against actuals. Check daily-forecast-reconciler')
  console.log('  cron + the predicate it uses to look up actual_revenue.')
} else if (aprilOutcomes.length > 0 && aprilRevDays === 0) {
  console.log('  Forecasts were written but daily_metrics has no revenue rows.')
  console.log('  POS sync was down or aggregator wasn\'t writing daily_metrics —')
  console.log('  reconciler had nothing to compare against.')
} else if (aprilOutcomes.length > 0 && (byStatus.resolved ?? 0) > 0) {
  console.log('  Window IS populated and resolved. The earlier query may have')
  console.log('  filtered the window out incorrectly — re-check trend script.')
} else {
  console.log('  Mixed signal — see counts above.')
}
