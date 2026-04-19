#!/usr/bin/env node
import { readFileSync } from 'node:fs'
function parseEnv(p){try{return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))}catch{return{}}}
const env={...parseEnv('.env.local'),...parseEnv('.env.production.local')}

async function q(path, label) {
  const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  })
  if (!r.ok) { console.log(`  [${label}] ${r.status}: ${(await r.text()).slice(0,120)}`); return [] }
  const j = await r.json()
  return Array.isArray(j) ? j : []
}

const ORG='e917d4b8-635e-4be6-8af0-afc48c3c7450'
const VERO='0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

console.log('═══ FORECASTS (predictions) ═══')
const fc = await q(`forecasts?select=*&org_id=eq.${ORG}&business_id=eq.${VERO}&order=period_year.desc,period_month.desc&limit=12`, 'forecasts')
console.log(`rows: ${fc.length}`)
if (fc.length) console.log(`  fields: ${Object.keys(fc[0]).join(', ')}`)
for (const f of fc) {
  console.log(`  ${f.period_year}-${String(f.period_month).padStart(2,'0')}  rev_fcst=${String(f.revenue_forecast).padStart(10)}  staff_fcst=${String(f.staff_cost_forecast).padStart(8)}  margin=${f.margin_forecast ?? '—'}%  conf=${f.confidence ?? '—'}  method=${f.method ?? '—'}  basedOn=${f.based_on_months ?? '—'}mo`)
}

console.log('\n═══ BUDGETS ═══')
const bd = await q(`budgets?select=*&org_id=eq.${ORG}&business_id=eq.${VERO}&limit=24`, 'budgets')
console.log(`rows: ${bd.length}`)
if (bd.length) { console.log(`  fields: ${Object.keys(bd[0]).join(', ')}`); for (const b of bd) console.log(`  ${JSON.stringify(b).slice(0,200)}`) }

console.log('\n═══ FORECAST CALIBRATION (accuracy tracking) ═══')
const cal = await q(`forecast_calibration?select=*&org_id=eq.${ORG}&business_id=eq.${VERO}`, 'calibration')
console.log(`rows: ${cal.length}`)
for (const c of cal) console.log(`  bias=${c.bias_factor}  accuracy=${c.accuracy_pct}%  calibrated_at=${c.calibrated_at?.slice(0,19)}`)

console.log('\n═══ FORECAST vs ACTUAL + BUDGET vs ACTUAL — 2026 ═══')
for (const m of [1, 2, 3]) {
  const fcast = fc.find(f => f.period_year === 2026 && f.period_month === m)
  const bud   = bd.find(f => f.year === 2026 && f.month === m)
  const actRows = await q(`monthly_metrics?select=revenue,staff_cost&business_id=eq.${VERO}&year=eq.2026&month=eq.${m}`, 'actuals')
  const actual = actRows[0]
  const fmtDiff = (p, a) => (p && a) ? `${((a - p) / p * 100).toFixed(1)}%` : '—'
  console.log(`\n  2026-${String(m).padStart(2,'0')}`)
  console.log(`    Actual revenue : ${actual?.revenue ?? '—'}`)
  console.log(`    Forecast       : ${fcast?.revenue_forecast ?? '—'}   (diff ${fmtDiff(fcast?.revenue_forecast, actual?.revenue)})`)
  console.log(`    Budget target  : ${bud?.revenue_target ?? '—'}   (diff ${fmtDiff(bud?.revenue_target, actual?.revenue)})`)
  console.log(`    Actual staff   : ${actual?.staff_cost ?? '—'}`)
  console.log(`    Forecast staff : ${fcast?.staff_cost_forecast ?? '—'}   (diff ${fmtDiff(fcast?.staff_cost_forecast, actual?.staff_cost)})`)
}

console.log('\n═══ ANOMALIES DETECTED ═══')
const al = await q(`anomaly_alerts?select=*&org_id=eq.${ORG}&business_id=eq.${VERO}&order=created_at.desc&limit=10`, 'anomaly_alerts')
console.log(`rows: ${al.length}`)
for (const a of al) console.log(`  ${a.created_at?.slice(0,10)}  [${a.severity ?? '?'}] ${a.alert_type ?? '?'}  ${(a.message ?? '').slice(0,90)}`)

console.log('\n═══ AI REQUESTS (last 50) ═══')
const ai = await q(`ai_request_log?select=request_type,model,cost_sek,created_at&org_id=eq.${ORG}&order=created_at.desc&limit=50`, 'ai_log')
console.log(`rows: ${ai.length}`)
const byType = {}, byModel = {}
let totalSek = 0
for (const r of ai) {
  byType[r.request_type]  = (byType[r.request_type]  ?? 0) + 1
  byModel[r.model]        = (byModel[r.model]        ?? 0) + 1
  totalSek += Number(r.cost_sek || 0)
}
for (const [t, n] of Object.entries(byType))  console.log(`  ${t.padEnd(25)} × ${n}`)
console.log(`  models: ${Object.entries(byModel).map(([m,n]) => `${m}×${n}`).join(', ')}`)
console.log(`  total cost: ${totalSek.toFixed(2)} kr`)

console.log('\n═══ SCHEDULING RECOMMENDATIONS ═══')
const sr = await q(`scheduling_recommendations?select=*&org_id=eq.${ORG}&order=generated_at.desc&limit=3`, 'sched')
console.log(`rows: ${sr.length}`)
for (const s of sr) {
  console.log(`  ${s.generated_at?.slice(0,19)}  period=${JSON.stringify(s.analysis_period ?? {}).slice(0,100)}`)
  if (s.recommendations) console.log(`  rec preview: ${JSON.stringify(s.recommendations).slice(0, 300)}`)
}

console.log('\n═══ BRIEFINGS (Monday summaries) ═══')
const br = await q(`briefings?select=*&org_id=eq.${ORG}&order=created_at.desc&limit=3`, 'briefings')
console.log(`rows: ${br.length}`)
for (const b of br) {
  console.log(`  week ${b.week_start}  generated=${b.created_at?.slice(0,19)}`)
  if (b.content) console.log(`  preview: ${b.content.slice(0, 200)}`)
}
