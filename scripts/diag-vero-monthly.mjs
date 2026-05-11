import { readFileSync } from 'node:fs'
function parseEnv(path) {
  try { return Object.fromEntries(readFileSync(path, 'utf8').split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g, '')] })) } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

const mm = await fetch(`${URL}/rest/v1/monthly_metrics?business_id=eq.${VERO}&order=year,month`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }
}).then(r => r.json())

console.log('monthly_metrics for Vero:')
console.log('year-month  revenue       staff_cost  food_cost  net_profit')
for (const m of mm) {
  console.log(`${m.year}-${String(m.month).padStart(2,'0')}      ${String(m.revenue ?? 0).padStart(12)}  ${String(m.staff_cost ?? 0).padStart(10)}  ${String(m.food_cost ?? 0).padStart(9)}  ${String(m.net_profit ?? 0).padStart(10)}`)
}

// May-to-date daily totals
const dm = await fetch(`${URL}/rest/v1/daily_metrics?business_id=eq.${VERO}&date=gte.2026-05-01&date=lte.2026-05-10&order=date`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }
}).then(r => r.json())
const may = dm.reduce((s, r) => s + Number(r.revenue ?? 0), 0)
console.log(`\n2026-05 daily_metrics through 2026-05-10: ${dm.length} days, revenue sum = ${may.toLocaleString('sv-SE')}`)
console.log('   (extrapolate to 31-day month: ' + Math.round(may / dm.length * 31).toLocaleString('sv-SE') + ')')
