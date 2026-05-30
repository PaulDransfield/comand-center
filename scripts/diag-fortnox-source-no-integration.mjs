#!/usr/bin/env node
// scripts/diag-fortnox-source-no-integration.mjs
//
// Pre-cleanup safety sweep for ROSALI-FORTNOX-CLEANUP-PLAN.md §8.
//
// Question:
//   Are there any other businesses with the same contamination pattern as
//   Rosali Deli — i.e. tracker_data rows whose `source` starts with
//   'fortnox_' but the business has NO Fortnox integration row?
//
// If the answer is "only Rosali", the per-business cleanup script can ship
// pinned to Rosali. If anything else surfaces, the cleanup needs to be
// reshaped as a general per-business utility.
//
// Read-only. No INSERT/UPDATE/DELETE. Outputs aggregates only.
// Service-role bypasses RLS so this sees ALL businesses across ALL orgs.

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
if (!URL || !KEY) { console.error('Missing env'); process.exit(1) }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H })
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json()
}

const ROSALI = '97187ef3-b816-4c41-9230-7551430784a7'

console.log('\n═══ Pre-cleanup sweep — fortnox-source rows on un-integrated businesses ═══\n')

// 1. Every business + its org name
const businesses = await q('businesses?select=id,name,org_id,is_active&order=name.asc&limit=500')
console.log(`Total businesses in DB: ${businesses.length}`)
console.log(`(Service-role query — sees every org, every business)\n`)

// 2. Every Fortnox integration (any status, any business)
const fortnoxIntegs = await q('integrations?select=business_id,org_id,status,created_at,last_sync_at&provider=eq.fortnox&limit=500')
const bizWithFortnox = new Set(fortnoxIntegs.filter(i => i.business_id).map(i => i.business_id))
console.log(`Businesses with a Fortnox integration row: ${bizWithFortnox.size}`)
for (const i of fortnoxIntegs) {
  const b = businesses.find(x => x.id === i.business_id)
  console.log(`  ✓ ${b?.name?.padEnd(30) ?? '(unknown biz)'.padEnd(30)} status=${i.status.padEnd(10)} last_sync=${i.last_sync_at ?? '(never)'}`)
}

// 3. Per-business: count tracker_data rows with source LIKE 'fortnox_%'
//    (PostgREST doesn't have a single SQL aggregate across all businesses
//    without a view; do it as N+1 — fine because N is small.)
console.log(`\nPer-business tracker_data audit:\n`)
console.log(`  ${'business'.padEnd(30)} ${'integ?'.padEnd(8)} ${'fortnox_rows'.padEnd(12)} ${'manual'.padEnd(8)} ${'pos'.padEnd(8)} ${'other'.padEnd(8)}`)
console.log(`  ${'─'.repeat(30)} ${'─'.repeat(8)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)}`)

const contaminated = []
for (const b of businesses) {
  const rows = await q(`tracker_data?select=source&business_id=eq.${b.id}&limit=2000`)
  const buckets = { fortnox: 0, manual: 0, pos: 0, other: 0 }
  for (const r of rows) {
    const s = r.source ?? ''
    if (s.startsWith('fortnox_')) buckets.fortnox++
    else if (s === 'manual')      buckets.manual++
    else if (s === 'pos')         buckets.pos++
    else                          buckets.other++
  }
  const hasInteg = bizWithFortnox.has(b.id)
  const flag = buckets.fortnox > 0 && !hasInteg ? '  ⚠️ CONTAMINATED' : ''
  console.log(
    `  ${b.name.padEnd(30)} ${(hasInteg ? 'YES' : 'no').padEnd(8)} ${String(buckets.fortnox).padEnd(12)} ${String(buckets.manual).padEnd(8)} ${String(buckets.pos).padEnd(8)} ${String(buckets.other).padEnd(8)}${flag}`
  )
  if (buckets.fortnox > 0 && !hasInteg) {
    contaminated.push({ business: b, fortnoxRows: buckets.fortnox })
  }
}

// 4. Contamination summary
console.log('\n═══ Contamination summary ════════════════════════════════════════════════')
if (contaminated.length === 0) {
  console.log('  ✅ No contamination found anywhere.')
} else {
  console.log(`  Found ${contaminated.length} business(es) with fortnox_* tracker_data but no Fortnox integration:\n`)
  for (const c of contaminated) {
    const isRosali = c.business.id === ROSALI
    console.log(`    ${isRosali ? '(EXPECTED) ' : '⚠️ UNEXPECTED  '}${c.business.name}`)
    console.log(`      id=${c.business.id}  org_id=${c.business.org_id}  rows=${c.fortnoxRows}`)
  }
  console.log('')
  if (contaminated.length === 1 && contaminated[0].business.id === ROSALI) {
    console.log('  ✅ Only Rosali. Cleanup script can ship pinned to Rosali.')
  } else {
    console.log('  ⚠️ More than just Rosali. Cleanup script must be reshaped as a per-business utility.')
  }
}

// 5. Inverse check: businesses with Fortnox integration but no rows
//    (informational; not a bug, just useful to see)
console.log('\n═══ Businesses WITH Fortnox integration but no fortnox_* tracker rows ════')
let inverseCount = 0
for (const b of businesses) {
  if (!bizWithFortnox.has(b.id)) continue
  const rows = await q(`tracker_data?select=source&business_id=eq.${b.id}&source=like.fortnox_*&limit=1`)
  if (rows.length === 0) {
    console.log(`  · ${b.name}  (Fortnox connected but no rows yet — likely fresh OAuth)`)
    inverseCount++
  }
}
if (inverseCount === 0) console.log('  (none)')

// 6. fortnox_uploads sanity — check for uploads attributed to businesses with no Fortnox integration
console.log('\n═══ fortnox_uploads on businesses without Fortnox integration ════════════')
const allUploads = await q('fortnox_uploads?select=business_id,period_year,period_month,status,pdf_filename,created_at&limit=2000')
const orphanUploads = allUploads.filter(u => u.business_id && !bizWithFortnox.has(u.business_id))
if (orphanUploads.length === 0) {
  console.log('  (none — every fortnox_upload is attributed to a business with a Fortnox integration)')
} else {
  console.log(`  ${orphanUploads.length} uploads on businesses with NO Fortnox integration:\n`)
  const byBiz = orphanUploads.reduce((m, u) => { (m[u.business_id] ||= []).push(u); return m }, {})
  for (const [bizId, ups] of Object.entries(byBiz)) {
    const b = businesses.find(x => x.id === bizId)
    console.log(`    ${b?.name ?? '(unknown)'} (${bizId}) — ${ups.length} upload(s)`)
    for (const u of ups) {
      console.log(`      ${u.period_year}-${String(u.period_month ?? 0).padStart(2,'0')}  ${u.status.padEnd(10)} ${u.pdf_filename ?? '(no filename)'}  ${u.created_at}`)
    }
  }
}

console.log('\nDone. Read-only — no rows changed.\n')
