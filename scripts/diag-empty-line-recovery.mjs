#!/usr/bin/env node
// scripts/diag-empty-line-recovery.mjs
//
// Empty-line recovery investigation (READ-ONLY).
// Per empty-line-recovery-investigation-prompt.md.
//
// Tests the hypothesis: the "empty source-blank lines" we've been
// terminal-stating are actually itemized on the PDF — extraction loss,
// not source-blank. Quantifies the recovery opportunity.
//
// No writes. No PDF content dumping (structure/existence only).

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

// ═══════════════════════════════════════════════════════════════════
// STEP 1 — Trace the 2 M&S reference invoices
// ═══════════════════════════════════════════════════════════════════

console.log(`${'═'.repeat(78)}\n  STEP 1 — Trace the 2 Martin & Servera reference invoices\n${'═'.repeat(78)}`)

const refs = [
  { biz: VERO,   bizName: 'Vero',   invoiceNum: '78592617', date: '2026-05-08' },
  { biz: CHICCE, bizName: 'Chicce', invoiceNum: '78691561', date: '2026-05-26' },
]

for (const r of refs) {
  console.log(`\n  ── ${r.bizName} invoice ${r.invoiceNum} (${r.date}) ──`)

  // 1. supplier_invoice_lines for this invoice
  const lines = await q(
    `supplier_invoice_lines?select=id,row_number,raw_description,article_number,quantity,unit,price_per_unit,total_excl_vat,account_number,source,match_status,product_alias_id&business_id=eq.${r.biz}&fortnox_invoice_number=eq.${r.invoiceNum}&order=row_number`
  )
  console.log(`    supplier_invoice_lines rows: ${lines.length}`)
  if (lines.length === 0) {
    console.log(`    ⚠️  NOT FOUND in supplier_invoice_lines — invoice may not be in DB`)
    continue
  }
  const empties = lines.filter(l => isEmpty(l.raw_description))
  const itemized = lines.filter(l => !isEmpty(l.raw_description))
  console.log(`      empty/null description: ${empties.length}`)
  console.log(`      with description:        ${itemized.length}`)
  // Source split
  const bySource = {}
  for (const l of lines) bySource[l.source ?? '(null)'] = (bySource[l.source ?? '(null)'] ?? 0) + 1
  console.log(`      by source: ${JSON.stringify(bySource)}`)
  // Status split
  const byStatus = {}
  for (const l of lines) byStatus[l.match_status ?? '(null)'] = (byStatus[l.match_status ?? '(null)'] ?? 0) + 1
  console.log(`      by match_status: ${JSON.stringify(byStatus)}`)
  // Sample rows
  console.log(`    Sample rows (first 5):`)
  for (const l of lines.slice(0, 5)) {
    console.log(`      row ${String(l.row_number).padStart(2)}: acct=${l.account_number ?? '?'} amt=${Number(l.total_excl_vat ?? 0).toFixed(0).padStart(7)} src=${l.source} status=${l.match_status} desc="${(l.raw_description ?? '').slice(0, 50)}"`)
  }

  // 2. Parent invoice in fortnox_supplier_invoices
  const fsi = await q(
    `fortnox_supplier_invoices?select=given_number,supplier_name,invoice_date,total,raw_data&business_id=eq.${r.biz}&given_number=eq.${r.invoiceNum}`
  )
  if (fsi.length === 0) {
    console.log(`    ⚠️  Parent invoice NOT in fortnox_supplier_invoices`)
  } else {
    const inv = fsi[0]
    console.log(`    Parent invoice: total=${inv.total} supplier="${inv.supplier_name}"`)
    // Check raw_data for PDF/attachment refs
    const raw = inv.raw_data ?? {}
    const vouchers = raw.Vouchers ?? null
    const supplierinvoiceRef = vouchers?.find(v => v?.ReferenceType === 'SUPPLIERINVOICE')
    console.log(`    raw_data.Vouchers present: ${vouchers !== null} (${Array.isArray(vouchers) ? vouchers.length : 'n/a'} refs)`)
    console.log(`    SUPPLIERINVOICE voucher ref: ${supplierinvoiceRef ? `Series=${supplierinvoiceRef.Series} Number=${supplierinvoiceRef.Number}` : 'NONE'}`)
    // Check for additional file-related keys
    const fileKeys = Object.keys(raw).filter(k => /file|pdf|attach|archive|inbox/i.test(k))
    console.log(`    File-related keys in raw_data: ${fileKeys.length > 0 ? fileKeys.join(', ') : '(none top-level)'}`)
  }

  // 3. invoice_pdf_extractions for this invoice
  const exts = await q(
    `invoice_pdf_extractions?select=id,status,attempts,pdf_file_id,rows_extracted,total_extracted,total_header,total_delta_pct,ai_model,cost_usd,error_message,created_at,completed_at&business_id=eq.${r.biz}&fortnox_invoice_number=eq.${r.invoiceNum}&order=created_at.desc`
  )
  console.log(`    invoice_pdf_extractions rows: ${exts.length}`)
  for (const e of exts) {
    console.log(`      status=${e.status} attempts=${e.attempts} pdf_file_id=${e.pdf_file_id ?? '(null)'} rows_extracted=${e.rows_extracted ?? '?'} cost=${e.cost_usd ?? '?'} err="${(e.error_message ?? '').slice(0, 60)}"`)
  }
}

