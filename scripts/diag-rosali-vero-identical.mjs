#!/usr/bin/env node
// scripts/diag-rosali-vero-identical.mjs
//
// Rosali / Vero identical-data diagnostic (READ-ONLY).
// Sourced from `rosali-vero-diagnostic-prompt.md`.
//
// Question chain:
//   1. Same org_id, or cross-tenant?
//   2. Same Fortnox integration / same Fortnox tenant?  (Compare HASHES only;
//      never print credentials_enc.)
//   3. Is the cross-attribution in the aggregate (tracker_data) only, or
//      does it reach the raw source rows (supplier_invoice_lines, vouchers)?
//   4. Does Rosali have ANY genuine data of its own, ever?
//   5. What's the timestamp/source/created_via pattern on Rosali's Jan row?
//
// All queries are GET (= SELECT) against PostgREST. Service role key bypasses
// RLS so we see all rows; no INSERT/UPDATE/DELETE/ALTER anywhere.
// Output is aggregates / counts / match-status only. Never prints raw secrets.

import { readFileSync }      from 'node:fs'
import { createHash }        from 'node:crypto'

// ── Env loading (same pattern as scripts/cleanup-rosali-march-2026.mjs) ──
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
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.')
  process.exit(1)
}
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` }

// Known IDs from CLAUDE.md
const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const ROSALI = '97187ef3-b816-4c41-9230-7551430784a7'

async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`GET ${path} → HTTP ${r.status}: ${txt.slice(0, 300)}`)
  }
  return r.json()
}

// Short hash for safe credential-equality comparison (no plaintext printed).
function shortHash(s) {
  if (s == null) return '(null)'
  return createHash('sha256').update(String(s)).digest('hex').slice(0, 12)
}

const section = (title) => {
  console.log('\n' + '═'.repeat(74))
  console.log(title)
  console.log('═'.repeat(74))
}

// ───────────────────────────────────────────────────────────────────────────
// Q1 — tenancy boundary
// ───────────────────────────────────────────────────────────────────────────
section('Q1 — tenancy boundary: same org_id?')

const bizRows = await q(
  `businesses?select=id,name,org_id,is_active,created_at,country&id=in.(${VERO},${ROSALI})`
)
console.log(`businesses rows: ${bizRows.length}\n`)
for (const b of bizRows) {
  console.log(`  ${b.name.padEnd(24)} id=${b.id}  org_id=${b.org_id}  active=${b.is_active}  created=${b.created_at}`)
}
const orgIds = [...new Set(bizRows.map(b => b.org_id))]
console.log(`\n  distinct org_ids: ${orgIds.length}  →  ${orgIds.length === 1 ? 'SAME ORG (intra-org bug)' : 'DIFFERENT ORGS (cross-tenant — ESCALATE)'}`)

// All businesses under each org for context.
for (const oid of orgIds) {
  const all = await q(`businesses?select=id,name,is_active&org_id=eq.${oid}&order=created_at.asc`)
  console.log(`\n  org ${oid} has ${all.length} business(es):`)
  for (const b of all) console.log(`    ${b.is_active ? '✓' : '·'} ${b.name} (${b.id})`)
}

// ───────────────────────────────────────────────────────────────────────────
// Q2 — Fortnox integration: same tenant, same credentials?
// ───────────────────────────────────────────────────────────────────────────
section('Q2 — Fortnox integration: same Fortnox tenant?')

// Pull integrations rows (do NOT print credentials_enc — only its hash).
const integ = await q(
  `integrations?select=id,org_id,business_id,provider,status,credentials_enc,token_expires_at,last_sync_at,fortnox_workspace_id,created_at&business_id=in.(${VERO},${ROSALI})&provider=eq.fortnox`
)
console.log(`integrations(provider=fortnox) rows for these businesses: ${integ.length}\n`)
for (const i of integ) {
  const ourBiz = i.business_id === VERO ? 'Vero' : i.business_id === ROSALI ? 'Rosali' : '(other)'
  console.log(`  ${ourBiz.padEnd(8)} id=${i.id}`)
  console.log(`           status=${i.status}  workspace_id=${i.fortnox_workspace_id ?? '(null)'}`)
  console.log(`           creds_hash=${shortHash(i.credentials_enc)}  token_exp=${i.token_expires_at ?? '(null)'}  last_sync=${i.last_sync_at ?? '(null)'}`)
  console.log(`           created=${i.created_at}`)
}
if (integ.length === 2) {
  const sameCreds = integ[0].credentials_enc === integ[1].credentials_enc
  const sameWs    = integ[0].fortnox_workspace_id != null && integ[0].fortnox_workspace_id === integ[1].fortnox_workspace_id
  console.log(`\n  Credentials byte-identical? ${sameCreds ? 'YES (same Fortnox tenant — both businesses talk to the same Fortnox)' : 'NO'}`)
  console.log(`  fortnox_workspace_id match? ${sameWs ? 'YES' : 'NO / one is null'}`)
}

// ───────────────────────────────────────────────────────────────────────────
// Q3 — Rosali Jan 2026 tracker_data row provenance
// ───────────────────────────────────────────────────────────────────────────
section('Q3 — Rosali & Vero Jan 2026 tracker_data row provenance')

const td = await q(
  `tracker_data?select=id,business_id,period_year,period_month,revenue,dine_in_revenue,takeaway_revenue,alcohol_revenue,food_cost,staff_cost,source,created_via,created_at,updated_at,fortnox_upload_id,is_provisional&period_year=eq.2026&period_month=eq.1&business_id=in.(${VERO},${ROSALI})`
)
console.log(`tracker_data rows: ${td.length}\n`)
for (const r of td) {
  const who = r.business_id === VERO ? 'Vero' : 'Rosali'
  console.log(`  ${who}`)
  console.log(`     id=${r.id}`)
  console.log(`     revenue=${r.revenue}  dine_in=${r.dine_in_revenue}  takeaway=${r.takeaway_revenue}  alcohol=${r.alcohol_revenue}`)
  console.log(`     source=${r.source}  created_via=${r.created_via ?? '(null)'}  fortnox_upload_id=${r.fortnox_upload_id ?? '(null)'}`)
  console.log(`     created_at=${r.created_at}  updated_at=${r.updated_at}  provisional=${r.is_provisional ?? '(null)'}`)
}
if (td.length === 2) {
  const a = td.find(x => x.business_id === VERO)
  const b = td.find(x => x.business_id === ROSALI)
  const eqNumbers = ['revenue','dine_in_revenue','takeaway_revenue','alcohol_revenue','food_cost','staff_cost'].every(k => Number(a[k]) === Number(b[k]))
  console.log(`\n  All financial numbers byte-equal? ${eqNumbers ? 'YES' : 'NO'}`)
  console.log(`  Same created_at? ${a.created_at === b.created_at ? 'YES (almost-certain copy)' : `NO — Vero ${a.created_at} vs Rosali ${b.created_at}`}`)
  console.log(`  Same fortnox_upload_id? ${(a.fortnox_upload_id ?? '_a') === (b.fortnox_upload_id ?? '_b') ? 'YES' : 'NO'}`)
}

// ───────────────────────────────────────────────────────────────────────────
// Q4 — Rosali period coverage: does Rosali have ANY genuine data?
// ───────────────────────────────────────────────────────────────────────────
section('Q4 — Rosali period coverage (any month/year, ever)')

const allRosaliTd = await q(
  `tracker_data?select=period_year,period_month,revenue,source,created_via,created_at&business_id=eq.${ROSALI}&order=period_year.asc,period_month.asc&limit=200`
)
console.log(`tracker_data rows for Rosali (all-time): ${allRosaliTd.length}\n`)
for (const r of allRosiliTdSafe(allRosaliTd)) {
  console.log(`  ${r.period_year}-${String(r.period_month).padStart(2,'0')}  rev=${Number(r.revenue).toLocaleString('en-GB')}  source=${r.source}  via=${r.created_via ?? '(null)'}  created=${r.created_at}`)
}
function allRosiliTdSafe(arr) { return arr }  // intentional helper for top-N or grouping if needed later

const allRosaliRev = await q(
  `revenue_logs?select=revenue_date&business_id=eq.${ROSALI}&order=revenue_date.asc&limit=1`
)
const allRosaliRevCnt = await q(`revenue_logs?select=count&business_id=eq.${ROSALI}`).catch(() => null)
console.log(`\n  Rosali revenue_logs: earliest=${allRosaliRev[0]?.revenue_date ?? '(none)'}, count head=${JSON.stringify(allRosaliRevCnt)}`)

const allRosaliStaff = await q(
  `staff_logs?select=shift_date&business_id=eq.${ROSALI}&order=shift_date.asc&limit=1`
)
console.log(`  Rosali staff_logs:   earliest=${allRosaliStaff[0]?.shift_date ?? '(none)'}`)

// ───────────────────────────────────────────────────────────────────────────
// Q5 — does the cross-attribution reach RAW source data?
// ───────────────────────────────────────────────────────────────────────────
section('Q5 — raw-source cross-attribution: supplier_invoice_lines + vouchers')

// supplier_invoice_lines — count + sum per business for Jan 2026
const silR = await q(
  `supplier_invoice_lines?select=fortnox_invoice_number,total_excl_vat&business_id=eq.${ROSALI}&invoice_period_year=eq.2026&invoice_period_month=eq.1&limit=5000`
)
const silV = await q(
  `supplier_invoice_lines?select=fortnox_invoice_number,total_excl_vat&business_id=eq.${VERO}&invoice_period_year=eq.2026&invoice_period_month=eq.1&limit=5000`
)
const sumSil = a => a.reduce((s, r) => s + Number(r.total_excl_vat ?? 0), 0)
console.log(`supplier_invoice_lines, Jan 2026:`)
console.log(`  Rosali: ${silR.length} lines, sum_excl_vat=${Math.round(sumSil(silR))}`)
console.log(`  Vero:   ${silV.length} lines, sum_excl_vat=${Math.round(sumSil(silV))}`)
// Compare invoice-number sets — do they overlap?
const setR = new Set(silR.map(r => r.fortnox_invoice_number))
const setV = new Set(silV.map(r => r.fortnox_invoice_number))
const overlap = [...setR].filter(n => setV.has(n))
console.log(`  Distinct invoice numbers: Rosali=${setR.size}  Vero=${setV.size}  OVERLAP=${overlap.length}`)
if (overlap.length > 0) console.log(`  ⚠️ Same invoice numbers appear under BOTH businesses — raw-source cross-attribution.`)

// fortnox_vouchers_cache — count per business for Jan 2026
const vR = await q(
  `fortnox_vouchers_cache?select=voucher_series,voucher_number,debit_total,credit_total&business_id=eq.${ROSALI}&period_year=eq.2026&period_month=eq.1&limit=5000`
)
const vV = await q(
  `fortnox_vouchers_cache?select=voucher_series,voucher_number,debit_total,credit_total&business_id=eq.${VERO}&period_year=eq.2026&period_month=eq.1&limit=5000`
)
console.log(`\nfortnox_vouchers_cache, Jan 2026:`)
console.log(`  Rosali: ${vR.length} vouchers, sum_debit=${Math.round(vR.reduce((s,r)=>s+Number(r.debit_total||0),0))}`)
console.log(`  Vero:   ${vV.length} vouchers, sum_debit=${Math.round(vV.reduce((s,r)=>s+Number(r.debit_total||0),0))}`)
const keyR = new Set(vR.map(r => `${r.voucher_series}/${r.voucher_number}`))
const keyV = new Set(vV.map(r => `${r.voucher_series}/${r.voucher_number}`))
const vOverlap = [...keyR].filter(k => keyV.has(k))
console.log(`  Distinct voucher keys: Rosali=${keyR.size}  Vero=${keyV.size}  OVERLAP=${vOverlap.length}`)
if (vOverlap.length > 0) console.log(`  ⚠️ Same voucher (series/number) appears under BOTH businesses — raw-source cross-attribution at the voucher cache level.`)

// ───────────────────────────────────────────────────────────────────────────
// Q6 — tracker_line_items for Rosali vs Vero Jan 2026
// ───────────────────────────────────────────────────────────────────────────
section('Q6 — tracker_line_items Jan 2026: Rosali vs Vero')

const tliR = await q(
  `tracker_line_items?select=fortnox_account,label_sv,subcategory,amount,source_upload_id,created_at&business_id=eq.${ROSALI}&period_year=eq.2026&period_month=eq.1&order=fortnox_account.asc&limit=200`
)
const tliV = await q(
  `tracker_line_items?select=fortnox_account,label_sv,subcategory,amount,source_upload_id,created_at&business_id=eq.${VERO}&period_year=eq.2026&period_month=eq.1&order=fortnox_account.asc&limit=200`
)
console.log(`tracker_line_items rows:  Rosali=${tliR.length}  Vero=${tliV.length}`)

// Build comparable (account, label, amount) tuples
const fmt = r => `${r.fortnox_account}|${r.label_sv}|${Math.round(Number(r.amount))}`
const tupR = tliR.map(fmt).sort()
const tupV = tliV.map(fmt).sort()
const setTupR = new Set(tupR), setTupV = new Set(tupV)
const tupOverlap = tupR.filter(t => setTupV.has(t))
console.log(`  Identical (account,label,amount) tuples shared by both: ${tupOverlap.length} / ${tupR.length} (Rosali) / ${tupV.length} (Vero)`)
console.log(`  source_upload_id matching:`)
const supR = new Set(tliR.map(r => r.source_upload_id).filter(Boolean))
const supV = new Set(tliV.map(r => r.source_upload_id).filter(Boolean))
const supOverlap = [...supR].filter(s => supV.has(s))
console.log(`    Rosali distinct source_upload_id: ${supR.size}  Vero: ${supV.size}  overlap: ${supOverlap.length}`)
if (supOverlap.length > 0) console.log(`    ⚠️ Same fortnox_upload referenced by line items in BOTH businesses.`)

// ───────────────────────────────────────────────────────────────────────────
// Q7 — fortnox_uploads referenced by Rosali Jan row
// ───────────────────────────────────────────────────────────────────────────
section('Q7 — fortnox_uploads referenced by Rosali tracker_data + line items')

const rosaliTd = td.find(x => x.business_id === ROSALI)
const rosaliUploadIds = new Set()
if (rosaliTd?.fortnox_upload_id) rosaliUploadIds.add(rosaliTd.fortnox_upload_id)
for (const l of tliR) if (l.source_upload_id) rosaliUploadIds.add(l.source_upload_id)
console.log(`Distinct upload_ids referenced by Rosali Jan 2026 row: ${rosaliUploadIds.size}`)
if (rosaliUploadIds.size > 0) {
  const ids = [...rosaliUploadIds].join(',')
  const uploads = await q(`fortnox_uploads?select=id,org_id,business_id,doc_type,period_year,period_month,status,filename,uploaded_by,created_at&id=in.(${ids})`)
  for (const u of uploads) {
    const owner = u.business_id === VERO ? 'Vero' : u.business_id === ROSALI ? 'Rosali' : '(other biz)'
    console.log(`  upload ${u.id}`)
    console.log(`    actual business_id=${u.business_id} (${owner})  status=${u.status}  ${u.period_year}-${String(u.period_month).padStart(2,'0')}  filename=${u.filename ?? '(n/a)'}`)
    console.log(`    created=${u.created_at}`)
    if (u.business_id === VERO) console.log(`    ⚠️ Upload is owned by Vero but is referenced by Rosali rows — cross-attribution at the upload layer.`)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Q8 — any 2026 manual entries on Rosali (vector for the bogus row)?
// ───────────────────────────────────────────────────────────────────────────
section('Q8 — Rosali tracker_data rows 2026 with source=manual / no upload')

const manualRosali = await q(
  `tracker_data?select=period_year,period_month,revenue,source,created_via,created_at,fortnox_upload_id&business_id=eq.${ROSALI}&period_year=eq.2026&or=(source.eq.manual,fortnox_upload_id.is.null)&order=period_month.asc`
)
console.log(`Rosali 2026 rows with source=manual OR null upload: ${manualRosali.length}`)
for (const r of manualRosali) {
  console.log(`  ${r.period_year}-${String(r.period_month).padStart(2,'0')}  source=${r.source}  via=${r.created_via ?? '(null)'}  upload=${r.fortnox_upload_id ?? '(null)'}  rev=${r.revenue}  created=${r.created_at}`)
}

console.log('\n' + '═'.repeat(74))
console.log('Done. Read-only — no rows changed.')
console.log('═'.repeat(74))
