#!/usr/bin/env node
// scripts/diag-empty-line-recovery-step1b.mjs
//
// Step 1 retry — look up the 2 M&S reference invoices via invoice_number
// (the supplier-issued number) instead of fortnox_invoice_number
// (Fortnox's GivenNumber).

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

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

const refs = [
  { biz: VERO,   bizName: 'Vero',   invoiceNumber: '78592617', date: '2026-05-08' },
  { biz: CHICCE, bizName: 'Chicce', invoiceNumber: '78691561', date: '2026-05-26' },
]

for (const r of refs) {
  console.log(`\n${'═'.repeat(78)}\n  ${r.bizName} — supplier invoice ${r.invoiceNumber} (${r.date})\n${'═'.repeat(78)}`)

  // Look up parent invoice by invoice_number (supplier's number)
  const fsi = await q(
    `fortnox_supplier_invoices?select=given_number,invoice_number,supplier_name,supplier_number,invoice_date,total,raw_data&business_id=eq.${r.biz}&invoice_number=eq.${r.invoiceNumber}`
  )
  console.log(`  fortnox_supplier_invoices rows matching invoice_number=${r.invoiceNumber}: ${fsi.length}`)
  if (fsi.length === 0) {
    // Try fuzzy match
    const fuzzy = await q(`fortnox_supplier_invoices?select=given_number,invoice_number,supplier_name,invoice_date&business_id=eq.${r.biz}&invoice_date=eq.${r.date}&supplier_name=ilike.*martin*servera*`)
    console.log(`  Fuzzy lookup by date+supplier (Martin&Servera ${r.date}): ${fuzzy.length} rows`)
    for (const f of fuzzy.slice(0, 5)) {
      console.log(`    given_number=${f.given_number} invoice_number=${f.invoice_number} supplier="${f.supplier_name}"`)
    }
    continue
  }
  const inv = fsi[0]
  console.log(`  given_number=${inv.given_number} invoice_number=${inv.invoice_number} supplier="${inv.supplier_name}" total=${inv.total}`)

  // Now look up supplier_invoice_lines by given_number (which is what's stored as fortnox_invoice_number)
  const lines = await q(
    `supplier_invoice_lines?select=id,row_number,raw_description,article_number,quantity,total_excl_vat,account_number,source,match_status&business_id=eq.${r.biz}&fortnox_invoice_number=eq.${inv.given_number}&order=row_number`
  )
  console.log(`\n  supplier_invoice_lines rows for given_number=${inv.given_number}: ${lines.length}`)
  const empties = lines.filter(l => l.raw_description == null || String(l.raw_description).trim() === '')
  const itemized = lines.filter(l => l.raw_description != null && String(l.raw_description).trim() !== '')
  console.log(`    empty: ${empties.length}   itemized: ${itemized.length}`)
  const bySource = {}
  const byStatus = {}
  for (const l of lines) {
    bySource[l.source ?? '(null)'] = (bySource[l.source ?? '(null)'] ?? 0) + 1
    byStatus[l.match_status ?? '(null)'] = (byStatus[l.match_status ?? '(null)'] ?? 0) + 1
  }
  console.log(`    by source: ${JSON.stringify(bySource)}`)
  console.log(`    by match_status: ${JSON.stringify(byStatus)}`)
  console.log(`    Sample rows (first 10):`)
  for (const l of lines.slice(0, 10)) {
    console.log(`      row ${String(l.row_number).padStart(2)}: acct=${l.account_number ?? '?'} amt=${Number(l.total_excl_vat ?? 0).toFixed(0).padStart(7)} src=${l.source} status=${l.match_status} desc="${(l.raw_description ?? '').slice(0, 50)}"`)
  }

  // Check invoice_pdf_extractions
  const exts = await q(
    `invoice_pdf_extractions?select=id,status,attempts,pdf_file_id,rows_extracted,total_extracted,total_header,total_delta_pct,ai_model,cost_usd,error_message,created_at,completed_at&business_id=eq.${r.biz}&fortnox_invoice_number=eq.${inv.given_number}&order=created_at.desc`
  )
  console.log(`\n  invoice_pdf_extractions rows: ${exts.length}`)
  for (const e of exts) {
    console.log(`    status=${e.status} attempts=${e.attempts} pdf_file_id=${e.pdf_file_id ?? '(null)'} rows_extracted=${e.rows_extracted ?? '?'} total_extracted=${e.total_extracted ?? '?'} total_header=${e.total_header ?? '?'} delta_pct=${e.total_delta_pct ?? '?'} model=${e.ai_model ?? '?'} cost=${e.cost_usd ?? '?'} err="${(e.error_message ?? '').slice(0, 80)}"`)
  }

  // Check raw_data for PDF/file refs
  const raw = inv.raw_data ?? {}
  const vouchers = raw.Vouchers ?? null
  const supplierinvoiceRef = Array.isArray(vouchers) ? vouchers.find(v => v?.ReferenceType === 'SUPPLIERINVOICE') : null
  console.log(`\n  raw_data analysis:`)
  console.log(`    Vouchers array: ${Array.isArray(vouchers) ? vouchers.length + ' refs' : 'none'}`)
  if (supplierinvoiceRef) console.log(`    SUPPLIERINVOICE ref: Series=${supplierinvoiceRef.Series} Number=${supplierinvoiceRef.Number}`)
  const fileKeys = Object.keys(raw).filter(k => /file|pdf|attach|archive|inbox/i.test(k))
  console.log(`    Top-level file-related keys: ${fileKeys.length > 0 ? fileKeys.join(', ') : '(none)'}`)
  for (const k of fileKeys) console.log(`      ${k} = ${JSON.stringify(raw[k]).slice(0, 80)}`)
}

console.log(`\nDone. Read-only — no writes.`)
