#!/usr/bin/env node
// scripts/fix-vero-march-2026.mjs
//
// One-shot: diagnose + fix Vero March 2026 revenue inflation.
//
// Step 1: Show what's in revenue_logs by provider for Mar 2026 — this
//         tells us EXACTLY which providers are stacking.
// Step 2: Show current monthly_metrics row.
// Step 3: Trigger re-aggregation by importing lib/sync/aggregate via the
//         Next.js code path. Uses the live Supabase via REST so we don't
//         need to bundle TypeScript.
//
// Usage:  node scripts/fix-vero-march-2026.mjs
// Reads:  .env.local for NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY

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
if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const ORG  = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function get(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers })
  if (!r.ok) { console.error('GET failed', path, await r.text()); process.exit(1) }
  return r.json()
}

async function patch(path, body) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body),
  })
  if (!r.ok) { console.error('PATCH failed', path, await r.text()); process.exit(1) }
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
console.log('  Vero March 2026 — diagnose + recompute')
console.log('═══════════════════════════════════════════════════════\n')

// ── 1. revenue_logs by provider for March 2026 ──────────────────────────
const revLogs = await get(`revenue_logs?select=revenue_date,revenue,provider,covers,food_revenue,bev_revenue&org_id=eq.${ORG}&business_id=eq.${VERO}&revenue_date=gte.2026-03-01&revenue_date=lte.2026-03-31`)
console.log(`📊 revenue_logs rows for March 2026: ${revLogs.length}`)

const byProvider = {}
for (const r of revLogs) {
  const p = r.provider ?? 'unknown'
  if (!byProvider[p]) byProvider[p] = { count: 0, total: 0, dates: new Set() }
  byProvider[p].count++
  byProvider[p].total += Number(r.revenue ?? 0)
  byProvider[p].dates.add(r.revenue_date)
}
console.log('\n  By provider:')
const summary = Object.entries(byProvider).sort((a, b) => b[1].total - a[1].total)
for (const [p, info] of summary) {
  console.log(`    ${p.padEnd(28)}  ${info.count.toString().padStart(3)} rows  ${Math.round(info.total).toLocaleString('en-GB').padStart(12)} kr  (${info.dates.size} unique dates)`)
}
const grandTotal = summary.reduce((s, [, i]) => s + i.total, 0)
console.log(`    ${'─'.repeat(60)}`)
console.log(`    ${'GRAND TOTAL (all summed)'.padEnd(28)}  ${''.padStart(3)}       ${Math.round(grandTotal).toLocaleString('en-GB').padStart(12)} kr`)

// ── 2. Apply the new dedup rules and compute the correct monthly total ──
console.log('\n📐 Applying new dedup rules (commit 7d8491c)')
const FULL_AGGREGATE_PROVIDERS = ['personalkollen', 'onslip', 'ancon', 'swess']
const datesWithPk    = new Set()
const datesWithInzii = new Set()
for (const r of revLogs) {
  const p = r.provider ?? ''
  if (p.startsWith('pk_'))    datesWithPk.add(r.revenue_date)
  if (p.startsWith('inzii_')) datesWithInzii.add(r.revenue_date)
}
const chosenAggregate = new Map()
for (const r of revLogs) {
  const p = r.provider ?? ''
  if (!FULL_AGGREGATE_PROVIDERS.includes(p)) continue
  const cur = chosenAggregate.get(r.revenue_date)
  if (!cur || FULL_AGGREGATE_PROVIDERS.indexOf(p) < FULL_AGGREGATE_PROVIDERS.indexOf(cur)) {
    chosenAggregate.set(r.revenue_date, p)
  }
}
let dedupDropped = 0
const kept = revLogs.filter(r => {
  const p = r.provider ?? ''
  if (p.startsWith('pk_') || p.startsWith('inzii_')) return true
  if (FULL_AGGREGATE_PROVIDERS.includes(p)) {
    if (datesWithPk.has(r.revenue_date) || datesWithInzii.has(r.revenue_date)) { dedupDropped++; return false }
    const win = chosenAggregate.get(r.revenue_date) === p
    if (!win) dedupDropped++
    return win
  }
  return true
})
const dedupedTotal = kept.reduce((s, r) => s + Number(r.revenue ?? 0), 0)
console.log(`    Dropped ${dedupDropped} double-count rows`)
console.log(`    Deduped revenue total: ${Math.round(dedupedTotal).toLocaleString('en-GB')} kr`)

// ── 3. Daily breakdown after dedup (sanity check) ───────────────────────
const dailySum = {}
const dailyFood = {}
const dailyBev = {}
const dailyCovers = {}
for (const r of kept) {
  dailySum[r.revenue_date]    = (dailySum[r.revenue_date]    ?? 0) + Number(r.revenue ?? 0)
  dailyFood[r.revenue_date]   = (dailyFood[r.revenue_date]   ?? 0) + Number(r.food_revenue ?? 0)
  dailyBev[r.revenue_date]    = (dailyBev[r.revenue_date]    ?? 0) + Number(r.bev_revenue ?? 0)
  dailyCovers[r.revenue_date] = (dailyCovers[r.revenue_date] ?? 0) + Number(r.covers ?? 0)
}
const sortedDates = Object.keys(dailySum).sort()
console.log(`\n📅 Per-day after dedup (${sortedDates.length} days)`)
for (const d of sortedDates) {
  console.log(`    ${d}  ${Math.round(dailySum[d]).toLocaleString('en-GB').padStart(8)} kr   covers=${Math.round(dailyCovers[d])}`)
}

