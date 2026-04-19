#!/usr/bin/env node
// Dump every revenue_logs row for Vero Apr 15-19 with updated_at timestamps.
// Looking for: duplicates, insert times, what the aggregator would see at 05:19.

import { readFileSync } from 'node:fs'
function parseEnv(p) { try { return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]})) } catch { return {} } }
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY
const ORG='e917d4b8-635e-4be6-8af0-afc48c3c7450', VERO='0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
async function q(path){const r=await fetch(`${URL}/rest/v1/${path}`,{headers:{apikey:KEY,Authorization:`Bearer ${KEY}`}});return r.ok?r.json():{error:await r.text(),status:r.status}}

const rows = await q(
  `revenue_logs?select=revenue_date,provider,revenue,created_at&org_id=eq.${ORG}&business_id=eq.${VERO}&revenue_date=gte.2026-04-15&order=revenue_date.asc,provider.asc`
)
console.log('all revenue_logs rows Apr 15-19:')
console.log('date         provider                revenue    created_at            updated_at')
if (!Array.isArray(rows)) { console.log('ERR:', rows); process.exit(1) }
for (const r of rows) {
  console.log(`  ${r.revenue_date}  ${(r.provider||'').padEnd(22)}  ${String(r.revenue).padStart(8)}  ${r.created_at?.slice(0,19)}`)
}

const rosaliId = '97187ef3-b816-4c41-9230-7551430784a7'
const rosaliRows = await q(
  `revenue_logs?select=revenue_date,provider,revenue,created_at&org_id=eq.${ORG}&business_id=eq.${rosaliId}&revenue_date=gte.2026-04-15&order=revenue_date.asc`
)
console.log(`\nRosali revenue_logs Apr 15-19 (${rosaliRows.length} rows):`)
for (const r of rosaliRows) console.log(`  ${r.revenue_date}  ${r.provider}  ${r.revenue}`)

// Check updated_at on daily_metrics precisely
const dm = await q(`daily_metrics?select=date,revenue,staff_cost,updated_at&business_id=eq.${VERO}&date=gte.2026-04-10&order=date.asc`)
console.log('\ndaily_metrics Apr 10+:')
dm.forEach(r=>console.log(`  ${r.date}  rev=${r.revenue}  staff=${r.staff_cost}  updated=${r.updated_at?.slice(0,23)}`))
