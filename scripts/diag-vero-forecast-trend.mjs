// scripts/diag-vero-forecast-trend.mjs
//
// Is Vero's sales-prediction model getting better or worse over time?
//
// Reads daily_forecast_outcomes for Vero, buckets resolved rows into
// 14-day windows over the last 120 days, reports MAPE + bias per window
// per surface so we can see the trajectory.

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env')
  process.exit(1)
}
const db = createClient(url, key, { auth: { persistSession: false } })

const VERO_BIZ_ID = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const WINDOW_DAYS = 14
const TOTAL_DAYS  = 120

const today = new Date()
const fromIso = new Date(today.getTime() - TOTAL_DAYS * 86_400_000).toISOString().slice(0, 10)

const { data, error } = await db
  .from('daily_forecast_outcomes')
  .select('forecast_date, surface, predicted_revenue, actual_revenue, resolution_status, prediction_horizon_days')
  .eq('business_id', VERO_BIZ_ID)
  .eq('resolution_status', 'resolved')
  .gte('forecast_date', fromIso)
  .not('actual_revenue', 'is', null)
  .order('forecast_date', { ascending: true })
  .limit(50000)

if (error) { console.error('Read failed:', error.message); process.exit(1) }

const rows = (data ?? []).filter(r => {
  const actual = Number(r.actual_revenue ?? 0)
  return actual > 0 && Number.isFinite(Number(r.predicted_revenue))
})

console.log()
console.log(`Vero forecast trend — ${rows.length} resolved daily predictions in the last ${TOTAL_DAYS} days`)
console.log(`Window size: ${WINDOW_DAYS}d. Surfaces below show MAPE (lower = better) and bias % (positive = overshooting).`)
console.log()

// Group rows into N-day buckets. Bucket label = window start date.
function bucketStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z')
  const day0 = new Date(fromIso + 'T00:00:00Z')
  const daysSinceStart = Math.floor((d.getTime() - day0.getTime()) / 86_400_000)
  const bucketIndex = Math.floor(daysSinceStart / WINDOW_DAYS)
  const bucketDay = new Date(day0.getTime() + bucketIndex * WINDOW_DAYS * 86_400_000)
  return bucketDay.toISOString().slice(0, 10)
}

const surfaces = new Set(rows.map(r => r.surface))
for (const surface of surfaces) {
  const surfaceRows = rows.filter(r => r.surface === surface)
  if (surfaceRows.length === 0) continue

  // Group by window
  const byBucket = new Map()
  for (const r of surfaceRows) {
    const bucket = bucketStart(r.forecast_date)
    if (!byBucket.has(bucket)) byBucket.set(bucket, [])
    byBucket.get(bucket).push(r)
  }

  const sortedBuckets = [...byBucket.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  console.log(`── ${surface} — ${surfaceRows.length} rows total ──`)
  console.log('  Window starting         n   MAPE %   Bias %   Sample range (predicted/actual)')
  for (const [bucket, rs] of sortedBuckets) {
    const signed = rs.map(r => (Number(r.predicted_revenue) - Number(r.actual_revenue)) / Number(r.actual_revenue) * 100)
    const abs    = signed.map(Math.abs)
    const mape   = abs.reduce((s, v) => s + v, 0) / abs.length
    const bias   = signed.reduce((s, v) => s + v, 0) / signed.length
    const sample = rs.slice(0, 2).map(r => `${Math.round(Number(r.predicted_revenue))}/${Math.round(Number(r.actual_revenue))}`).join(' · ')
    const endBucket = new Date(bucket + 'T00:00:00Z')
    endBucket.setUTCDate(endBucket.getUTCDate() + WINDOW_DAYS - 1)
    const range = `${bucket} – ${endBucket.toISOString().slice(0, 10)}`
    console.log(`  ${range}  ${String(rs.length).padStart(3)}  ${mape.toFixed(1).padStart(6)}   ${bias >= 0 ? '+' : ''}${bias.toFixed(1).padStart(5)}   ${sample}`)
  }
  console.log()
}

// Overall trend headline
const allSigned = rows.map(r => (Number(r.predicted_revenue) - Number(r.actual_revenue)) / Number(r.actual_revenue) * 100)
const allAbs    = allSigned.map(Math.abs)
const overallMape = allAbs.reduce((s, v) => s + v, 0) / allAbs.length
const overallBias = allSigned.reduce((s, v) => s + v, 0) / allSigned.length

// Compare first 30 days vs last 30 days for a trend signal
const cutoffEarlyEnd = new Date(today.getTime() - 90 * 86_400_000).toISOString().slice(0, 10)
const cutoffLateStart = new Date(today.getTime() - 30 * 86_400_000).toISOString().slice(0, 10)
const early = rows.filter(r => r.forecast_date <= cutoffEarlyEnd)
const late  = rows.filter(r => r.forecast_date >= cutoffLateStart)
const summarise = (rs) => {
  if (rs.length === 0) return null
  const signed = rs.map(r => (Number(r.predicted_revenue) - Number(r.actual_revenue)) / Number(r.actual_revenue) * 100)
  const abs    = signed.map(Math.abs)
  return {
    n:    rs.length,
    mape: abs.reduce((s, v) => s + v, 0) / abs.length,
    bias: signed.reduce((s, v) => s + v, 0) / signed.length,
  }
}
const e = summarise(early)
const l = summarise(late)

console.log('═══ Headline ═══')
console.log(`Overall: ${rows.length} predictions · MAPE ${overallMape.toFixed(1)}% · bias ${overallBias >= 0 ? '+' : ''}${overallBias.toFixed(1)}%`)
console.log()
if (e && l) {
  const delta = l.mape - e.mape
  const dir = delta < 0 ? 'IMPROVED' : delta > 0 ? 'WORSENED' : 'no change'
  console.log(`Earliest 30d window (${rows[0]?.forecast_date} – ${cutoffEarlyEnd}): n=${e.n}, MAPE ${e.mape.toFixed(1)}%, bias ${e.bias.toFixed(1)}%`)
  console.log(`Most-recent 30d window (${cutoffLateStart} onwards): n=${l.n}, MAPE ${l.mape.toFixed(1)}%, bias ${l.bias.toFixed(1)}%`)
  console.log(`→ Model accuracy ${dir} by ${Math.abs(delta).toFixed(1)} percentage points.`)
} else {
  console.log('Not enough rows in one of the windows to compare.')
}
