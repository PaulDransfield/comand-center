#!/usr/bin/env node
// scripts/fix-fortnox-mixup.mjs
//
// 2026-05-11 emergency cleanup. Owner re-OAuthed Fortnox under Rosali in
// the sidebar instead of Vero — Vero's actual Fortnox credentials got
// stored on Rosali's integration row and ~4 hours of backfill ran,
// writing Vero's financial data into Rosali's books.
//
// Four steps, sequential with verification:
//   1. DELETE Vero's old disconnected integration row (frees unique constraint)
//   2. UPDATE Rosali's integration row → set business_id = Vero
//   3. DELETE Rosali's polluted tracker_data rows (created today via fortnox_backfill)
//   4. DELETE Rosali's polluted overhead_drilldown_cache rows (fetched today)
//
// Plus reports what's still in Rosali's monthly_metrics for the affected
// months so we know whether re-aggregation is needed.

import { readFileSync } from 'node:fs'

function parseEnv(path) {
  try { return Object.fromEntries(readFileSync(path, 'utf8').split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g, '')] })) } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) { console.error('missing supabase env'); process.exit(1) }

const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const ROSALI = '97187ef3-b816-4c41-9230-7551430784a7'
const VERO_OLD_INTEG   = 'bc1ee820-bbe8-46fe-b97f-4551ea8e43b7'
const ROSALI_BAD_INTEG = 'a2b056be-9d4d-43d2-8f84-9a5bdb8fbd11'
const POLLUTION_CUTOFF_ISO = '2026-05-11T07:00:00Z'   // anything created at/after this on Rosali = today's mistake

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function pg(method, path, params = {}, body = null) {
  const qs = new URLSearchParams(params).toString()
  const r = await fetch(`${URL}/rest/v1/${path}${qs ? '?' + qs : ''}`, {
    method,
    headers: { ...H, ...(body ? { 'content-type': 'application/json', Prefer: 'return=representation' } : { Prefer: 'return=representation' }) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${text}`)
  return text ? JSON.parse(text) : null
}

// ── Step 1: DELETE Vero's old disconnected integration row ────────────
console.log('── Step 1: DELETE Vero\'s old disconnected integration row ──')
const step1 = await pg('DELETE', 'integrations', { id: `eq.${VERO_OLD_INTEG}`, status: 'eq.disconnected' })
console.log(`  deleted: ${JSON.stringify(step1)}`)

// Verify
const remainingVero = await pg('GET', 'integrations', { business_id: `eq.${VERO}`, provider: 'eq.fortnox', select: 'id,status' })
console.log(`  remaining Vero fortnox rows: ${remainingVero.length} (expect 0)\n`)
if (remainingVero.length !== 0) {
  console.error('  ✗ Step 1 verification failed — aborting before destructive step 2.')
  process.exit(1)
}

// ── Step 2: UPDATE Rosali's row → business_id = Vero ──────────────────
console.log('── Step 2: UPDATE Rosali\'s integration row → business_id = Vero ──')
const step2 = await pg('PATCH', 'integrations', { id: `eq.${ROSALI_BAD_INTEG}` }, { business_id: VERO })
console.log(`  updated: ${JSON.stringify(step2)}`)

// Verify
const verified = await pg('GET', 'integrations', { id: `eq.${ROSALI_BAD_INTEG}`, select: 'id,business_id,status' })
console.log(`  row now reads: ${JSON.stringify(verified)}`)
if (verified[0]?.business_id !== VERO) {
  console.error('  ✗ Step 2 verification failed — aborting.')
  process.exit(1)
}
console.log()

// ── Step 3: DELETE Rosali's polluted tracker_data rows ────────────────
console.log('── Step 3: DELETE Rosali\'s tracker_data fortnox_api rows created today ──')
// Inspect first
const polluted = await pg('GET', 'tracker_data', {
  business_id: `eq.${ROSALI}`,
  source:      'eq.fortnox_api',
  created_at:  `gte.${POLLUTION_CUTOFF_ISO}`,
  select:      'id,period_year,period_month,created_at,revenue,staff_cost,food_cost',
  order:       'created_at',
})
console.log(`  polluted rows to delete (${polluted.length}):`)
for (const r of polluted) console.log(`    ${r.period_year}-${String(r.period_month).padStart(2,'0')}  created=${r.created_at}  rev=${r.revenue} staff=${r.staff_cost} food=${r.food_cost}`)
const delIds = polluted.map(r => r.id)
if (delIds.length) {
  await pg('DELETE', 'tracker_data', { id: `in.(${delIds.join(',')})` })
  console.log(`  deleted ${delIds.length} rows`)
}
console.log()

// ── Step 4: DELETE Rosali's polluted overhead_drilldown_cache rows ────
console.log('── Step 4: DELETE Rosali\'s overhead_drilldown_cache rows fetched today ──')
const cacheRows = await pg('GET', 'overhead_drilldown_cache', {
  business_id: `eq.${ROSALI}`,
  fetched_at:  `gte.${POLLUTION_CUTOFF_ISO}`,
  select:      'business_id,period_year,period_month,category,fetched_at',
})
console.log(`  polluted cache rows (${cacheRows.length}):`)
for (const r of cacheRows) console.log(`    ${r.period_year}-${String(r.period_month).padStart(2,'0')} ${r.category}  fetched=${r.fetched_at}`)
if (cacheRows.length) {
  await pg('DELETE', 'overhead_drilldown_cache', {
    business_id: `eq.${ROSALI}`,
    fetched_at:  `gte.${POLLUTION_CUTOFF_ISO}`,
  })
  console.log(`  deleted ${cacheRows.length} rows`)
}
console.log()

// ── Report: Rosali's monthly_metrics for the affected periods ─────────
// monthly_metrics is derived from tracker_data + other sources via aggregation.
// If the polluted tracker_data was already aggregated, Rosali's monthly_metrics
// will be wrong for those months. Show the user so they can decide whether
// to re-aggregate.
console.log('── Diagnostic: Rosali\'s monthly_metrics for the affected months ──')
const mm = await pg('GET', 'monthly_metrics', {
  business_id: `eq.${ROSALI}`,
  'or':        '(and(year.eq.2026,month.gte.2),and(year.eq.2026,month.eq.5))',
  select:      'year,month,revenue,staff_cost,food_cost,net_profit,updated_at',
  order:       'year,month',
})
for (const m of mm) console.log(`    ${m.year}-${String(m.month).padStart(2,'0')}  rev=${m.revenue}  staff=${m.staff_cost}  food=${m.food_cost}  updated=${m.updated_at}`)

console.log('\n[fix] DONE.')
console.log('Next steps:')
console.log('  - If Rosali\'s monthly_metrics above look like Vero numbers (revenue too high), run /api/admin/reaggregate for Rosali to rebuild from clean tracker_data.')
console.log('  - Vero\'s integration is back online with the fresh OAuth tokens — her dashboard should resume showing real Fortnox data.')
