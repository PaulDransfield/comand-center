#!/usr/bin/env node
// scripts/fix-rosali-march-2026.mjs
//
// Diagnoses + fixes Rosali March 2026: PK was connected mid-April, so
// March staff_cost in monthly_metrics is structurally partial (PK
// backfill ~386k vs the Fortnox figure of ~1.15M). The aggregator
// pre-2026-05-03 had no "PK predates period?" check and silently used
// the partial number, distorting labour %.
//
// This script applies the same "pkCoversPeriod" rule the aggregator
// now uses, recomputes monthly_metrics for Rosali March 2026, and
// writes the corrected row.
//
// Usage:  node scripts/fix-rosali-march-2026.mjs

import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.production.local', 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
)
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY

const ORG    = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'
const ROSALI = '97187ef3-b816-4c41-9230-7551430784a7'
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function get(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers })
  if (!r.ok) { console.error('GET failed', path, await r.text()); process.exit(1) }
  return r.json()
}
async function upsert(table, body) {
  const r = await fetch(`${URL}/rest/v1/${table}?on_conflict=business_id,year,month`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(body),
  })
  if (!r.ok) { console.error('UPSERT failed', table, await r.text()); process.exit(1) }
  return r.json()
}

console.log('═══════════════════════════════════════════════════════')
console.log('  Rosali March 2026 — diagnose + recompute')
console.log('═══════════════════════════════════════════════════════\n')

// ── Earliest PK staff date for Rosali ───────────────────────────────────
const oldest = await get(`staff_logs?select=shift_date&org_id=eq.${ORG}&business_id=eq.${ROSALI}&order=shift_date.asc&limit=1`)
const oldestStaffDate = oldest?.[0]?.shift_date ?? null
console.log(`📌 Earliest PK staff_log date: ${oldestStaffDate ?? '(none)'}`)

const periodStart = '2026-03-01'
const pkCoversPeriod = oldestStaffDate != null && oldestStaffDate <= periodStart
console.log(`   pkCoversPeriod (oldest <= ${periodStart})? ${pkCoversPeriod}\n`)

// ── tracker_data + monthly_metrics current state ────────────────────────
const tracker = await get(`tracker_data?select=*&business_id=eq.${ROSALI}&period_year=eq.2026&period_month=eq.3`)
const mm      = await get(`monthly_metrics?select=*&business_id=eq.${ROSALI}&year=eq.2026&month=eq.3`)
const t  = tracker[0]
const m0 = mm[0]

console.log('📊 tracker_data (Fortnox/manual source):')
console.log(`   revenue:      ${Number(t?.revenue).toLocaleString('en-GB')} kr  (source=${t?.source})`)
console.log(`   food_cost:    ${Number(t?.food_cost).toLocaleString('en-GB')} kr`)
console.log(`   alcohol_cost: ${Number(t?.alcohol_cost).toLocaleString('en-GB')} kr`)
console.log(`   staff_cost:   ${Number(t?.staff_cost).toLocaleString('en-GB')} kr`)
console.log(`   other_cost:   ${Number(t?.other_cost).toLocaleString('en-GB')} kr`)
console.log(`   depreciation: ${Number(t?.depreciation ?? 0).toLocaleString('en-GB')} kr`)
console.log(`   financial:    ${Number(t?.financial ?? 0).toLocaleString('en-GB')} kr`)
console.log(`   net_profit:   ${Number(t?.net_profit).toLocaleString('en-GB')} kr`)

console.log('\n📌 monthly_metrics BEFORE:')
if (m0) {
  console.log(`   revenue:      ${Number(m0.revenue).toLocaleString('en-GB')} kr  (rev_source=${m0.rev_source})`)
  console.log(`   staff_cost:   ${Number(m0.staff_cost).toLocaleString('en-GB')} kr  (cost_source=${m0.cost_source})`)
  console.log(`   labour_pct:   ${m0.labour_pct}%`)
  console.log(`   margin_pct:   ${m0.margin_pct}%`)
}

// ── PK staff for Rosali March 2026 (what PK has captured so far) ────────
const staffLogs = await get(`staff_logs?select=shift_date,cost_actual,estimated_salary,hours_worked,is_late,ob_supplement_kr&org_id=eq.${ORG}&business_id=eq.${ROSALI}&shift_date=gte.2026-03-01&shift_date=lte.2026-03-31&or=(cost_actual.gt.0,estimated_salary.gt.0)&pk_log_url=not.like.%25_scheduled`)
const pkStaffCost = staffLogs.reduce((s, r) => {
  const c = Number(r.cost_actual ?? 0) > 0 ? Number(r.cost_actual) : Number(r.estimated_salary ?? 0)
  return s + c
}, 0)
const pkHours = staffLogs.reduce((s, r) => s + Number(r.hours_worked ?? 0), 0)
console.log(`\n📊 PK staff for March 2026 (post-connection backfill):`)
console.log(`   ${staffLogs.length} shifts   cost=${Math.round(pkStaffCost).toLocaleString('en-GB')} kr   hours=${Math.round(pkHours)}`)

