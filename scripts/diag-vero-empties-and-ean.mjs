#!/usr/bin/env node
// scripts/diag-vero-empties-and-ean.mjs
//
// Two read-only investigations:
//   A. Vero empty-description characterise (per vero-empty-descriptions-prompt.md).
//      Split fortnox_row (genuinely blank at source) vs pdf_extraction
//      (extraction failure), classifiability via account+amount, supplier
//      clustering, value distribution, Phase D queue depth impact.
//   B. EAN availability check (Phase 3 open question 2). What fraction of
//      supplier_invoice_lines.article_number values match EAN-like numeric
//      patterns (8/12/13/14 digits)? Determines how much of the assortment
//      Open Food Facts could enrich.

import { readFileSync } from 'node:fs'

function parseEnv(p) {
  try {
    return Object.fromEntries(readFileSync(p, 'utf8').split('\n')
      .filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }))
  } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H })
  if (!r.ok) throw new Error(`${path}: ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json()
}
async function qPaged(path, ps = 1000) {
  const out = []
  let from = 0
  while (true) {
    const sep = path.includes('?') ? '&' : '?'
    const r = await fetch(`${URL}/rest/v1/${path}${sep}limit=${ps}&offset=${from}`, { headers: H })
    if (!r.ok) throw new Error(`${path}: ${r.status}`)
    const rows = await r.json()
    out.push(...rows)
    if (rows.length < ps) break
    from += ps
  }
  return out
}

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

function isEmpty(s) { return s == null || String(s).trim() === '' }
function isEAN(s) {
  if (s == null) return false
  const t = String(s).trim()
  // EAN-8 (8 digits), EAN-12/UPC-A (12 digits), EAN-13 (13 digits), GTIN-14 (14 digits)
  return /^\d{8}$|^\d{12,14}$/.test(t)
}

// ══════════════════════════════════════════════════════════════════════
// A. VERO EMPTY-DESCRIPTION CHARACTERISE
// ══════════════════════════════════════════════════════════════════════

console.log(`${'═'.repeat(78)}\n  A. VERO EMPTY-DESCRIPTION LINES\n${'═'.repeat(78)}`)

const allVero = await qPaged(
  `supplier_invoice_lines?select=id,supplier_fortnox_number,supplier_name_snapshot,fortnox_invoice_number,raw_description,article_number,quantity,total_excl_vat,account_number,account_source,match_status,product_alias_id,source,created_at&business_id=eq.${VERO}`
)
console.log(`  Total Vero supplier_invoice_lines: ${allVero.length}`)

const empties = allVero.filter(r => isEmpty(r.raw_description))
console.log(`  Empty/whitespace raw_description:  ${empties.length}  (${(100*empties.length/Math.max(1,allVero.length)).toFixed(1)}%)`)

// 1. Current state breakdown
console.log(`\n  ── 1. Current state of empties ──`)
const byStatus = {}, bySource = {}, byAccountSource = {}
for (const r of empties) {
  byStatus[r.match_status] = (byStatus[r.match_status] ?? 0) + 1
  bySource[r.source ?? '(null)'] = (bySource[r.source ?? '(null)'] ?? 0) + 1
  byAccountSource[r.account_source ?? '(null)'] = (byAccountSource[r.account_source ?? '(null)'] ?? 0) + 1
}
console.log(`    match_status:`)
for (const [k, v] of Object.entries(byStatus).sort((a,b)=>b[1]-a[1])) console.log(`      ${k.padEnd(20)} ${v}`)
console.log(`    source (M078 — fortnox_row vs pdf_extraction):`)
for (const [k, v] of Object.entries(bySource).sort((a,b)=>b[1]-a[1])) console.log(`      ${k.padEnd(20)} ${v}`)
console.log(`    account_source:`)
for (const [k, v] of Object.entries(byAccountSource).sort((a,b)=>b[1]-a[1])) console.log(`      ${k.padEnd(20)} ${v}`)

// 2. The HEADLINE split — source × needs_review intersection
console.log(`\n  ── 2. HEADLINE SPLIT — origin × Phase D queue impact ──`)
const needsReviewEmpties = empties.filter(r => r.match_status === 'needs_review')
const otherEmpties      = empties.filter(r => r.match_status !== 'needs_review')
console.log(`    Empties currently in needs_review (INFLATES PHASE D QUEUE): ${needsReviewEmpties.length}`)
console.log(`    Empties already terminal (matched / not_inventory / skipped): ${otherEmpties.length}`)

// Split needs_review empties by source
const nrFortnox = needsReviewEmpties.filter(r => r.source === 'fortnox_row')
const nrPdf     = needsReviewEmpties.filter(r => r.source === 'pdf_extraction')
const nrOwner   = needsReviewEmpties.filter(r => r.source === 'owner_correction')
console.log(`\n    Of the ${needsReviewEmpties.length} empties in needs_review:`)
console.log(`      source='fortnox_row' (GENUINELY BLANK at API): ${nrFortnox.length}`)
console.log(`      source='pdf_extraction' (EXTRACTION FAILURE candidate): ${nrPdf.length}`)
console.log(`      source='owner_correction':                      ${nrOwner.length}`)

// 3. Classifiability — account_number + amount present?
console.log(`\n  ── 3. Of needs_review empties — how many are still classifiable? ──`)
const withAccount = needsReviewEmpties.filter(r => r.account_number != null && Number(r.total_excl_vat ?? 0) !== 0)
const noSignal    = needsReviewEmpties.filter(r => r.account_number == null && Number(r.total_excl_vat ?? 0) === 0)
const partial     = needsReviewEmpties.filter(r => !withAccount.includes(r) && !noSignal.includes(r))
console.log(`    HAVE account_number + non-zero amount (still classifiable by account): ${withAccount.length}`)
console.log(`    HAVE one signal only (account OR amount, not both):                   ${partial.length}`)
console.log(`    NEITHER account_number NOR non-zero amount (true ghosts):             ${noSignal.length}`)

// 4. Supplier clustering on needs_review empties
console.log(`\n  ── 4. Supplier clustering of needs_review empties ──`)
const bySupplier = new Map()
for (const r of needsReviewEmpties) {
  const k = r.supplier_name_snapshot ?? '?'
  const g = bySupplier.get(k) ?? { name: k, count: 0, sek: 0, sample_invoice: r.fortnox_invoice_number }
  g.count += 1
  g.sek += Math.abs(Number(r.total_excl_vat ?? 0))
  bySupplier.set(k, g)
}
const supplierSorted = [...bySupplier.values()].sort((a,b)=>b.count-a.count)
console.log(`    Distinct suppliers with empty needs_review lines: ${supplierSorted.length}`)
console.log(`    Top 15 by count:`)
for (const g of supplierSorted.slice(0, 15)) {
  console.log(`      ${String(g.count).padStart(4)}× ${g.sek.toFixed(0).padStart(8)} SEK  ${g.name.slice(0,45).padEnd(45)} (sample invoice ${g.sample_invoice})`)
}

// 5. Value distribution
console.log(`\n  ── 5. Value distribution of needs_review empties ──`)
const amounts = needsReviewEmpties.map(r => Math.abs(Number(r.total_excl_vat ?? 0))).sort((a,b)=>a-b)
const sum = amounts.reduce((s,n)=>s+n,0)
const p50 = amounts[Math.floor(amounts.length*0.5)] ?? 0
const p90 = amounts[Math.floor(amounts.length*0.9)] ?? 0
const max = amounts[amounts.length-1] ?? 0
console.log(`    Total SEK across all empties: ${sum.toFixed(0)}`)
console.log(`    Median: ${p50.toFixed(2)} | 90th pct: ${p90.toFixed(2)} | Max: ${max.toFixed(2)}`)
console.log(`    Zero-amount lines: ${amounts.filter(a=>a===0).length}`)
console.log(`    < 10 SEK: ${amounts.filter(a=>a>0&&a<10).length}`)
console.log(`    >= 1000 SEK: ${amounts.filter(a=>a>=1000).length}`)

// 6. Phase D queue context
console.log(`\n  ── 6. PHASE D QUEUE CONTEXT ──`)
const veroNeedsReviewAll = allVero.filter(r => r.match_status === 'needs_review')
console.log(`    Vero total needs_review:           ${veroNeedsReviewAll.length}`)
console.log(`    Vero needs_review empties:         ${needsReviewEmpties.length}  (${(100*needsReviewEmpties.length/Math.max(1,veroNeedsReviewAll.length)).toFixed(1)}% of queue)`)
console.log(`    → Phase D should net these out when reading queue-drain signal.`)

// 7. Chicce comparison (don't deep-dive, just note)
const allChicce = await qPaged(
  `supplier_invoice_lines?select=raw_description,match_status,source&business_id=eq.${CHICCE}`
)
const chicceEmpties = allChicce.filter(r => isEmpty(r.raw_description))
const chicceEmptiesNR = chicceEmpties.filter(r => r.match_status === 'needs_review')
console.log(`\n  ── 7. CHICCE comparison (light touch only) ──`)
console.log(`    Total Chicce supplier_invoice_lines: ${allChicce.length}`)
console.log(`    Chicce empties (all statuses):       ${chicceEmpties.length}  (${(100*chicceEmpties.length/Math.max(1,allChicce.length)).toFixed(1)}%)`)
console.log(`    Chicce empties in needs_review:      ${chicceEmptiesNR.length}`)
const chicceSourceSplit = {}
for (const r of chicceEmpties) chicceSourceSplit[r.source ?? '(null)'] = (chicceSourceSplit[r.source ?? '(null)'] ?? 0) + 1
console.log(`    Chicce empties by source:`, chicceSourceSplit)

// ══════════════════════════════════════════════════════════════════════
// B. EAN AVAILABILITY CHECK (Phase 3 open question 2)
// ══════════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(78)}\n  B. EAN AVAILABILITY ON supplier_invoice_lines.article_number\n${'═'.repeat(78)}`)
console.log(`  Pattern: 8/12/13/14 digit numeric (EAN-8 / UPC-A / EAN-13 / GTIN-14)\n`)