// ── 4. Current monthly_metrics row ──────────────────────────────────────
const mm = await get(`monthly_metrics?select=*&business_id=eq.${VERO}&year=eq.2026&month=eq.3`)
console.log('\n📌 Current monthly_metrics row (BEFORE):')
if (mm.length === 0) {
  console.log('    (no row)')
} else {
  const m = mm[0]
  console.log(`    revenue:    ${Number(m.revenue).toLocaleString('en-GB')} kr   (rev_source=${m.rev_source ?? '—'})`)
  console.log(`    staff_cost: ${Number(m.staff_cost).toLocaleString('en-GB')} kr  (cost_source=${m.cost_source ?? '—'})`)
  console.log(`    food_cost:  ${Number(m.food_cost).toLocaleString('en-GB')} kr`)
  console.log(`    margin_pct: ${m.margin_pct}%`)
  console.log(`    labour_pct: ${m.labour_pct}%`)
  console.log(`    pos_days:   ${m.pos_days_with_revenue ?? '—'}`)
}

// ── 5. Pull staff_logs + tracker_data, recompute monthly_metrics  ───────
const staffLogs = await get(`staff_logs?select=shift_date,cost_actual,estimated_salary,hours_worked,is_late,ob_supplement_kr&org_id=eq.${ORG}&business_id=eq.${VERO}&shift_date=gte.2026-03-01&shift_date=lte.2026-03-31&or=(cost_actual.gt.0,estimated_salary.gt.0)&pk_log_url=not.like.%25_scheduled`)
const tracker   = await get(`tracker_data?select=period_year,period_month,revenue,food_cost,alcohol_cost,staff_cost,rent_cost,other_cost,depreciation,financial,source&business_id=eq.${VERO}&period_year=eq.2026&period_month=eq.3`)

const staffCost = staffLogs.reduce((s, r) => {
  const c = Number(r.cost_actual ?? 0) > 0 ? Number(r.cost_actual) : Number(r.estimated_salary ?? 0)
  return s + c
}, 0)
const hours  = staffLogs.reduce((s, r) => s + Number(r.hours_worked ?? 0), 0)
const shifts = staffLogs.length
const late   = staffLogs.filter(r => r.is_late).length
const ob     = staffLogs.reduce((s, r) => s + Number(r.ob_supplement_kr ?? 0), 0)

const t = tracker[0]
const food_cost    = Number(t?.food_cost    ?? 0)
const rent_cost    = Number(t?.rent_cost    ?? 0)
const other_cost   = Number(t?.other_cost   ?? 0)
const depreciation = Number(t?.depreciation ?? 0)
const financial    = Number(t?.financial    ?? 0)
const trackerRev   = Number(t?.revenue      ?? 0)
const trackerStaff = Number(t?.staff_cost   ?? 0)

const calendarDays = 31
const posDays = sortedDates.length
const posComplete = posDays / calendarDays >= 0.90
const posRevenue  = Math.round(dedupedTotal)

let revenue, rev_source
if (posDays > 0 && (posComplete || trackerRev === 0)) {
  revenue = posRevenue;  rev_source = posComplete ? 'pos' : 'pos_partial'
} else if (trackerRev > 0) {
  revenue = trackerRev;  rev_source = 'fortnox'
} else if (posDays > 0) {
  revenue = posRevenue;  rev_source = 'pos_partial'
} else {
  revenue = 0;           rev_source = 'none'
}

const staff_cost_use = staffCost > 0 ? staffCost : trackerStaff
const cost_source    = staffCost > 0 ? 'pk' : (trackerStaff > 0 ? 'fortnox' : 'none')
const total_cost     = staff_cost_use + food_cost + rent_cost + other_cost + depreciation
const net_profit     = revenue - total_cost + financial
const margin_pct     = revenue > 0 ? Math.round((net_profit / revenue) * 1000) / 10 : 0
const labour_pct     = revenue > 0 && staff_cost_use > 0 ? Math.round((staff_cost_use / revenue) * 1000) / 10 : null
const food_pct       = revenue > 0 && food_cost > 0 ? Math.round((food_cost / revenue) * 1000) / 10 : null

const newRow = {
  org_id:        ORG,
  business_id:   VERO,
  year:          2026,
  month:         3,
  revenue:       Math.round(revenue),
  staff_cost:    Math.round(staff_cost_use),
  food_cost:     Math.round(food_cost),
  rent_cost:     Math.round(rent_cost),
  other_cost:    Math.round(other_cost),
  total_cost:    Math.round(total_cost),
  hours_worked:  Math.round(hours * 10) / 10,
  shifts,
  late_shifts:   late,
  ob_supplement: Math.round(ob),
  net_profit:    Math.round(net_profit),
  margin_pct,
  labour_pct,
  food_pct,
  rev_source,
  cost_source,
  pos_days_with_revenue: posDays,
  updated_at:    new Date().toISOString(),
}

console.log('\n📌 Recomputed monthly_metrics row (AFTER):')
console.log(`    revenue:    ${newRow.revenue.toLocaleString('en-GB')} kr   (rev_source=${rev_source})`)
console.log(`    staff_cost: ${newRow.staff_cost.toLocaleString('en-GB')} kr  (cost_source=${cost_source})`)
console.log(`    food_cost:  ${newRow.food_cost.toLocaleString('en-GB')} kr`)
console.log(`    margin_pct: ${margin_pct}%`)
console.log(`    labour_pct: ${labour_pct}%`)
console.log(`    pos_days:   ${posDays} of ${calendarDays}`)

// ── 6. Confirm + write ──────────────────────────────────────────────────
console.log('\n💾 Writing recomputed row to monthly_metrics ...')
const written = await upsert('monthly_metrics', newRow)
console.log(`    ✅ Wrote ${written.length} row`)

console.log('\n═══════════════════════════════════════════════════════')
console.log('  Done. Reload /financials/performance to verify.')
console.log('═══════════════════════════════════════════════════════')
