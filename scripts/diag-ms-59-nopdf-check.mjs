#!/usr/bin/env node
// scripts/diag-ms-59-nopdf-check.mjs
//
// M&S 59 with-parent no_pdf check — Step 1 (READ-ONLY DB).
// Per ms-59-nopdf-check-prompt.md.
//
// Tests whether the 59 M&S Vero invoices marked 'no_pdf' (with parent
// in fortnox_supplier_invoices) are (A) genuinely no PDF or (B) PDF-
// lookup coverage bug. Compares the 37 extracted vs the 59 no_pdf
// across raw_data fields to find systematic differences.

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

// ───── Pull the 59 no_pdf-with-parent + the 37 extracted M&S Vero ─────

const allMSExt = await qPaged(
  `invoice_pdf_extractions?select=fortnox_invoice_number,status,attempts,invoice_date,pdf_file_id,error_message&business_id=eq.${VERO}&supplier_name_snapshot=ilike.*Martin*Servera*`
)
console.log(`Total M&S Vero extraction records: ${allMSExt.length}`)
const noPdf = allMSExt.filter(e => e.status === 'no_pdf')
const extracted = allMSExt.filter(e => e.status === 'extracted')
console.log(`  no_pdf: ${noPdf.length}  extracted: ${extracted.length}`)

// Cross-reference with fortnox_supplier_invoices, pull FULL raw_data
const fsi = await qPaged(
  `fortnox_supplier_invoices?select=given_number,invoice_number,invoice_date,supplier_name,supplier_number,total,vat,cancelled,balance,raw_data&business_id=eq.${VERO}&supplier_name=ilike.*Martin*Servera*`
)
const fsiByGiven = new Map(fsi.map(f => [String(f.given_number), f]))
console.log(`  fortnox_supplier_invoices rows: ${fsi.length}`)

// Categorize
const noPdfWithParent = noPdf.filter(e => fsiByGiven.has(String(e.fortnox_invoice_number)))
const noPdfMissingParent = noPdf.filter(e => !fsiByGiven.has(String(e.fortnox_invoice_number)))
const extractedWithParent = extracted.filter(e => fsiByGiven.has(String(e.fortnox_invoice_number)))
console.log(`\n  no_pdf WITH parent (the 59 in question): ${noPdfWithParent.length}`)
console.log(`  no_pdf MISSING parent (the 5-cluster):    ${noPdfMissingParent.length}`)
console.log(`  extracted WITH parent (the 37):           ${extractedWithParent.length}`)

// ───── Compare 37 extracted vs 59 no_pdf-with-parent: field signatures ─────

function summarizeRawDataFields(records, label) {
  console.log(`\n── ${label} (${records.length} records) ──`)
  const fieldStats = new Map()  // field name → { populated: n, empty: n }
  const sampleKeys = new Set()
  for (const e of records) {
    const fsiRow = fsiByGiven.get(String(e.fortnox_invoice_number))
    if (!fsiRow) continue
    const raw = fsiRow.raw_data ?? {}
    for (const k of Object.keys(raw)) {
      sampleKeys.add(k)
      const s = fieldStats.get(k) ?? { populated: 0, empty: 0 }
      const v = raw[k]
      if (v == null || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && Object.keys(v).length === 0) || v === '') {
        s.empty += 1
      } else {
        s.populated += 1
      }
      fieldStats.set(k, s)
    }
  }
  return { fieldStats, sampleKeys }
}

const extStats = summarizeRawDataFields(extractedWithParent, '37 EXTRACTED — raw_data field population')
const noPdfStats = summarizeRawDataFields(noPdfWithParent, '59 NO_PDF — raw_data field population')

// Diff: which fields are populated significantly more often in extracted vs no_pdf?
console.log(`\n${'═'.repeat(78)}\n  KEY DIFFERENCE — fields populated in 37 EXTRACTED but rare in 59 NO_PDF\n${'═'.repeat(78)}`)
const allFields = new Set([...extStats.sampleKeys, ...noPdfStats.sampleKeys])
const diffs = []
for (const f of allFields) {
  const eS = extStats.fieldStats.get(f) ?? { populated: 0, empty: 0 }
  const nS = noPdfStats.fieldStats.get(f) ?? { populated: 0, empty: 0 }
  const ePct = extractedWithParent.length > 0 ? eS.populated / extractedWithParent.length : 0
  const nPct = noPdfWithParent.length > 0 ? nS.populated / noPdfWithParent.length : 0
  const delta = ePct - nPct
  diffs.push({ field: f, extPct: ePct, noPdfPct: nPct, delta })
}
diffs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
console.log(`  field${' '.repeat(35)} ext%   noPdf%   delta`)
for (const d of diffs.slice(0, 20)) {
  if (Math.abs(d.delta) > 0.01) {
    console.log(`  ${d.field.padEnd(40)} ${(d.extPct*100).toFixed(1).padStart(5)}%  ${(d.noPdfPct*100).toFixed(1).padStart(5)}%  ${d.delta >= 0 ? '+' : ''}${(d.delta*100).toFixed(1)}pp`)
  }
}

// ───── Focused check: SupplierInvoiceFileConnections (the extractor's key) ─────
console.log(`\n${'═'.repeat(78)}\n  FOCUSED CHECK — SupplierInvoiceFileConnections field\n${'═'.repeat(78)}`)
console.log(`(extractor's primary PDF-lookup field — present + non-empty = inline file ID = has_pdf)\n`)