// ── revenue_logs by provider (sanity) ───────────────────────────────────
const revLogs = await get(`revenue_logs?select=revenue,provider&org_id=eq.${ORG}&business_id=eq.${ROSALI}&revenue_date=gte.2026-03-01&revenue_date=lte.2026-03-31`)
console.log(`\n📊 revenue_logs for March 2026: ${revLogs.length} rows`)
const byProv = {}
for (const r of revLogs) {
  const p = r.provider ?? 'unknown'
  byProv[p] = (byProv[p] ?? 0) + Number(r.revenue ?? 0)
}
for (const [p, v] of Object.entries(byProv)) {
  console.log(`   ${p.padEnd(28)}  ${Math.round(v).toLocaleString('en-GB').padStart(12)} kr`)
}

// ── Apply new aggregator rule ───────────────────────────────────────────
const trackerRev   = Number(t?.revenue ?? 0)
const trackerStaff = Number(t?.staff_cost ?? 0)
const food_cost    = Number(t?.food_cost ?? 0)
const rent_cost    = Number(t?.rent_cost ?? 0)
const other_cost   = Number(t?.other_cost ?? 0)
const depreciation = Number(t?.depreciation ?? 0)
const financial    = Number(t?.financial ?? 0)
const hasPosRev    = revLogs.length > 0

let revenue, rev_source
if (hasPosRev) {
  revenue = revLogs.reduce((s, r) => s + Number(r.revenue ?? 0), 0)
  rev_source = 'pos_partial'
} else if (trackerRev > 0) {
  revenue = trackerRev
  rev_source = 'fortnox'
} else {
  revenue = 0
  rev_source = 'none'
}

const hasPkStaff = staffLogs.length > 0
const pkVsFortnox = (hasPkStaff && trackerStaff > 0) ? pkStaffCost / trackerStaff : null
const pkAgrees = pkVsFortnox === null || (pkVsFortnox >= 0.70 && pkVsFortnox <= 1.30)
console.log(`\n📐 PK vs Fortnox staff agreement check:`)
console.log(`   PK staff:        ${Math.round(pkStaffCost).toLocaleString('en-GB')} kr`)
console.log(`   Fortnox staff:   ${trackerStaff.toLocaleString('en-GB')} kr`)
console.log(`   ratio:           ${pkVsFortnox !== null ? (pkVsFortnox * 100).toFixed(1) + '%' : 'n/a'}`)
console.log(`   agrees (70-130%): ${pkAgrees}`)

let staff_cost, cost_source
if (hasPkStaff && pkCoversPeriod && pkAgrees) {
  staff_cost  = pkStaffCost
  cost_source = 'pk'
} else if (trackerStaff > 0) {
  staff_cost  = trackerStaff
  cost_source = hasPkStaff
    ? (pkCoversPeriod ? 'fortnox_pk_disagrees' : 'fortnox_pk_partial')
    : 'fortnox'
} else if (hasPkStaff) {
  staff_cost  = pkStaffCost
  cost_source = pkCoversPeriod ? 'pk' : 'pk_partial'
} else {
  staff_cost  = 0
  cost_source = 'none'
}

const total_cost = staff_cost + food_cost + rent_cost + other_cost + depreciation
const net_profit = revenue - total_cost + financial
const margin_pct = revenue > 0 ? Math.round((net_profit / revenue) * 1000) / 10 : 0
const labour_pct = revenue > 0 && staff_cost > 0 ? Math.round((staff_cost / revenue) * 1000) / 10 : null
const food_pct   = revenue > 0 && food_cost  > 0 ? Math.round((food_cost  / revenue) * 1000) / 10 : null

console.log('\n📌 Recomputed monthly_metrics row (AFTER):')
console.log(`   revenue:      ${Math.round(revenue).toLocaleString('en-GB')} kr  (rev_source=${rev_source})`)
console.log(`   staff_cost:   ${Math.round(staff_cost).toLocaleString('en-GB')} kr  (cost_source=${cost_source})`)
console.log(`   food_cost:    ${Math.round(food_cost).toLocaleString('en-GB')} kr`)
console.log(`   labour_pct:   ${labour_pct}%`)
console.log(`   margin_pct:   ${margin_pct}%`)
console.log(`   net_profit:   ${Math.round(net_profit).toLocaleString('en-GB')} kr`)

// ── Write ───────────────────────────────────────────────────────────────
const newRow = {
  org_id:        ORG,
  business_id:   ROSALI,
  year:          2026,
  month:         3,
  revenue:       Math.round(revenue),
  staff_cost:    Math.round(staff_cost),
  food_cost:     Math.round(food_cost),
  rent_cost:     Math.round(rent_cost),
  other_cost:    Math.round(other_cost),
  total_cost:    Math.round(total_cost),
  hours_worked:  Math.round(pkHours * 10) / 10,
  shifts:        staffLogs.length,
  late_shifts:   staffLogs.filter(r => r.is_late).length,
  ob_supplement: Math.round(staffLogs.reduce((s, r) => s + Number(r.ob_supplement_kr ?? 0), 0)),
  net_profit:    Math.round(net_profit),
  margin_pct,
  labour_pct,
  food_pct,
  rev_source,
  cost_source,
  pos_days_with_revenue: new Set(revLogs.map(r => r.revenue_date)).size,
  updated_at:    new Date().toISOString(),
}

console.log('\n💾 Writing to monthly_metrics ...')
const written = await upsert('monthly_metrics', newRow)
console.log(`   ✅ Wrote ${written.length} row`)

console.log('\n═══════════════════════════════════════════════════════')
console.log('  Done. Reload /financials/performance and pick Rosali.')
console.log('═══════════════════════════════════════════════════════')
