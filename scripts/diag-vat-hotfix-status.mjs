#!/usr/bin/env node
// scripts/diag-vat-hotfix-status.mjs
//
// VAT hotfix status check Part B (data). Read-only.
// Per vat-hotfix-status-check-prompt.md.

import { readFileSync } from 'node:fs'

function parseEnv(p) {
  try {
    return Object.fromEntries(readFileSync(p, 'utf8').split('\n')
      .filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }))
  } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H })
  if (!r.ok) throw new Error(`${path}: ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json()
}

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

// ─── Q1. Vero monthly revenue split, Jan-May 2026 ───
console.log(`${'═'.repeat(78)}\n  Q1. Vero monthly revenue split — Jan-May 2026 (look for stepup in takeaway at/after Apr)\n${'═'.repeat(78)}`)
const veroTracker = await q(
  `tracker_data?select=period_year,period_month,revenue,dine_in_revenue,takeaway_revenue,alcohol_revenue,updated_at` +
  `&business_id=eq.${VERO}` +
  `&period_year=eq.2026` +
  `&period_month=lte.5` +
  `&or=(is_provisional.is.null,is_provisional.eq.false)` +
  `&order=period_month`
)
console.log(`  period | revenue   | dine_in   | takeaway  | alcohol   | takeaway%`)
for (const t of veroTracker) {
  const tot = Number(t.revenue ?? 0)
  const dn  = Number(t.dine_in_revenue ?? 0)
  const ta  = Number(t.takeaway_revenue ?? 0)
  const al  = Number(t.alcohol_revenue ?? 0)
  const tapct = tot ? (100 * ta / tot).toFixed(1) : 'n/a'
  console.log(`  2026-${String(t.period_month).padStart(2,'0')} | ${tot.toFixed(0).padStart(9)} | ${dn.toFixed(0).padStart(9)} | ${ta.toFixed(0).padStart(9)} | ${al.toFixed(0).padStart(9)} | ${tapct}%`)
}

// ─── Q2. Vero — is account 3053 still landing in takeaway? ───
console.log(`\n${'═'.repeat(78)}\n  Q2. Vero — account 3053 (Försäljning varor 6% moms Sv) per-period subcategory\n${'═'.repeat(78)}`)
const acct3053 = await q(
  `tracker_line_items?select=period_year,period_month,fortnox_account,subcategory,amount,label_sv` +
  `&business_id=eq.${VERO}` +
  `&fortnox_account=eq.3053` +
  `&period_year=eq.2026` +
  `&order=period_month`
)
if (acct3053.length === 0) {
  console.log(`  (no rows at account=3053 for Vero 2026)`)
} else {
  console.log(`  period | account | subcategory   | amount     | label`)
  for (const r of acct3053) {
    console.log(`  2026-${String(r.period_month).padStart(2,'0')} | ${r.fortnox_account}    | ${(r.subcategory ?? 'null').padEnd(13)} | ${Number(r.amount ?? 0).toFixed(0).padStart(10)} | ${r.label_sv ?? ''}`)
  }
}

// ─── Q3. Vero — ANY 6% moms revenue lines now? ───
console.log(`\n${'═'.repeat(78)}\n  Q3. Vero — ALL '6%' labelled revenue lines in 2026 (any still tagged 'takeaway' subcategory?)\n${'═'.repeat(78)}`)
const sixPct = await q(
  `tracker_line_items?select=period_year,period_month,fortnox_account,subcategory,amount,label_sv` +
  `&business_id=eq.${VERO}` +
  `&period_year=eq.2026` +
  `&or=(label_sv.ilike.*6%25*moms*,fortnox_account.eq.3053)` +
  `&order=period_month`
)
console.log(`  ${sixPct.length} rows found`)
const tagAsTakeaway = sixPct.filter(r => r.subcategory === 'takeaway')
const tagOther = sixPct.filter(r => r.subcategory !== 'takeaway')
console.log(`  ⚠️  Tagged 'takeaway' subcategory (would be misrouting if not Wolt/Foodora): ${tagAsTakeaway.length}`)
for (const r of tagAsTakeaway.slice(0, 20)) {
  console.log(`    2026-${String(r.period_month).padStart(2,'0')} acct=${r.fortnox_account} sub=takeaway amount=${Number(r.amount ?? 0).toFixed(0)} "${r.label_sv ?? ''}"`)
}
console.log(`  Other subcategory (correctly unclassified or non-takeaway): ${tagOther.length}`)
for (const r of tagOther.slice(0, 5)) {
  console.log(`    2026-${String(r.period_month).padStart(2,'0')} acct=${r.fortnox_account} sub=${r.subcategory ?? 'null'} amount=${Number(r.amount ?? 0).toFixed(0)} "${r.label_sv ?? ''}"`)
}

// ─── Q4. Chicce — has any 6% account been added? ───
console.log(`\n${'═'.repeat(78)}\n  Q4. Chicce — any 6%-moms revenue lines? (was clean pre-verdict)\n${'═'.repeat(78)}`)
const chicceTracker = await q(
  `tracker_data?select=period_year,period_month,revenue,dine_in_revenue,takeaway_revenue,alcohol_revenue,updated_at` +
  `&business_id=eq.${CHICCE}` +
  `&period_year=eq.2026` +
  `&period_month=lte.5` +
  `&or=(is_provisional.is.null,is_provisional.eq.false)` +
  `&order=period_month`
)
console.log(`  Chicce tracker_data Jan-May 2026:`)
console.log(`  period | revenue   | dine_in   | takeaway  | alcohol   | takeaway%`)
for (const t of chicceTracker) {
  const tot = Number(t.revenue ?? 0)
  const dn  = Number(t.dine_in_revenue ?? 0)
  const ta  = Number(t.takeaway_revenue ?? 0)
  const al  = Number(t.alcohol_revenue ?? 0)
  const tapct = tot ? (100 * ta / tot).toFixed(1) : 'n/a'
  console.log(`  2026-${String(t.period_month).padStart(2,'0')} | ${tot.toFixed(0).padStart(9)} | ${dn.toFixed(0).padStart(9)} | ${ta.toFixed(0).padStart(9)} | ${al.toFixed(0).padStart(9)} | ${tapct}%`)
}

const chicceSixPct = await q(
  `tracker_line_items?select=period_year,period_month,fortnox_account,subcategory,amount,label_sv` +
  `&business_id=eq.${CHICCE}` +
  `&period_year=eq.2026` +
  `&label_sv=ilike.*6%25*moms*` +
  `&order=period_month`
)
console.log(`\n  Chicce '6%' labelled lines: ${chicceSixPct.length}`)
for (const r of chicceSixPct.slice(0, 10)) {
  console.log(`    2026-${String(r.period_month).padStart(2,'0')} acct=${r.fortnox_account} sub=${r.subcategory ?? 'null'} amount=${Number(r.amount ?? 0).toFixed(0)} "${r.label_sv ?? ''}"`)
}

// ─── Q5. Latest ingest — when did each business last update tracker_data? ───
console.log(`\n${'═'.repeat(78)}\n  Q5. Latest tracker_data update per business\n${'═'.repeat(78)}`)
const latestVero = await q(
  `tracker_data?select=period_year,period_month,updated_at,takeaway_revenue,revenue,source` +
  `&business_id=eq.${VERO}` +
  `&order=updated_at.desc&limit=5`
)
console.log(`  Vero latest 5 tracker_data updates:`)
for (const r of latestVero) {
  console.log(`    2026-${String(r.period_month).padStart(2,'0')} updated=${r.updated_at} source=${r.source ?? '?'} ta=${Number(r.takeaway_revenue ?? 0).toFixed(0)} rev=${Number(r.revenue ?? 0).toFixed(0)}`)
}
const latestChicce = await q(
  `tracker_data?select=period_year,period_month,updated_at,takeaway_revenue,revenue,source` +
  `&business_id=eq.${CHICCE}` +
  `&order=updated_at.desc&limit=5`
)
console.log(`  Chicce latest 5 tracker_data updates:`)
for (const r of latestChicce) {
  console.log(`    2026-${String(r.period_month).padStart(2,'0')} updated=${r.updated_at} source=${r.source ?? '?'} ta=${Number(r.takeaway_revenue ?? 0).toFixed(0)} rev=${Number(r.revenue ?? 0).toFixed(0)}`)
}

console.log(`\nDone. Read-only — no writes.`)
