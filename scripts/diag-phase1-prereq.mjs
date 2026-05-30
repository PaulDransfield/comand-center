#!/usr/bin/env node
// scripts/diag-phase1-prereq.mjs
//
// Phase 1 pre-flight: close the four prod-truth unknowns from
// `specs-reality-reconciliation.md` §6 AND inventory the existing
// learning-loop state (Step 0 of `phase-1-harden-learning-loop-prompt.md`).
//
// READ-ONLY. SELECT + Fortnox GET only.
// Service-role bypasses RLS; outputs aggregates / column lists / counts.
// Never prints `credentials_enc` or any token value.

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
const FORTNOX_CLIENT_ID     = env.FORTNOX_CLIENT_ID
const FORTNOX_CLIENT_SECRET = env.FORTNOX_CLIENT_SECRET
if (!URL || !KEY) { console.error('Missing env'); process.exit(1) }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H })
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json()
}
async function qSafe(path) {
  try { return { ok: true, data: await q(path) } }
  catch (e) { return { ok: false, error: e.message } }
}
async function columnsOf(table) {
  // PostgREST: introspect via OPTIONS or via a single-row SELECT.
  const r = await fetch(`${URL}/rest/v1/${table}?select=*&limit=1`, { headers: H })
  if (!r.ok) return { ok: false, status: r.status, error: await r.text().catch(() => '') }
  const rows = await r.json()
  if (rows.length === 0) {
    // Empty — try a fake INSERT to get column hints from error, or settle for
    // "exists but empty". Most informative path is querying information_schema
    // via an RPC, but we don't have one for that. Mark unknown.
    return { ok: true, exists: true, columns: '(table exists but empty — cannot infer columns from data)' }
  }
  return { ok: true, exists: true, columns: Object.keys(rows[0]) }
}

const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

const section = (n, title) => console.log(`\n${'═'.repeat(76)}\n  ${n}. ${title}\n${'═'.repeat(76)}`)

// ───────────────────────────────────────────────────────────────────────
// PART A — Close the 4 prod-truth unknowns
// ───────────────────────────────────────────────────────────────────────

section('A1', 'Are M097 / M098 / M100 / M104 tables applied?')
const tablesToCheck = [
  // M097
  'pos_menu_items', 'pos_sales',
  // M098
  'fortnox_supplier_invoices', 'fortnox_sync_state',
  // M100
  'scheduling_shifts', 'scheduling_versions', 'scheduling_metadata',
  // M104
  'review_insights_cache',
]
for (const t of tablesToCheck) {
  const c = await columnsOf(t)
  if (c.ok) {
    const count = await qSafe(`${t}?select=count`)
    const n = count.ok ? count.data?.[0]?.count : '?'
    console.log(`  ✓ ${t.padEnd(32)} exists  rows=${n}`)
  } else {
    console.log(`  ✗ ${t.padEnd(32)} MISSING (HTTP ${c.status})`)
  }
}

section('A2', 'Is document_chunks.embedding populated, and by which provider?')
const dcCols = await columnsOf('document_chunks')
if (dcCols.ok && Array.isArray(dcCols.columns)) {
  console.log(`  columns: ${dcCols.columns.join(', ')}`)
  if (dcCols.columns.includes('embedding')) {
    const cntAll = await qSafe('document_chunks?select=count')
    const cntWithEmb = await qSafe('document_chunks?select=count&embedding=not.is.null')
    console.log(`  total rows:               ${cntAll.data?.[0]?.count ?? '?'}`)
    console.log(`  rows with embedding:      ${cntWithEmb.data?.[0]?.count ?? '?'}`)
    if (dcCols.columns.includes('embedding_provider') || dcCols.columns.includes('embedding_model')) {
      const providerCol = dcCols.columns.includes('embedding_provider') ? 'embedding_provider' : 'embedding_model'
      const providers = await qSafe(`document_chunks?select=${providerCol}&${providerCol}=not.is.null&limit=10`)
      console.log(`  distinct ${providerCol}:`, [...new Set((providers.data ?? []).map(r => r[providerCol]))])
    } else {
      console.log('  (no embedding_provider / embedding_model column — provider unknown from schema)')
    }
  } else {
    console.log('  no `embedding` column on document_chunks')
  }
} else {
  console.log(`  document_chunks not queryable: ${dcCols.error}`)
}

