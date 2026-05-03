#!/usr/bin/env node
// scripts/cleanup-rosali-march-2026.mjs
//
// Owner has confirmed they did NOT enter any 2026 data for Rosali —
// only 2025 yearly. The tracker_data row at 2026-03 with source='manual'
// is bogus (no fortnox_upload_id, no audit trail). Cleaning up:
//
//   1. Delete the rogue tracker_data row
//   2. Delete any tracker_line_items for the same (business, year, month)
//   3. Recompute monthly_metrics for that period (revenue should now
//      come from POS / Fortnox, both empty → revenue=0; staff from PK
//      if present)
//
// Re-runnable. Diagnostic-first then prompts before deleting.

import { readFileSync } from 'node:fs'
const env = Object.fromEntries(
  readFileSync('.env.production.local', 'utf8')
    .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
)
const URL = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY
const ORG    = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'
const ROSALI = '97187ef3-b816-4c41-9230-7551430784a7'
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function get(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers })
  if (!r.ok) { console.error(await r.text()); process.exit(1) }
  return r.json()
}
async function del(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { method: 'DELETE', headers: { ...headers, Prefer: 'return=representation' } })
  if (!r.ok) { console.error('DELETE failed', path, await r.text()); process.exit(1) }
  return r.json()
}
async function upsert(table, body) {
  const r = await fetch(`${URL}/rest/v1/${table}?on_conflict=business_id,year,month`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(body),
  })
  if (!r.ok) { console.error('UPSERT failed', table, await r.text()); process.exit(1) }
  return r.json()
}

console.log('═══ tracker_data row(s) for Rosali 2026-03 ═══════════\n')
const td = await get(`tracker_data?select=*&business_id=eq.${ROSALI}&period_year=eq.2026&period_month=eq.3`)
console.log(`  ${td.length} row(s)`)
for (const r of td) {
  console.log(`    id=${r.id}  source=${r.source}  upload=${r.fortnox_upload_id ?? '—'}  rev=${r.revenue}  staff=${r.staff_cost}`)
}

console.log('\n═══ tracker_line_items for Rosali 2026-03 ════════════\n')
const tli = await get(`tracker_line_items?select=id,category,subcategory,label_sv,amount,source_upload_id&org_id=eq.${ORG}&business_id=eq.${ROSALI}&period_year=eq.2026&period_month=eq.3`)
console.log(`  ${tli.length} line items`)

console.log('\n═══ Deleting bogus rows ═════════════════════════════════\n')
for (const r of td) {
  console.log(`  DELETE tracker_data ${r.id}`)
  await del(`tracker_data?id=eq.${r.id}`)
}
for (const l of tli) {
  console.log(`  DELETE tracker_line_items ${l.id}`)
  await del(`tracker_line_items?id=eq.${l.id}`)
}

console.log('\n═══ Recomputing monthly_metrics ════════════════════════\n')
// Pull PK staff for the period
const staffLogs = await get(`staff_logs?select=shift_date,cost_actual,estimated_salary,hours_worked,is_late,ob_supplement_kr&org_id=eq.${ORG}&business_id=eq.${ROSALI}&shift_date=gte.2026-03-01&shift_date=lte.2026-03-31&or=(cost_actual.gt.0,estimated_salary.gt.0)&pk_log_url=not.like.%25_scheduled`)
const pkCost = staffLogs.reduce((s, r) => s + (Number(r.cost_actual ?? 0) > 0 ? Number(r.cost_actual) : Number(r.estimated_salary ?? 0)), 0)
const pkHours = staffLogs.reduce((s, r) => s + Number(r.hours_worked ?? 0), 0)
const oldest = await get(`staff_logs?select=shift_date&org_id=eq.${ORG}&business_id=eq.${ROSALI}&order=shift_date.asc&limit=1`)
const oldestDate = oldest?.[0]?.shift_date ?? null
const pkPredatesPeriod = oldestDate != null && oldestDate <= '2026-03-01'

// No tracker_data → no Fortnox staff to compare → PK wins as long as it has data + predates period.
let staff_cost, cost_source
if (staffLogs.length > 0) {
  staff_cost  = pkCost
  cost_source = pkPredatesPeriod ? 'pk' : 'pk_partial'
} else {
  staff_cost  = 0
  cost_source = 'none'
}

const newRow = {
  org_id:        ORG,
  business_id:   ROSALI,
  year:          2026,
  month:         3,
  revenue:       0,                 // no POS, no Fortnox
  staff_cost:    Math.round(staff_cost),
  food_cost:     0,
  rent_cost:     0,
  other_cost:    0,
  total_cost:    Math.round(staff_cost),
  hours_worked:  Math.round(pkHours * 10) / 10,
  shifts:        staffLogs.length,
  late_shifts:   staffLogs.filter(r => r.is_late).length,
  ob_supplement: Math.round(staffLogs.reduce((s, r) => s + Number(r.ob_supplement_kr ?? 0), 0)),
  net_profit:    -Math.round(staff_cost),     // staff with no revenue
  margin_pct:    0,
  labour_pct:    null,                         // revenue=0 → undefined
  food_pct:      null,
  rev_source:    'none',
  cost_source,
  pos_days_with_revenue: 0,
  updated_at:    new Date().toISOString(),
}

console.log(`  revenue:      ${newRow.revenue.toLocaleString('en-GB')} kr  (rev_source=${newRow.rev_source})`)
console.log(`  staff_cost:   ${newRow.staff_cost.toLocaleString('en-GB')} kr  (cost_source=${cost_source})`)
console.log(`  net_profit:   ${newRow.net_profit.toLocaleString('en-GB')} kr`)

console.log('\n  Writing monthly_metrics ...')
await upsert('monthly_metrics', newRow)
console.log('  ✅ Done')

console.log('\n═══ Verify — Rosali tracker_data after cleanup ════════\n')
const after = await get(`tracker_data?select=period_year,period_month,revenue,source&business_id=eq.${ROSALI}&period_year=eq.2026&order=period_month.asc`)
console.log(`  Remaining 2026 rows for Rosali: ${after.length}`)
for (const r of after) {
  console.log(`    ${r.period_year}-${String(r.period_month).padStart(2,'0')}  rev=${Number(r.revenue).toLocaleString('en-GB')} kr  source=${r.source}`)
}
