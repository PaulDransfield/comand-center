#!/usr/bin/env node
// scripts/trace-rosali-tracker-rows.mjs
//
// Trace every tracker_data row for Rosali to figure out where the
// unexpected March 2026 row came from. Owner says they only entered
// 2025 yearly results, no 2026 data at all.

import { readFileSync } from 'node:fs'
const env = Object.fromEntries(
  readFileSync('.env.production.local', 'utf8')
    .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
)
const URL = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY
const ROSALI = '97187ef3-b816-4c41-9230-7551430784a7'
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function get(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers })
  if (!r.ok) { console.error(await r.text()); process.exit(1) }
  return r.json()
}

console.log('═══ tracker_data rows for Rosali ═══════════════════════\n')
const rows = await get(`tracker_data?select=id,period_year,period_month,revenue,food_cost,staff_cost,other_cost,depreciation,financial,net_profit,source,fortnox_upload_id,created_at,updated_at&business_id=eq.${ROSALI}&order=period_year.asc,period_month.asc`)
console.log(`Found ${rows.length} rows\n`)
for (const r of rows) {
  console.log(`  ${r.period_year}-${String(r.period_month).padStart(2,'0')}  rev=${Number(r.revenue).toLocaleString('en-GB').padStart(12)} kr  staff=${Number(r.staff_cost).toLocaleString('en-GB').padStart(11)} kr  source=${r.source}  upload=${r.fortnox_upload_id ?? '—'}  created=${r.created_at?.slice(0,16)}`)
}

console.log('\n═══ fortnox_uploads for Rosali ═════════════════════════\n')
const uploads = await get(`fortnox_uploads?select=id,filename,status,period_from,period_to,doc_type,uploaded_at,applied_at&business_id=eq.${ROSALI}&order=uploaded_at.desc`)
console.log(`Found ${uploads.length} uploads\n`)
for (const u of uploads) {
  console.log(`  ${u.uploaded_at?.slice(0,16)}  status=${u.status?.padEnd(12)}  doc_type=${u.doc_type?.padEnd(15)}  period=${u.period_from}..${u.period_to}  file=${u.filename}`)
}

console.log('\n═══ tracker_line_items for Rosali March 2026 ═══════════\n')
const lines = await get(`tracker_line_items?select=id,category,subcategory,label_sv,amount,fortnox_account,source_upload_id&org_id=eq.e917d4b8-635e-4be6-8af0-afc48c3c7450&business_id=eq.${ROSALI}&period_year=eq.2026&period_month=eq.3&order=amount.desc&limit=20`)
console.log(`Found ${lines.length} line items\n`)
for (const l of lines) {
  console.log(`  ${l.category?.padEnd(12)} ${(l.subcategory ?? '').padEnd(15)} ${(l.label_sv ?? '').padEnd(40)} ${Number(l.amount).toLocaleString('en-GB').padStart(11)} kr  acct=${l.fortnox_account ?? '—'}`)
}