section('A3', 'Are Fortnox supplier + article scopes actually pullable with current grants?')
if (!FORTNOX_CLIENT_ID || !FORTNOX_CLIENT_SECRET) {
  console.log('  FORTNOX_CLIENT_ID / FORTNOX_CLIENT_SECRET not in env — skipping live probe')
} else {
  // Refresh Vero's Fortnox token then GET /3/suppliers + /3/articles
  const integ = await qSafe(`integrations?select=id,credentials_enc&business_id=eq.${VERO}&provider=eq.fortnox&limit=1`)
  if (!integ.ok || !integ.data?.[0]) {
    console.log('  Vero Fortnox integration not loadable')
  } else {
    const { createDecipheriv } = await import('node:crypto')
    // We can't decrypt here without recreating the encryption util. Instead,
    // use the Fortnox refresh endpoint with the still-valid access token by
    // calling our own auth flow. Simplest: GET via getFreshFortnoxAccessToken
    // requires importing TS code — too heavy. Skip the live probe.
    //
    // Alternative: rely on the integration's last_sync_at + scope field.
    const sc = await qSafe(`integrations?select=id,status,token_expires_at,last_sync_at,credentials_enc&business_id=eq.${VERO}&provider=eq.fortnox&limit=1`)
    console.log('  Vero Fortnox integration metadata:')
    console.log('    status:', sc.data?.[0]?.status)
    console.log('    token_expires_at:', sc.data?.[0]?.token_expires_at)
    console.log('    last_sync_at:', sc.data?.[0]?.last_sync_at)
    // Look in lib/integrations/encryption.ts to decrypt — too brittle from
    // a script. Instead read the scope from the OAuth scope list as configured:
    console.log('  Granted scopes (from app/api/integrations/fortnox/route.ts FORTNOX_SCOPES):')
    console.log('    bookkeeping, invoice, supplierinvoice, salary, companyinformation,')
    console.log('    costcenter, customer, supplier, timereporting, article, archive, inbox, connectfile')
    console.log('  → supplier + article ARE in the granted-scope list at OAuth time.')
    console.log('  → Whether they actually return data needs a live API call; deferred to')
    console.log('    a tiny TS script that uses getFreshFortnoxAccessToken().')
  }
}

section('A4', 'tracker_line_items schema')
const tliCols = await columnsOf('tracker_line_items')
if (tliCols.ok) {
  console.log(`  columns: ${Array.isArray(tliCols.columns) ? tliCols.columns.join(', ') : tliCols.columns}`)
  const cnt = await qSafe('tracker_line_items?select=count')
  console.log(`  total rows:    ${cnt.data?.[0]?.count ?? '?'}`)
  const distinctCat = await qSafe('tracker_line_items?select=category&limit=2000')
  console.log(`  distinct category values:`, [...new Set((distinctCat.data ?? []).map(r => r.category))])
  const distinctSub = await qSafe('tracker_line_items?select=subcategory&limit=2000')
  console.log(`  distinct subcategory values:`, [...new Set((distinctSub.data ?? []).map(r => r.subcategory))])
} else {
  console.log(`  tracker_line_items not queryable: ${tliCols.error}`)
}

// ───────────────────────────────────────────────────────────────────────
// PART B — Step 0: learning-loop state
// ───────────────────────────────────────────────────────────────────────