for (const [label, records] of [['37 extracted', extractedWithParent], ['59 no_pdf', noPdfWithParent]]) {
  let withSIFC = 0, emptySIFC = 0, noField = 0
  for (const e of records) {
    const fsiRow = fsiByGiven.get(String(e.fortnox_invoice_number))
    if (!fsiRow) continue
    const raw = fsiRow.raw_data ?? {}
    const sifc = raw.SupplierInvoiceFileConnections
    if (sifc === undefined) noField += 1
    else if (Array.isArray(sifc) && sifc.length > 0) withSIFC += 1
    else emptySIFC += 1
  }
  console.log(`  ${label}:`)
  console.log(`    SupplierInvoiceFileConnections populated (>=1 entry): ${withSIFC}`)
  console.log(`    SupplierInvoiceFileConnections present but empty []:   ${emptySIFC}`)
  console.log(`    SupplierInvoiceFileConnections field MISSING entirely: ${noField}`)
}

// ───── Date distribution + cancelled / credit-note indicators ─────
console.log(`\n${'═'.repeat(78)}\n  Date distribution + credit-note indicators\n${'═'.repeat(78)}`)
for (const [label, records] of [['37 extracted', extractedWithParent], ['59 no_pdf', noPdfWithParent]]) {
  const dates = records.map(e => e.invoice_date).filter(Boolean).sort()
  console.log(`\n  ${label}: ${records.length} records`)
  if (dates.length > 0) console.log(`    date range: ${dates[0]} … ${dates[dates.length - 1]}`)
  // Year-month distribution
  const byYM = {}
  for (const d of dates) {
    const ym = d.slice(0, 7)
    byYM[ym] = (byYM[ym] ?? 0) + 1
  }
  console.log(`    by year-month (top 10):`)
  for (const [ym, n] of Object.entries(byYM).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`      ${ym}: ${n}`)
  }

  // Credit notes / negative totals / cancelled
  let cancelled = 0, negativeTotal = 0, zeroBalance = 0, smallTotal = 0
  for (const e of records) {
    const fsiRow = fsiByGiven.get(String(e.fortnox_invoice_number))
    if (!fsiRow) continue
    if (fsiRow.cancelled) cancelled += 1
    if (Number(fsiRow.total ?? 0) < 0) negativeTotal += 1
    if (Number(fsiRow.balance ?? 0) === 0) zeroBalance += 1
    if (Math.abs(Number(fsiRow.total ?? 0)) < 100) smallTotal += 1
  }
  console.log(`    cancelled:        ${cancelled}`)
  console.log(`    total < 0 (credit-note suspect): ${negativeTotal}`)
  console.log(`    balance = 0:      ${zeroBalance}`)
  console.log(`    |total| < 100 SEK (small/fee): ${smallTotal}`)
}

// ───── Line counts + match_status impact for the 59 ─────
console.log(`\n${'═'.repeat(78)}\n  Cluster impact (the 59)\n${'═'.repeat(78)}`)
if (noPdfWithParent.length > 0) {
  const givens = noPdfWithParent.map(e => e.fortnox_invoice_number)
  const batches = []
  for (let i = 0; i < givens.length; i += 30) batches.push(givens.slice(i, i + 30))
  let total = 0
  const byStatus = { needs_review: 0, not_inventory: 0, matched: 0, other: 0 }
  for (const batch of batches) {
    const inList = batch.map(g => `"${g}"`).join(',')
    const lines = await q(`supplier_invoice_lines?select=match_status,total_excl_vat&business_id=eq.${VERO}&fortnox_invoice_number=in.(${inList})`)
    total += lines.length
    for (const l of lines) {
      const s = l.match_status
      if (byStatus[s] !== undefined) byStatus[s] += 1
      else byStatus.other += 1
    }
  }
  console.log(`  Total supplier_invoice_lines belonging to the 59: ${total}`)
  console.log(`  By match_status: ${JSON.stringify(byStatus)}`)
  console.log(`  → "not_inventory" is what Rule (a) and Rule (b) terminal-stated`)
  console.log(`  → "needs_review" would shrink Paul's queue if recovered to itemized`)
}

// ───── 8-sample list for owner Fortnox-UI eyeball (Step 2) ─────
console.log(`\n${'═'.repeat(78)}\n  STEP 2 SAMPLE — for owner UI eyeball in Fortnox\n${'═'.repeat(78)}`)
const noPdfEnriched = noPdfWithParent.map(e => {
  const f = fsiByGiven.get(String(e.fortnox_invoice_number))
  return {
    given_number: e.fortnox_invoice_number,
    invoice_number: f?.invoice_number ?? null,
    invoice_date: e.invoice_date,
    total: Number(f?.total ?? 0),
    balance: Number(f?.balance ?? 0),
  }
}).sort((a, b) => String(b.invoice_date ?? '').localeCompare(String(a.invoice_date ?? '')))

const newest5 = noPdfEnriched.slice(0, 5)
const oldest3 = noPdfEnriched.slice(-3)
const sampleList = [...newest5, ...oldest3]
console.log(`  Sample (5 newest + 3 oldest of the 59):\n`)
console.log(`  given_number | invoice_number | invoice_date | total      | balance`)
console.log(`  ${'-'.repeat(74)}`)
for (const s of sampleList) {
  console.log(`  ${String(s.given_number).padEnd(12)} | ${String(s.invoice_number ?? '').padEnd(14)} | ${(s.invoice_date ?? '').padEnd(12)} | ${s.total.toFixed(2).padStart(10)} | ${s.balance.toFixed(2).padStart(8)}`)
}
console.log(`\n  → Owner: open Fortnox → Leverantörsfakturor → search Faktura/Verifikationsnr.`)
console.log(`    For each, check whether a PDF attachment is present.`)
console.log(`    If >=2 of these have a PDF: (B) coverage bug — open ticket.`)
console.log(`    If 0 have a PDF: (A) confirmed — close task #88.`)

console.log(`\nDone. Read-only — no writes.`)
