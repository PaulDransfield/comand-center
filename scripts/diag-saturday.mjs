#!/usr/bin/env node
// scripts/diag-saturday.mjs
// One-off diagnostic: why is Saturday 2026-04-18 data missing for Vero?
// Reads .env.local, queries DB via service role. Never logs credentials.

import { readFileSync } from 'node:fs'

function parseEnv(path) {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
      })
  )
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }

const URL = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) { console.error('missing env'); process.exit(1) }

const ORG = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const ROSALI = '97187ef3-b816-4c41-9230-7551430784a7'

async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  })
  if (!r.ok) return { error: await r.text(), status: r.status }
  return r.json()
}

const days = ['2026-04-15', '2026-04-16', '2026-04-17', '2026-04-18', '2026-04-19']

for (const biz of [{ name: 'Vero', id: VERO }, { name: 'Rosali', id: ROSALI }]) {
  console.log(`\n=== ${biz.name} (${biz.id}) ===`)
  for (const d of days) {
    const rev = await q(
      `revenue_logs?select=revenue_date,provider,revenue&org_id=eq.${ORG}&business_id=eq.${biz.id}&revenue_date=eq.${d}`
    )
    const staff = await q(
      `staff_logs?select=shift_date,staff_name&org_id=eq.${ORG}&business_id=eq.${biz.id}&shift_date=eq.${d}&limit=1`
    )
    const revTotal = Array.isArray(rev) ? rev.reduce((s, r) => s + (Number(r.revenue) || 0), 0) : '?'
    const providers = Array.isArray(rev) ? [...new Set(rev.map(r => r.provider))].join(',') : '?'
    const staffCount = Array.isArray(staff) ? staff.length : '?'
    console.log(`  ${d}  rev=${revTotal}  providers=${providers || '(none)'}  staff_rows≥${staffCount}`)
  }
}

// Daily metrics (aggregated)
console.log('\n=== daily_metrics (Vero) ===')
const dm = await q(
  `daily_metrics?select=date,revenue,staff_cost,hours_worked&org_id=eq.${ORG}&business_id=eq.${VERO}&date=gte.2026-04-15&order=date.asc`
)
if (Array.isArray(dm)) dm.forEach(r => console.log(`  ${r.date}  rev=${r.revenue}  staff=${r.staff_cost}  hrs=${r.hours_worked}`))
else console.log('  ', dm)

// Sync log
console.log('\n=== sync_log (last 10 entries) ===')
const sl = await q(`sync_log?select=created_at,provider,status,error_msg,records_synced,date_from,date_to&org_id=eq.${ORG}&order=created_at.desc&limit=10`)
if (Array.isArray(sl)) sl.forEach(r => console.log(`  ${r.created_at?.slice(0,19)}  ${r.provider}  ${r.status}  ${r.records_synced ?? '?'} rows  ${r.date_from}→${r.date_to}  ${r.error_msg ?? ''}`))
else console.log('  ', sl)

// Integrations
console.log('\n=== integrations ===')
const ig = await q(`integrations?select=id,provider,business_id,last_sync_at,enhanced_discovery_status&org_id=eq.${ORG}`)
if (Array.isArray(ig)) ig.forEach(r => console.log(`  ${r.provider}  biz=${r.business_id?.slice(0,8)}  last=${r.last_sync_at?.slice(0,19) || '(never)'}`))
else console.log('  ', ig)
