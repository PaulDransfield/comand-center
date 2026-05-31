#!/usr/bin/env node
// scripts/diag-ms-nopdf-cluster.mjs
//
// M&S no_pdf 64-cluster verification — Step 1 (READ-ONLY DB).
// Per ms-nopdf-cluster-verification-prompt.md.
//
// Goal: classify the cluster as (A) truly-no-PDF or (B) sync-window gap.
// A clean date-cutoff signature on missing-parent invoices is the
// signature of (B); random spread is more likely (A).
//
// No writes. No Fortnox calls in this script (DB only — Fortnox probes
// gated on Step 1 results).

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

const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

// ───────────────────────────────────────────────────────────────────
// Pull all M&S Vero invoice_pdf_extractions records
// ───────────────────────────────────────────────────────────────────

const allMSExt = await qPaged(
  `invoice_pdf_extractions?select=fortnox_invoice_number,status,attempts,invoice_date,supplier_name_snapshot,supplier_fortnox_number,created_at&business_id=eq.${VERO}&supplier_name_snapshot=ilike.*Martin*Servera*`
)
console.log(`Total M&S Vero extraction records: ${allMSExt.length}`)
const byStatus = {}
for (const e of allMSExt) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1
console.log(`By status:`)
for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(15)} ${v}`)
}

// ───────────────────────────────────────────────────────────────────
// Cross-reference with fortnox_supplier_invoices to find missing-parent
// ───────────────────────────────────────────────────────────────────

const fsi = await qPaged(
  `fortnox_supplier_invoices?select=given_number,invoice_number,invoice_date,supplier_name,supplier_number&business_id=eq.${VERO}&supplier_name=ilike.*Martin*Servera*`
)
console.log(`\nTotal M&S Vero rows in fortnox_supplier_invoices: ${fsi.length}`)
const fsiByGiven = new Map(fsi.map(f => [String(f.given_number), f]))

// Categorize each extraction record
const categorized = allMSExt.map(e => {
  const parent = fsiByGiven.get(String(e.fortnox_invoice_number))
  return {
    ...e,
    has_parent: !!parent,
    parent_invoice_number: parent?.invoice_number ?? null,
    parent_supplier_name: parent?.supplier_name ?? null,
  }
})

// The CRUX cluster: status=no_pdf AND no parent
const cluster = categorized.filter(c => c.status === 'no_pdf' && !c.has_parent)
console.log(`\n──────── THE CLUSTER ────────`)
console.log(`M&S Vero extractions with status='no_pdf' AND no parent in fortnox_supplier_invoices: ${cluster.length}`)

// All no_pdf split by parent presence
const allNoPdf = categorized.filter(c => c.status === 'no_pdf')
const noPdfWithParent = allNoPdf.filter(c => c.has_parent)
console.log(`\nAll no_pdf M&S Vero (${allNoPdf.length}) split by parent presence:`)
console.log(`  with parent in fortnox_supplier_invoices:    ${noPdfWithParent.length}`)
console.log(`  WITHOUT parent (the cluster):                 ${cluster.length}`)

// Compare extracted (has parent) vs cluster (no parent) — date signature
const extracted = categorized.filter(c => c.status === 'extracted')
console.log(`\n──────── DATE SIGNATURE ────────`)
console.log(`Successfully extracted M&S (have parent + processed): ${extracted.length}`)
if (extracted.length > 0) {
  const dates = extracted.map(e => e.invoice_date).filter(Boolean).sort()
  console.log(`  invoice_date range: ${dates[0]} … ${dates[dates.length - 1]}`)
  const givens = extracted.map(e => parseInt(e.fortnox_invoice_number)).filter(n => !isNaN(n)).sort((a, b) => a - b)
  console.log(`  given_number range: ${givens[0]} … ${givens[givens.length - 1]}`)
}
console.log(`\nThe cluster (no_pdf + missing parent): ${cluster.length}`)
if (cluster.length > 0) {
  const dates = cluster.map(e => e.invoice_date).filter(Boolean).sort()
  console.log(`  invoice_date range: ${dates[0]} … ${dates[dates.length - 1]}`)
  const givens = cluster.map(e => parseInt(e.fortnox_invoice_number)).filter(n => !isNaN(n)).sort((a, b) => a - b)
  console.log(`  given_number range: ${givens[0]} … ${givens[givens.length - 1]}`)
  // Distribution by year
  const byYear = {}
  for (const c of cluster) {
    const y = (c.invoice_date ?? '').slice(0, 4) || '?'
    byYear[y] = (byYear[y] ?? 0) + 1
  }
  console.log(`  by year:`)
  for (const [y, n] of Object.entries(byYear).sort()) console.log(`    ${y}: ${n}`)
  // Distribution by year-month for finer-grained signature
  const byMonth = {}
  for (const c of cluster) {
    const m = (c.invoice_date ?? '').slice(0, 7) || '?'
    byMonth[m] = (byMonth[m] ?? 0) + 1
  }
  console.log(`  by year-month:`)
  for (const [m, n] of Object.entries(byMonth).sort()) console.log(`    ${m}: ${n}`)
}

// Cluster vs extracted overlap test: are the extracted invoices CONSISTENTLY newer?
console.log(`\n──────── CUTOFF TEST ────────`)
const clusterMaxDate = cluster.map(c => c.invoice_date).filter(Boolean).sort().pop()
const extractedMinDate = extracted.map(c => c.invoice_date).filter(Boolean).sort()[0]
console.log(`  Latest invoice in cluster: ${clusterMaxDate}`)
console.log(`  Earliest invoice in extracted (with parent): ${extractedMinDate}`)
if (clusterMaxDate && extractedMinDate) {
  if (clusterMaxDate < extractedMinDate) {
    console.log(`  ✓ CLEAN CUTOFF: cluster all predates extracted set — strong (B) sync-window-gap signature`)
  } else if (clusterMaxDate === extractedMinDate) {
    console.log(`  ~ Adjacent: cluster ends exactly where extracted begins — likely (B) with slight overlap`)
  } else {
    console.log(`  ⚠️  OVERLAP: clusters overlap in date range — less clear, may need Fortnox probe`)
  }
}

// Compute cluster impact on supplier_invoice_lines (how many lines does the cluster represent?)
console.log(`\n──────── CLUSTER LINE IMPACT ────────`)
if (cluster.length > 0) {
  const clusterGivens = cluster.map(c => c.fortnox_invoice_number)
  // Pull line counts in batches of 30
  const batches = []
  for (let i = 0; i < clusterGivens.length; i += 30) batches.push(clusterGivens.slice(i, i + 30))
  let totalLines = 0
  const byStatus2 = { needs_review: 0, not_inventory: 0, matched: 0, other: 0 }
  for (const batch of batches) {
    const inList = batch.map(g => `"${g}"`).join(',')
    const lines = await q(`supplier_invoice_lines?select=match_status,raw_description&business_id=eq.${VERO}&fortnox_invoice_number=in.(${inList})`)
    totalLines += lines.length
    for (const l of lines) {
      const s = l.match_status
      if (byStatus2[s] !== undefined) byStatus2[s] += 1
      else byStatus2.other += 1
    }
  }
  console.log(`  Total supplier_invoice_lines belonging to cluster: ${totalLines}`)
  console.log(`  By match_status: ${JSON.stringify(byStatus2)}`)
  console.log(`  → not_inventory is the portion Rule (a) and (b) terminal-stated; needs_review is still in queue`)
}

// Pull 5-10 sample identifiers for Step 2 Fortnox probe (if needed)
console.log(`\n──────── STEP 2 SAMPLE CANDIDATES ────────`)
console.log(`If a Fortnox GET probe is needed, the following 10 cluster invoices would be the sample:`)
const sortedCluster = cluster.sort((a, b) => String(b.invoice_date ?? '').localeCompare(String(a.invoice_date ?? '')))
const sample = sortedCluster.slice(0, 5).concat(sortedCluster.slice(-5)) // 5 newest + 5 oldest
for (const c of sample) {
  console.log(`  given_number=${c.fortnox_invoice_number}  invoice_date=${c.invoice_date}  supplier=${c.supplier_fortnox_number}`)
}

console.log(`\nDone. Read-only — no writes.`)
