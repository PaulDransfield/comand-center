#!/usr/bin/env node
// scripts/diag-elevated-queue-rematch-dryrun.mjs
//
// Dry-run rematch over the elevated needs_review queue.
//
// Per elevated-queue-rematch-dryrun-prompt.md: Phase 2.0's voucher
// back-fill correctly surfaced ~1,572 previously-hidden lines into
// needs_review. The question is: how much is real owner work vs how
// much would just auto-resolve on a rematch?
//
// Read-only. Simulates the matcher ladder (Steps 1-4 + Gate 0) by
// executing the same SELECTs / RPC the real matcher does — but never
// inserts an alias or updates match_status. Buckets each outcome:
//
//   bucket A  — would auto-resolve (Step 1 article, Step 2 desc,
//               Step 3 same-supplier >0.80, Step 4 cross >0.85)
//   bucket B  — collapses onto an existing product but below auto-
//               threshold (trigram top in 0.30–0.80 same-supplier or
//               0.30–0.85 cross). One-tap confirm, not new setup.
//   bucket C  — no plausible existing match (top similarity <0.30 or
//               no trigram candidates). The "genuinely new" residual.
//
// Then deduplicates bucket C by (supplier_fortnox_number,
// normalised_description) to surface the count of DISTINCT new
// products — the actual size of the task.

import { readFileSync } from 'node:fs'

// Mirror the normalisation in lib/inventory/normalise.ts. CRITICAL —
// must stay byte-identical so trigram lookups match the matcher's view.
const UNIT_SUFFIX_RE = /(\d+)\s+(st|kg|hg|g|l|cl|ml|dl|pack|frp|fp|paket|liter|kilo|gram)\b/gi
function normaliseDescription(raw) {
  if (!raw) return ''
  return raw
    .toLowerCase()
    .replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o')
    .replace(/[éè]/g, 'e')
    .replace(/[^\w\s]/g, ' ')
    .replace(UNIT_SUFFIX_RE, (_, n, u) => `${n}${u.toLowerCase()}`)
    .replace(/\s+/g, ' ')
    .trim()
}

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

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const BUSINESSES = [
  { id: CHICCE, name: 'Chicce' },
  { id: VERO,   name: 'Vero' },
]

const SAME_SUPPLIER_THRESHOLD  = 0.80
const CROSS_SUPPLIER_THRESHOLD = 0.85
const PLAUSIBLE_MATCH_FLOOR    = 0.30  // anything below = "genuinely new"

