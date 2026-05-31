#!/usr/bin/env node
// Sample M&S invoices at Vero marked 'no_pdf' to verify the extractor's
// classification is honest.

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

const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

// Get invoice_pdf_extractions for M&S at Vero, split by status
const allMS = await q(
  `invoice_pdf_extractions?select=fortnox_invoice_number,status,attempts,pdf_file_id,rows_extracted,error_message,supplier_name_snapshot&business_id=eq.${VERO}&supplier_name_snapshot=ilike.*Martin*Servera*&order=created_at.desc`
)
console.log(`Total M&S extractions at Vero: ${allMS.length}`)
const byStatus = {}
for (const e of allMS) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1
console.log(`By status: ${JSON.stringify(byStatus)}`)

// Sample 3 'no_pdf' M&S invoices
const noPdf = allMS.filter(e => e.status === 'no_pdf').slice(0, 3)
console.log(`\nSampling 3 'no_pdf' M&S invoices to drill into:\n`)

for (const ext of noPdf) {
  console.log(`${'═'.repeat(78)}\n  given_number=${ext.fortnox_invoice_number}\n${'═'.repeat(78)}`)
  console.log(`  Extraction record: status=${ext.status} attempts=${ext.attempts} pdf_file_id=${ext.pdf_file_id ?? '(null)'} err="${(ext.error_message ?? '').slice(0, 100)}"`)

  // Parent invoice
  const inv = await q(
    `fortnox_supplier_invoices?select=given_number,invoice_number,supplier_name,invoice_date,total,raw_data&business_id=eq.${VERO}&given_number=eq.${ext.fortnox_invoice_number}`
  )
  if (inv.length === 0) { console.log(`  ⚠️ parent not found`); continue }
  const i = inv[0]
  console.log(`  invoice_number=${i.invoice_number} date=${i.invoice_date} total=${i.total}`)

  // raw_data key surface
  const raw = i.raw_data ?? {}
  const keys = Object.keys(raw)
  const fileKeys = keys.filter(k => /file|pdf|attach|archive|inbox|document/i.test(k))
  console.log(`  raw_data keys (${keys.length}): ${keys.join(', ')}`)
  for (const k of fileKeys) {
    const v = raw[k]
    console.log(`    ${k} = ${typeof v === 'object' ? JSON.stringify(v) : String(v).slice(0, 100)}`)
  }
  // Vouchers
  console.log(`  Vouchers: ${Array.isArray(raw.Vouchers) ? JSON.stringify(raw.Vouchers) : 'none'}`)

  // supplier_invoice_lines
  const lines = await q(
    `supplier_invoice_lines?select=row_number,raw_description,account_number,total_excl_vat,source,match_status&business_id=eq.${VERO}&fortnox_invoice_number=eq.${ext.fortnox_invoice_number}&order=row_number`
  )
  console.log(`  supplier_invoice_lines (${lines.length}):`)
  for (const l of lines.slice(0, 5)) {
    console.log(`    row ${String(l.row_number).padStart(2)}: acct=${l.account_number ?? '?'} amt=${Number(l.total_excl_vat ?? 0).toFixed(0).padStart(7)} src=${l.source} status=${l.match_status} desc="${(l.raw_description ?? '(empty)').slice(0, 50)}"`)
  }
}

console.log(`\nDone. Read-only — no writes.`)