section('B1', 'product_aliases — columns + distinct match_method values')
const paCols = await columnsOf('product_aliases')
console.log(`  columns: ${Array.isArray(paCols.columns) ? paCols.columns.join(', ') : paCols.columns}`)
const paAll = await qSafe('product_aliases?select=count')
console.log(`  total rows: ${paAll.data?.[0]?.count ?? '?'}`)
const paMethods = await qSafe('product_aliases?select=match_method&limit=5000')
if (paMethods.ok) {
  const dist = {}
  for (const r of paMethods.data) dist[r.match_method] = (dist[r.match_method] ?? 0) + 1
  console.log(`  match_method distribution:`)
  for (const [k, v] of Object.entries(dist).sort((a,b)=>b[1]-a[1])) console.log(`    ${k.padEnd(24)} ${v}`)
}

section('B2', 'product_aliases — confidence distribution for auto-matches')
const paConf = await qSafe('product_aliases?select=match_method,match_confidence&match_method=in.(fuzzy_same_supplier,fuzzy_cross_supplier)&limit=5000')
if (paConf.ok) {
  const buckets = { same: { lt85: 0, lt90: 0, lt95: 0, ge95: 0 }, cross: { lt90: 0, lt95: 0, ge95: 0 } }
  for (const r of paConf.data) {
    const c = Number(r.match_confidence ?? 0)
    if (r.match_method === 'fuzzy_same_supplier') {
      if (c < 0.85) buckets.same.lt85++
      else if (c < 0.90) buckets.same.lt90++
      else if (c < 0.95) buckets.same.lt95++
      else buckets.same.ge95++
    } else {
      if (c < 0.90) buckets.cross.lt90++
      else if (c < 0.95) buckets.cross.lt95++
      else buckets.cross.ge95++
    }
  }
  console.log(`  same-supplier confidence buckets:`)
  console.log(`    0.80-0.85: ${buckets.same.lt85}   0.85-0.90: ${buckets.same.lt90}   0.90-0.95: ${buckets.same.lt95}   >=0.95: ${buckets.same.ge95}`)
  console.log(`  cross-supplier confidence buckets:`)
  console.log(`    0.85-0.90: ${buckets.cross.lt90}   0.90-0.95: ${buckets.cross.lt95}   >=0.95: ${buckets.cross.ge95}`)
}

section('B3', 'supplier_invoice_lines — match_status distribution')
const silCols = await columnsOf('supplier_invoice_lines')
console.log(`  columns: ${Array.isArray(silCols.columns) ? silCols.columns.join(', ') : silCols.columns}`)
const silStat = await qSafe('supplier_invoice_lines?select=match_status&limit=10000')
if (silStat.ok) {
  const dist = {}
  for (const r of silStat.data) dist[r.match_status] = (dist[r.match_status] ?? 0) + 1
  console.log(`  match_status distribution (first 10000):`)
  for (const [k, v] of Object.entries(dist).sort((a,b)=>b[1]-a[1])) console.log(`    ${k?.padEnd?.(16) ?? k} ${v}`)
}

section('B4', 'inventory_review_outcomes — columns + agreement rate')
const iroCols = await columnsOf('inventory_review_outcomes')
console.log(`  columns: ${Array.isArray(iroCols.columns) ? iroCols.columns.join(', ') : iroCols.columns}`)
const iroAll = await qSafe('inventory_review_outcomes?select=owner_action,agreed&limit=5000')
if (iroAll.ok) {
  console.log(`  total outcomes: ${iroAll.data.length}`)
  const byAct = {}, agreedTrue = iroAll.data.filter(r => r.agreed === true).length
  for (const r of iroAll.data) byAct[r.owner_action] = (byAct[r.owner_action] ?? 0) + 1
  console.log(`  agreement rate: ${iroAll.data.length ? (100 * agreedTrue / iroAll.data.length).toFixed(1) : '?'}% (${agreedTrue} / ${iroAll.data.length})`)
  console.log(`  owner_action distribution:`)
  for (const [k, v] of Object.entries(byAct).sort((a,b)=>b[1]-a[1])) console.log(`    ${k?.padEnd?.(24) ?? k} ${v}`)
}