async function q(path, opts = {}) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H, ...opts })
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json()
}
async function qPaged(path, pageSize = 1000) {
  const out = []
  let from = 0
  while (true) {
    const sep = path.includes('?') ? '&' : '?'
    const url = `${URL}/rest/v1/${path}${sep}limit=${pageSize}&offset=${from}`
    const r = await fetch(url, { headers: H })
    if (!r.ok) throw new Error(`${path} → HTTP ${r.status}: ${await r.text().catch(() => '')}`)
    const rows = await r.json()
    out.push(...rows)
    if (rows.length < pageSize) break
    from += pageSize
  }
  return out
}
async function rpc(name, args) {
  const r = await fetch(`${URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (!r.ok) throw new Error(`rpc ${name} → HTTP ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json()
}

// ──────────────────────────────────────────────────────────────────────
// Step 1: exact (supplier, article_number) — only if line.article_number
// ──────────────────────────────────────────────────────────────────────
async function step1(line) {
  if (!line.article_number) return null
  const enc = encodeURIComponent(line.article_number)
  const rows = await q(
    `product_aliases?select=id,product_id,raw_description` +
    `&business_id=eq.${line.business_id}` +
    `&supplier_fortnox_number=eq.${encodeURIComponent(line.supplier_fortnox_number)}` +
    `&article_number=eq.${enc}` +
    `&is_active=eq.true` +
    `&limit=1`
  )
  return rows[0] ?? null
}

// ──────────────────────────────────────────────────────────────────────
// Step 2: exact (supplier, normalised_desc, unit)
// ──────────────────────────────────────────────────────────────────────
async function step2(line, normalised) {
  const unit = (line.unit ?? '')
  const url =
    `product_aliases?select=id,product_id,raw_description` +
    `&business_id=eq.${line.business_id}` +
    `&supplier_fortnox_number=eq.${encodeURIComponent(line.supplier_fortnox_number)}` +
    `&normalised_description=eq.${encodeURIComponent(normalised)}` +
    `&unit=eq.${encodeURIComponent(unit)}` +
    `&article_number=is.null` +
    `&is_active=eq.true` +
    `&limit=1`
  const rows = await q(url)
  return rows[0] ?? null
}

// ──────────────────────────────────────────────────────────────────────
// Steps 3 + 4: trigram search via the production RPC
// ──────────────────────────────────────────────────────────────────────
async function trigramCandidates(business_id, normalised) {
  if (!normalised) return []
  const rows = await rpc('inventory_trigram_search', {
    p_business_id: business_id,
    p_query:       normalised,
    p_limit:       12,
  })
  return (rows ?? []).map(r => ({
    alias_id:                r.alias_id,
    product_id:              r.product_id,
    product_name:            r.product_name,
    raw_description:         r.raw_description,
    supplier_fortnox_number: r.supplier_fortnox_number,
    similarity:              Number(r.similarity),
  }))
}

// ──────────────────────────────────────────────────────────────────────
// Per-line dry-run resolution. Returns the bucket + supporting info.
// Never writes.
// ──────────────────────────────────────────────────────────────────────
async function resolveDryRun(line) {
  const normalised = normaliseDescription(line.raw_description)
  if (!normalised) {
    return { bucket: 'C', reason: 'empty_normalised_description', normalised, top: null }
  }

  // Step 1
  if (line.article_number) {
    const hit = await step1(line)
    if (hit) return { bucket: 'A', reason: 'step1_article_exact', method: 'article_number', alias_id: hit.id, product_id: hit.product_id, normalised, top: null }
  }

  // Step 2
  const desc = await step2(line, normalised)
  if (desc) return { bucket: 'A', reason: 'step2_description_exact', method: 'description_exact', alias_id: desc.id, product_id: desc.product_id, normalised, top: null }

  // Steps 3 + 4
  const candidates = await trigramCandidates(line.business_id, normalised)

  const sameSupplierTop = candidates
    .filter(c => c.supplier_fortnox_number === line.supplier_fortnox_number)
    .sort((a, b) => b.similarity - a.similarity)[0] ?? null
  if (sameSupplierTop && sameSupplierTop.similarity > SAME_SUPPLIER_THRESHOLD) {
    return { bucket: 'A', reason: 'step3_fuzzy_same_supplier', method: 'fuzzy_same_supplier', similarity: sameSupplierTop.similarity, alias_id: sameSupplierTop.alias_id, product_id: sameSupplierTop.product_id, normalised, top: sameSupplierTop }
  }

  const crossTop = candidates
    .filter(c => c.supplier_fortnox_number !== line.supplier_fortnox_number)
    .sort((a, b) => b.similarity - a.similarity)[0] ?? null
  if (crossTop && crossTop.similarity > CROSS_SUPPLIER_THRESHOLD) {
    return { bucket: 'A', reason: 'step4_fuzzy_cross_supplier', method: 'fuzzy_cross_supplier', similarity: crossTop.similarity, alias_id: crossTop.alias_id, product_id: crossTop.product_id, normalised, top: crossTop }
  }

  // Below auto-threshold. Is there a plausible match?
  const topOverall = [sameSupplierTop, crossTop].filter(Boolean).sort((a, b) => (b?.similarity ?? 0) - (a?.similarity ?? 0))[0] ?? null

  if (topOverall && topOverall.similarity >= PLAUSIBLE_MATCH_FLOOR) {
    return { bucket: 'B', reason: 'below_auto_threshold', similarity: topOverall.similarity, top: topOverall, normalised }
  }

  return { bucket: 'C', reason: 'no_plausible_match', normalised, top: topOverall }
}

// ──────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────

async function pullNeedsReview(business_id) {
  return await qPaged(
    `supplier_invoice_lines?` +
    `select=id,business_id,org_id,supplier_fortnox_number,supplier_name_snapshot,article_number,raw_description,unit,account_number,account_source,total_excl_vat` +
    `&business_id=eq.${business_id}` +
    `&match_status=eq.needs_review`
  )
}

async function processBusiness(label, business_id) {
  console.log(`\n${'═'.repeat(78)}\n  ${label} — pull lines\n${'═'.repeat(78)}`)
  const lines = await pullNeedsReview(business_id)
  console.log(`  Total needs_review lines: ${lines.length}`)

  const P1 = lines.filter(l => l.account_source === 'voucher_backfill')
  const P0 = lines.filter(l => l.account_source !== 'voucher_backfill')
  console.log(`  P0 (pre-existing needs_review, account_source != 'voucher_backfill'): ${P0.length}`)
  console.log(`  P1 (elevated by P2.0 back-fill, account_source = 'voucher_backfill'): ${P1.length}`)

  // Dry-run ladder per line (P1 + P0). Show progress every 100.
  console.log(`\n  Running ladder dry-run on ${lines.length} lines…`)
  const results = []
  let done = 0
  for (const line of lines) {
    const r = await resolveDryRun(line)
    results.push({ line, ...r, group: P1.includes(line) ? 'P1' : 'P0' })
    done += 1
    if (done % 200 === 0) console.log(`    ${done}/${lines.length} processed`)
  }
  console.log(`    ${done}/${lines.length} processed`)

  return { label, business_id, P0, P1, results }
}

const all = []
for (const biz of BUSINESSES) {
  const r = await processBusiness(biz.name, biz.id)
  all.push(r)
}

// ──────────────────────────────────────────────────────────────────────
// Per-business reporting
// ──────────────────────────────────────────────────────────────────────

function bucketCounts(results) {
  return {
    A: results.filter(r => r.bucket === 'A').length,
    B: results.filter(r => r.bucket === 'B').length,
    C: results.filter(r => r.bucket === 'C').length,
  }
}

function distinctNewProducts(results) {
  // Bucket C only. Dedupe by (supplier_fortnox_number, normalised).
  const C = results.filter(r => r.bucket === 'C')
  const groups = new Map()
  for (const r of C) {
    const key = `${r.line.supplier_fortnox_number}||${r.normalised || '(empty)'}`
    const g = groups.get(key) ?? { key, supplier_fortnox_number: r.line.supplier_fortnox_number, supplier_name_snapshot: r.line.supplier_name_snapshot, normalised: r.normalised, sample_desc: r.line.raw_description, lines: 0, sek_total: 0 }
    g.lines += 1
    g.sek_total += Number(r.line.total_excl_vat ?? 0)
    groups.set(key, g)
  }
  return [...groups.values()]
}

for (const biz of all) {
  console.log(`\n${'═'.repeat(78)}\n  ${biz.label} — dry-run buckets\n${'═'.repeat(78)}`)

  for (const grp of ['P1', 'P0']) {
    const rs = biz.results.filter(r => r.group === grp)
    if (rs.length === 0) continue
    const bc = bucketCounts(rs)
    const distinct = distinctNewProducts(rs)
    const totalSek = rs.filter(r => r.bucket === 'C').reduce((a, r) => a + Number(r.line.total_excl_vat ?? 0), 0)
    console.log(`\n  Group ${grp} (${rs.length} lines):`)
    console.log(`    A — would auto-resolve on rematch:               ${bc.A.toString().padStart(5)} (${(100*bc.A/rs.length).toFixed(1)}%)`)
    console.log(`    B — collapses onto existing product (below auto): ${bc.B.toString().padStart(5)} (${(100*bc.B/rs.length).toFixed(1)}%)`)
    console.log(`    C — genuinely new (no plausible match):           ${bc.C.toString().padStart(5)} (${(100*bc.C/rs.length).toFixed(1)}%)`)
    console.log(`        → distinct new products (deduped by supplier+normalised): ${distinct.length}`)
    console.log(`        → line-to-distinct ratio: ${bc.C > 0 && distinct.length > 0 ? (bc.C/distinct.length).toFixed(1) : 'n/a'}`)
    console.log(`        → total SEK in bucket C: ${totalSek.toFixed(2)}`)
  }

  // Top distinct new products (P1+P0 combined) by line count
  const all_C_distinct = distinctNewProducts(biz.results)
  const byLines = [...all_C_distinct].sort((a, b) => b.lines - a.lines).slice(0, 30)
  const bySek   = [...all_C_distinct].sort((a, b) => b.sek_total - a.sek_total).slice(0, 30)

  console.log(`\n  Top 30 distinct-new products by LINE COUNT (P0+P1 combined):`)
  for (const g of byLines) {
    console.log(`    ${String(g.lines).padStart(4)}× ${g.sek_total.toFixed(0).padStart(8)} SEK  [${(g.supplier_name_snapshot ?? '?').slice(0,30).padEnd(30)}] "${g.sample_desc}"`)
  }
  console.log(`\n  Top 30 distinct-new products by SEK VALUE (P0+P1 combined):`)
  for (const g of bySek) {
    console.log(`    ${g.sek_total.toFixed(0).padStart(8)} SEK  ${String(g.lines).padStart(4)}× [${(g.supplier_name_snapshot ?? '?').slice(0,30).padEnd(30)}] "${g.sample_desc}"`)
  }
}

// ──────────────────────────────────────────────────────────────────────
// Cross-business overlap on bucket C
// ──────────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(78)}\n  Cross-business overlap on distinct-new products (bucket C)\n${'═'.repeat(78)}`)
const veroDistinct   = distinctNewProducts(all.find(b => b.business_id === VERO).results)
const chicceDistinct = distinctNewProducts(all.find(b => b.business_id === CHICCE).results)

// Match by normalised description only (suppliers can differ across businesses
// while still being "the same product" by name).
const veroNormSet   = new Set(veroDistinct.map(g => g.normalised).filter(Boolean))
const chicceNormSet = new Set(chicceDistinct.map(g => g.normalised).filter(Boolean))
const overlap = [...veroNormSet].filter(n => chicceNormSet.has(n))

console.log(`  Vero distinct-new (bucket C):    ${veroDistinct.length}`)
console.log(`  Chicce distinct-new (bucket C):  ${chicceDistinct.length}`)
console.log(`  Overlap (same normalised desc):  ${overlap.length}`)
console.log(`  → ${(100*overlap.length/Math.max(1, Math.min(veroDistinct.length, chicceDistinct.length))).toFixed(1)}% of the smaller business's distinct-new set already appears at the other`)

if (overlap.length > 0) {
  console.log(`\n  Sample overlap items (first 20):`)
  for (const n of overlap.slice(0, 20)) {
    const vGroup = veroDistinct.find(g => g.normalised === n)
    const cGroup = chicceDistinct.find(g => g.normalised === n)
    console.log(`    "${n}"  Vero ${vGroup.lines}×/${vGroup.sek_total.toFixed(0)} SEK  Chicce ${cGroup.lines}×/${cGroup.sek_total.toFixed(0)} SEK`)
  }
}

// ──────────────────────────────────────────────────────────────────────
// Headline summary
// ──────────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(78)}\n  HEADLINE SUMMARY — read this first\n${'═'.repeat(78)}`)
for (const biz of all) {
  const P1results = biz.results.filter(r => r.group === 'P1')
  const bc = bucketCounts(P1results)
  const distinct = distinctNewProducts(P1results)
  if (P1results.length === 0) {
    console.log(`\n  ${biz.label}: 0 P1 (elevated) lines`)
    continue
  }
  const autoResolvePct = (100 * bc.A / P1results.length).toFixed(1)
  console.log(`\n  ${biz.label}:`)
  console.log(`    P1 elevated lines:                      ${P1results.length}`)
  console.log(`    → auto-resolve on rematch (bucket A):   ${bc.A} (${autoResolvePct}%)  ← zero owner input`)
  console.log(`    → one-tap-confirm (bucket B):           ${bc.B}`)
  console.log(`    → genuinely-new lines (bucket C):       ${bc.C}`)
  console.log(`    → DISTINCT NEW PRODUCTS to confirm:     ${distinct.length}`)
}

console.log(`\nDone. Read-only — no writes occurred.`)
