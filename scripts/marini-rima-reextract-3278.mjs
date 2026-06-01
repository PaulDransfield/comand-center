#!/usr/bin/env node
// Re-run just invoice 3278 (credit note) with the new force-Sonnet trigger.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'

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
const fileEnv = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
for (const [k, v] of Object.entries(fileEnv)) {
  if (!(k in process.env) || /^mock_|^https:\/\/mock-/.test(process.env[k] ?? '')) process.env[k] = v
}

const { extractInvoicePdf } = await import('../lib/inventory/pdf-extractor.ts')
const { createClient } = await import('@supabase/supabase-js')

const TARGET = { business_id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c', fortnox_invoice_number: '3278' }

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const { data: ext } = await db
  .from('invoice_pdf_extractions')
  .select('org_id, pdf_file_id, supplier_name_snapshot, supplier_fortnox_number, invoice_date, total_header, status, rows_extracted')
  .eq('business_id', TARGET.business_id)
  .eq('fortnox_invoice_number', TARGET.fortnox_invoice_number)
  .maybeSingle()

console.log(`prev: status=${ext.status}  rows=${ext.rows_extracted}  header=${ext.total_header}`)

const start = Date.now()
const r = await extractInvoicePdf(db, {
  org_id:                  ext.org_id,
  business_id:             TARGET.business_id,
  fortnox_invoice_number:  TARGET.fortnox_invoice_number,
  invoice_date:            ext.invoice_date,
  supplier_fortnox_number: ext.supplier_fortnox_number,
  supplier_name_snapshot:  ext.supplier_name_snapshot,
  pdf_file_id:             ext.pdf_file_id,
  invoice_total_header:    ext.total_header,
})
const dur = ((Date.now() - start) / 1000).toFixed(1)
console.log(`  -> status=${r.status}  rows=${r.rows_extracted}  total=${r.total_extracted}  header=${r.total_header}  delta=${r.total_delta_pct}%  ai=${r.ai_model}  cost=$${r.cost_usd}  ${dur}s`)
console.log(`  warnings: ${JSON.stringify(r.validation_warnings ?? [], null, 2)}`)
if (r.extracted_rows?.length) {
  console.log(`  rows:`)
  r.extracted_rows.forEach((row, i) => {
    console.log(`    ${i+1}. ${(row.description ?? '').slice(0, 70)} | qty=${row.quantity} ${row.unit ?? ''} | total=${row.total_excl_vat}`)
  })
}
if (!existsSync('tmp')) mkdirSync('tmp')
writeFileSync(`tmp/marini-rima-3278-resonnet-${Date.now()}.json`, JSON.stringify(r, null, 2))
