#!/usr/bin/env node
// Call Supabase directly to see what the aggregator would see for Vero in April.
// Mimics the fetch the aggregator does, then shows the per-day breakdown.

import { readFileSync } from 'node:fs'

function parseEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter(l => l.includes('=') && !l.trim().startsWith('#'))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
    )
  } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY

const ORG  = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
  if (!r.ok) return { error: await r.text(), status: r.status }
  return r.json()
}

// Exactly the aggregator's query.
const rev = await q(
  `revenue_logs?select=revenue_date,revenue,provider&org_id=eq.${ORG}&business_id=eq.${VERO}&revenue_date=gte.2026-04-15&order=revenue_date.asc&limit=50000`
)
const staff = await q(
  `staff_logs?select=shift_date,cost_actual,estimated_salary,hours_worked&org_id=eq.${ORG}&business_id=eq.${VERO}&shift_date=gte.2026-04-15&or=(cost_actual.gt.0,estimated_salary.gt.0)&limit=50000`
)

console.log(`revenue_logs rows: ${rev.length}`)
console.log(`staff_logs rows:   ${staff.length}`)

const byDate = {}
for (const r of rev) {
  if ((r.provider ?? '') === 'personalkollen') continue  // dedup: per-dept rows take priority
  byDate[r.revenue_date] = (byDate[r.revenue_date] || 0) + Number(r.revenue || 0)
}
console.log('\nRevenue per day (deduped, pk_* only):')
Object.keys(byDate).sort().forEach(d => console.log(`  ${d}  ${Math.round(byDate[d])}`))

const staffByDate = {}
for (const s of staff) {
  const cost = Number(s.cost_actual || 0) > 0 ? Number(s.cost_actual) : Number(s.estimated_salary || 0)
  staffByDate[s.shift_date] = (staffByDate[s.shift_date] || 0) + cost
}
console.log('\nStaff cost per day:')
Object.keys(staffByDate).sort().forEach(d => console.log(`  ${d}  ${Math.round(staffByDate[d])}`))

console.log('\ndaily_metrics currently in DB:')
const dm = await q(`daily_metrics?select=date,revenue,staff_cost,updated_at&business_id=eq.${VERO}&date=gte.2026-04-15&order=date.asc`)
dm.forEach(r => console.log(`  ${r.date}  rev=${r.revenue}  staff=${r.staff_cost}  updated=${r.updated_at?.slice(0,19)}`))