for (const [name, lines] of [['Chicce', allChicce], ['Vero', allVero]]) {
  // For Chicce we only pulled raw_description/match_status/source — need to pull article_number too
  // For Vero we have it. Skip Chicce if missing.
  if (!('article_number' in (lines[0] ?? {}))) {
    // Need to re-pull article_number for Chicce
    if (name === 'Chicce') {
      const chicceFull = await qPaged(
        `supplier_invoice_lines?select=article_number,total_excl_vat,supplier_name_snapshot&business_id=eq.${CHICCE}`
      )
      lines.length = 0
      for (const r of chicceFull) lines.push(r)
    }
  }

  console.log(`  ── ${name} ──`)
  const total = lines.length
  const withArticle = lines.filter(r => r.article_number != null && String(r.article_number).trim() !== '')
  const withEAN = withArticle.filter(r => isEAN(r.article_number))
  const valueWithEAN = withEAN.reduce((s,r)=>s+Math.abs(Number(r.total_excl_vat ?? 0)), 0)
  const valueAll     = lines.reduce((s,r)=>s+Math.abs(Number(r.total_excl_vat ?? 0)), 0)
  console.log(`    Total lines:                   ${total}`)
  console.log(`    With non-empty article_number: ${withArticle.length}  (${(100*withArticle.length/Math.max(1,total)).toFixed(1)}%)`)
  console.log(`    With EAN-pattern article_no:   ${withEAN.length}  (${(100*withEAN.length/Math.max(1,total)).toFixed(1)}% of lines)`)
  console.log(`    SEK covered by EAN lines:      ${valueWithEAN.toFixed(0)}  (${(100*valueWithEAN/Math.max(1,valueAll)).toFixed(1)}% of total spend)`)
  // Sample distinct EAN values
  const distinctEANs = new Set(withEAN.map(r => String(r.article_number).trim()))
  console.log(`    Distinct EANs:                 ${distinctEANs.size}`)
  if (distinctEANs.size > 0) {
    const sample = [...distinctEANs].slice(0, 8)
    console.log(`    Sample EANs: ${sample.join(', ')}`)
  }
  // Top suppliers contributing EAN lines
  const eanBySupplier = new Map()
  for (const r of withEAN) {
    const k = r.supplier_name_snapshot ?? '?'
    eanBySupplier.set(k, (eanBySupplier.get(k) ?? 0) + 1)
  }
  const eanSupSorted = [...eanBySupplier.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 5)
  console.log(`    Top suppliers contributing EAN-bearing lines:`)
  for (const [s, n] of eanSupSorted) console.log(`      ${String(n).padStart(4)}× ${s}`)
}

console.log(`\nDone. Read-only — no writes.`)