// ═══════════════════════════════════════════════════════════════════
// STEP 2 — System-wide recovery quantification
// ═══════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(78)}\n  STEP 2 — System-wide empty-line recovery opportunity\n${'═'.repeat(78)}`)

for (const [name, bid] of [['Chicce', CHICCE], ['Vero', VERO]]) {
  console.log(`\n  ── ${name} ──`)

  // Pull all empty supplier_invoice_lines (any status — recovery applies regardless of current status)
  const empties = await qPaged(
    `supplier_invoice_lines?select=id,fortnox_invoice_number,supplier_fortnox_number,supplier_name_snapshot,raw_description,account_number,match_status,source,total_excl_vat&business_id=eq.${bid}&raw_description=is.null`
  )
  // Also pull whitespace-only ones (different filter)
  const emptiesStr = await qPaged(
    `supplier_invoice_lines?select=id,fortnox_invoice_number,supplier_fortnox_number,supplier_name_snapshot,raw_description,account_number,match_status,source,total_excl_vat&business_id=eq.${bid}&raw_description=eq.`
  )
  const allEmpties = [...empties, ...emptiesStr]
  // Dedupe (some lines might match both filters)
  const empMap = new Map()
  for (const e of allEmpties) empMap.set(e.id, e)
  const emptiesAll = [...empMap.values()]
  console.log(`    Total empty/blank lines: ${emptiesAll.length}`)

  // Get distinct parent invoice numbers
  const invoiceNums = [...new Set(emptiesAll.map(e => e.fortnox_invoice_number))]
  console.log(`    Distinct parent invoices with empty lines: ${invoiceNums.length}`)

  // Cross-reference invoice_pdf_extractions: which of these invoices have an extraction attempt?
  const extsPath = `invoice_pdf_extractions?select=fortnox_invoice_number,status,pdf_file_id,attempts&business_id=eq.${bid}`
  const extsAll = await qPaged(extsPath)
  const extsByInvoice = new Map()
  for (const e of extsAll) extsByInvoice.set(e.fortnox_invoice_number, e)

  // Cross-reference fortnox_supplier_invoices: how many of these invoices have Vouchers refs (proxy for "PDF probably available")
  const fsiAll = await qPaged(`fortnox_supplier_invoices?select=given_number,raw_data&business_id=eq.${bid}`)
  const fsiByNum = new Map()
  for (const f of fsiAll) fsiByNum.set(f.given_number, f)

  // For each invoice with empties: classify recovery potential
  let extractedOK = 0, extractedFailed = 0, extractedNoPdf = 0, extractedPending = 0
  let noExtractionRecord = 0
  let noFsiRecord = 0
  let noVouchersRef = 0

  for (const invNum of invoiceNums) {
    const ext = extsByInvoice.get(invNum)
    if (ext) {
      if (ext.status === 'extracted') extractedOK += 1
      else if (ext.status === 'failed') extractedFailed += 1
      else if (ext.status === 'no_pdf') extractedNoPdf += 1
      else extractedPending += 1
    } else {
      noExtractionRecord += 1
      // Of those without extraction record, check if parent invoice exists
      const fsi = fsiByNum.get(invNum)
      if (!fsi) {
        noFsiRecord += 1
      } else {
        const vouchers = fsi.raw_data?.Vouchers
        const hasSI = Array.isArray(vouchers) && vouchers.some(v => v?.ReferenceType === 'SUPPLIERINVOICE')
        if (!hasSI) noVouchersRef += 1
      }
    }
  }
  console.log(`\n    Invoice extraction state (${invoiceNums.length} distinct):`)
  console.log(`      already extracted successfully:     ${extractedOK}`)
  console.log(`      extraction FAILED (retryable):      ${extractedFailed}`)
  console.log(`      extraction NO_PDF (unrecoverable):  ${extractedNoPdf}`)
  console.log(`      extraction pending/in-progress:     ${extractedPending}`)
  console.log(`      no extraction record at all:        ${noExtractionRecord}`)
  console.log(`        of which parent invoice missing in fortnox_supplier_invoices: ${noFsiRecord}`)
  console.log(`        of which parent invoice has no SUPPLIERINVOICE voucher ref:    ${noVouchersRef}`)
  console.log(`        of which parent invoice HAS SUPPLIERINVOICE ref (PDF available, never extracted): ${noExtractionRecord - noFsiRecord - noVouchersRef}`)

  // Line-level — how many empty lines map to each invoice category?
  const linesByCategory = { extracted: 0, failed: 0, noPdf: 0, pending: 0, neverAttemptedHasPdf: 0, neverAttemptedNoPdf: 0, noFsi: 0 }
  for (const e of emptiesAll) {
    const ext = extsByInvoice.get(e.fortnox_invoice_number)
    if (ext) {
      if (ext.status === 'extracted')      linesByCategory.extracted += 1
      else if (ext.status === 'failed')    linesByCategory.failed += 1
      else if (ext.status === 'no_pdf')    linesByCategory.noPdf += 1
      else                                  linesByCategory.pending += 1
    } else {
      const fsi = fsiByNum.get(e.fortnox_invoice_number)
      if (!fsi) {
        linesByCategory.noFsi += 1
      } else {
        const vouchers = fsi.raw_data?.Vouchers
        const hasSI = Array.isArray(vouchers) && vouchers.some(v => v?.ReferenceType === 'SUPPLIERINVOICE')
        if (hasSI) linesByCategory.neverAttemptedHasPdf += 1
        else linesByCategory.neverAttemptedNoPdf += 1
      }
    }
  }
  console.log(`\n    Empty-line breakdown (${emptiesAll.length} total empties):`)
  console.log(`      already-extracted invoice (empties survived extraction — anomaly worth flagging): ${linesByCategory.extracted}`)
  console.log(`      extraction-failed invoice (retryable):                                            ${linesByCategory.failed}`)
  console.log(`      extraction NO_PDF invoice (unrecoverable):                                        ${linesByCategory.noPdf}`)
  console.log(`      extraction pending invoice:                                                       ${linesByCategory.pending}`)
  console.log(`      NEVER ATTEMPTED but parent invoice has SUPPLIERINVOICE ref (RECOVERABLE):         ${linesByCategory.neverAttemptedHasPdf}  ← HEADLINE`)
  console.log(`      never attempted, parent has no Vouchers (genuinely no PDF):                       ${linesByCategory.neverAttemptedNoPdf}`)
  console.log(`      no parent invoice in fortnox_supplier_invoices (orphan):                          ${linesByCategory.noFsi}`)

  // Supplier breakdown of the RECOVERABLE class
  const recoverableEmpties = emptiesAll.filter(e => {
    const ext = extsByInvoice.get(e.fortnox_invoice_number)
    if (ext) return ext.status === 'failed'  // retryable
    const fsi = fsiByNum.get(e.fortnox_invoice_number)
    if (!fsi) return false
    const vouchers = fsi.raw_data?.Vouchers
    return Array.isArray(vouchers) && vouchers.some(v => v?.ReferenceType === 'SUPPLIERINVOICE')
  })
  const bySupplier = new Map()
  for (const e of recoverableEmpties) {
    const k = e.supplier_name_snapshot ?? '?'
    const g = bySupplier.get(k) ?? { name: k, count: 0, sek: 0 }
    g.count += 1
    g.sek += Math.abs(Number(e.total_excl_vat ?? 0))
    bySupplier.set(k, g)
  }
  console.log(`\n    Recoverable empties by supplier (top 15):`)
  for (const g of [...bySupplier.values()].sort((a,b)=>b.count-a.count).slice(0,15)) {
    console.log(`      ${String(g.count).padStart(4)}× ${g.sek.toFixed(0).padStart(8)} SEK  ${g.name}`)
  }
}

