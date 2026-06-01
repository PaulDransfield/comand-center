#!/usr/bin/env node
// scripts/marini-rima-reextract.mjs
//
// Runs the FULL production extractor (extractInvoicePdf) on the 5 known
// Marini/Rima passthrough invoices at Chicce Slotsgatan and classifies
// each outcome against the reconciliation acceptance bar.
//
// Same code path as production cron + /api/admin/reextract-invoice —
// just driven locally so we don't need the Vercel admin secret.
//
// Usage:  node scripts/marini-rima-reextract.mjs
// Env:    reads .env.local + .env.production.local (prod creds)

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

// Now bring up the extractor. tsx/esm so the TS file resolves cleanly.
await import('tsx/esm')
const { extractInvoicePdf } = await import('../lib/inventory/pdf-extractor.ts')
const { createClient }      = await import('@supabase/supabase-js')

const TARGETS = [
  { business_id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c', fortnox_invoice_number: '3174' }, // Laweka 2025-09
  { business_id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c', fortnox_invoice_number: '2902' }, // Eventcenter 2025-05
  { business_id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c', fortnox_invoice_number: '2948' }, // Eventcenter 2025-06
  { business_id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c', fortnox_invoice_number: '2975' }, // Eventcenter 2025-07
  { business_id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c', fortnox_invoice_number: '3278' }, // Laweka credit 2025-11
]

function classify(result) {
  const warnings = result.validation_warnings ?? []
  const scalingApplied  = warnings.some(w => w.code === 'proportional_scaling_applied')
  const scalingRejected = warnings.some(w => w.code === 'passthrough_scaling_rejected')
  const reconciles =
       result.total_extracted != null && result.total_header != null
    && Math.abs(Number(result.total_extracted) - Number(result.total_header)) < 1.0
  if (result.status === 'extracted' && scalingApplied && reconciles) return 'GOOD'
  if (scalingRejected)                                                return 'REJECTED'
  if (result.rows_extracted <= 1)                                     return 'INERT'
  return result.status === 'extracted' ? 'OTHER_ACCEPTED' : 'OTHER_BLOCKED'
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key || url.includes('mock-supabase-url')) throw new Error(`Need prod Supabase env. url=${url?.slice(0,40)}`)
const db = createClient(url, key, { auth: { persistSession: false } })

const results = []
for (const t of TARGETS) {
  console.log(`\n=== ${t.fortnox_invoice_number} ===`)
  const { data: ext } = await db
    .from('invoice_pdf_extractions')
    .select('org_id, pdf_file_id, supplier_name_snapshot, supplier_fortnox_number, invoice_date, total_header, status, rows_extracted')
    .eq('business_id', t.business_id)
    .eq('fortnox_invoice_number', t.fortnox_invoice_number)
    .maybeSingle()
  if (!ext) { console.log('  no extraction record'); results.push({ ...t, error: 'no record' }); continue }
  console.log(`  prev: status=${ext.status}, rows=${ext.rows_extracted}, header=${ext.total_header}`)
  if (!ext.pdf_file_id) { console.log('  no pdf_file_id'); results.push({ ...t, error: 'no pdf' }); continue }

  const start = Date.now()
  try {
    const r = await extractInvoicePdf(db, {
      org_id:                  ext.org_id,
      business_id:             t.business_id,
      fortnox_invoice_number:  t.fortnox_invoice_number,
      invoice_date:            ext.invoice_date,
      supplier_fortnox_number: ext.supplier_fortnox_number,
      supplier_name_snapshot:  ext.supplier_name_snapshot,
      pdf_file_id:             ext.pdf_file_id,
      invoice_total_header:    ext.total_header,
    })
    const cls = classify(r)
    const dur = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`  -> ${cls}  rows=${r.rows_extracted}  total=${r.total_extracted}  header=${r.total_header}  delta=${r.total_delta_pct}%  ai=${r.ai_model}  cost=$${r.cost_usd}  ${dur}s`)
    console.log(`  warnings: ${JSON.stringify(r.validation_warnings ?? [])}`)
    if (r.extracted_rows?.length) {
      console.log(`  sample rows:`)
      r.extracted_rows.slice(0, 3).forEach((row, i) => {
        console.log(`    ${i+1}. ${(row.description ?? '').slice(0, 60)} | qty=${row.quantity} ${row.unit ?? ''} | total=${row.total_excl_vat}`)
      })
    }
    results.push({ ...t, classification: cls, ...r })
  } catch (e) {
    console.log(`  ERROR: ${e?.message ?? e}`)
    results.push({ ...t, error: e?.message ?? String(e) })
  }
}

console.log('\n\n=== SUMMARY ===')
for (const r of results) {
  const tag = r.error ? `ERROR: ${r.error}` : `${r.classification} (rows=${r.rows_extracted}, total=${r.total_extracted}, header=${r.total_header})`
  console.log(`  ${r.fortnox_invoice_number}: ${tag}`)
}
const tally = {
  GOOD:             results.filter(r => r.classification === 'GOOD').length,
  INERT:            results.filter(r => r.classification === 'INERT').length,
  REJECTED:         results.filter(r => r.classification === 'REJECTED').length,
  OTHER_ACCEPTED:   results.filter(r => r.classification === 'OTHER_ACCEPTED').length,
  OTHER_BLOCKED:    results.filter(r => r.classification === 'OTHER_BLOCKED').length,
  ERROR:            results.filter(r => r.error).length,
}
console.log(`\n  tally: ${JSON.stringify(tally)}`)
if (!existsSync('tmp')) mkdirSync('tmp')
const out = `tmp/marini-rima-reextract-${Date.now()}.json`
writeFileSync(out, JSON.stringify({ ts: new Date().toISOString(), tally, results }, null, 2))
console.log(`\n  wrote: ${out}`)