section('B5', 'inventory_review_suggestions — does it exist + action distribution')
const irsCols = await columnsOf('inventory_review_suggestions')
console.log(`  columns: ${Array.isArray(irsCols.columns) ? irsCols.columns.join(', ') : irsCols.columns}`)
const irsAll = await qSafe('inventory_review_suggestions?select=action,confidence&limit=5000')
if (irsAll.ok) {
  const dist = {}
  for (const r of irsAll.data) dist[r.action] = (dist[r.action] ?? 0) + 1
  console.log(`  total suggestions cached: ${irsAll.data.length}`)
  console.log(`  action distribution:`)
  for (const [k, v] of Object.entries(dist).sort((a,b)=>b[1]-a[1])) console.log(`    ${k?.padEnd?.(24) ?? k} ${v}`)
}

section('B6', 'Correction-pattern sanity: how often is the same group/alias touched twice?')
// Threshold = 2 corrections is locked in the phase-1 prompt. Check whether
// that's "sensitive enough" or "too sensitive" against real owner behavior.
// Proxy: count distinct (business_id, group_key) tuples in outcomes that
// appear 2+ times.
const iroForGroup = await qSafe('inventory_review_outcomes?select=business_id,group_key,agreed,created_at&order=created_at.asc&limit=10000')
if (iroForGroup.ok) {
  const byGroup = {}
  for (const r of iroForGroup.data) {
    const k = `${r.business_id}|${r.group_key}`
    ;(byGroup[k] ||= []).push(r)
  }
  const total = Object.keys(byGroup).length
  const twoPlus = Object.values(byGroup).filter(v => v.length >= 2).length
  const threePlus = Object.values(byGroup).filter(v => v.length >= 3).length
  console.log(`  distinct (business, group_key) tuples:  ${total}`)
  console.log(`    touched 2+ times:  ${twoPlus}  (${total ? (100*twoPlus/total).toFixed(1) : '?'}%)`)
  console.log(`    touched 3+ times:  ${threePlus}  (${total ? (100*threePlus/total).toFixed(1) : '?'}%)`)
  // Same-group flip-flop (owner contradicted themselves)?
  let flipflop = 0
  for (const evs of Object.values(byGroup)) {
    if (evs.length < 2) continue
    const distinctActions = new Set(evs.map(e => e.owner_action ?? '∅'))
    if (distinctActions.size >= 2) flipflop++
  }
  console.log(`    same group with ≥2 different owner_actions (flip-flop): ${flipflop}`)
  console.log(`  → Informs the demotion threshold of 2 in the phase-1 prompt: if flip-flop count is high, the threshold may be too sensitive.`)
}

section('B7', 'How many supplier_invoice_lines reference each product_alias_id?')
// High-volume aliases are the priority for the audit sample. Distribution.
const usage = await qSafe('supplier_invoice_lines?select=product_alias_id&match_status=eq.matched&product_alias_id=not.is.null&limit=10000')
if (usage.ok) {
  const cnt = {}
  for (const r of usage.data) cnt[r.product_alias_id] = (cnt[r.product_alias_id] ?? 0) + 1
  const buckets = { '1': 0, '2-5': 0, '6-20': 0, '21-100': 0, '100+': 0 }
  for (const n of Object.values(cnt)) {
    if (n === 1) buckets['1']++
    else if (n <= 5) buckets['2-5']++
    else if (n <= 20) buckets['6-20']++
    else if (n <= 100) buckets['21-100']++
    else buckets['100+']++
  }
  console.log(`  distinct aliases in use:   ${Object.keys(cnt).length}`)
  console.log(`  per-alias usage buckets:`)
  for (const [k, v] of Object.entries(buckets)) console.log(`    ${k.padEnd(10)} ${v} aliases`)
}

console.log('\nDone. Read-only — no rows changed.\n')