// ═══════════════════════════════════════════════════════════════════
// STEP 3 — M&S ÖVERSIKT KONTERING sizing (no build)
// ═══════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(78)}\n  STEP 3 — Martin & Servera ÖVERSIKT KONTERING opportunity sizing\n${'═'.repeat(78)}`)

// How many M&S invoices per business? (Both M&S supplier IDs at Vero, single at Chicce)
for (const [name, bid] of [['Chicce', CHICCE], ['Vero', VERO]]) {
  const msInvoices = await qPaged(
    `fortnox_supplier_invoices?select=given_number,supplier_name,invoice_date&business_id=eq.${bid}&or=(supplier_name.ilike.*martin*servera*,supplier_name.ilike.*martin*%26*servera*)`
  )
  console.log(`  ${name}: ${msInvoices.length} Martin & Servera invoices total`)
  // Latest 5 dates
  const latest = msInvoices.sort((a,b)=>String(b.invoice_date).localeCompare(String(a.invoice_date))).slice(0,5)
  console.log(`    Latest 5: ${latest.map(i => `${i.invoice_date}/${i.given_number}`).join(', ')}`)
}

console.log(`\n  NOTE: testing whether each M&S PDF carries the ÖVERSIKT KONTERING block requires`)
console.log(`  fetching + viewing the PDFs (not in scope for this read-only investigation —`)
console.log(`  see the 2 traced invoices above for a starting sample).`)

console.log(`\nDone. Read-only — no writes.`)
