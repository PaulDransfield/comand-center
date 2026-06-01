#!/usr/bin/env node
// Characterise the current Vero PDF backlog. The task description was
// "14 failed + 51 pending" — likely shifted since it was logged.
// Check the actual state, group by recoverability, and surface what
// can be retried via /api/admin/reextract-invoice.

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
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }
async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: h })
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

console.log('=== Vero invoice_pdf_extractions by status ===\n')

// All extractions at Vero
const all = []
for (let from = 0; ; from += 1000) {
  const batch = await q(`invoice_pdf_extractions?business_id=eq.${VERO}&select=fortnox_invoice_number,status,attempts,error_message,pdf_file_id,total_header,invoice_date,supplier_name_snapshot,validation_warnings&offset=${from}&limit=1000`)
  all.push(...batch)
  if (batch.length < 1000) break
  if (all.length > 10000) break
}
console.log(`Total Vero extractions: ${all.length}`)

const byStatus = {}
for (const r of all) {
  byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
}
console.log(`\nBy status:`)
for (const [s, n] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(20)} ${n}`)
}

// Failed + pending breakdown
const failed = all.filter(r => r.status === 'failed')
const pending = all.filter(r => r.status === 'pending')
const noPdf = all.filter(r => r.status === 'no_pdf')

console.log(`\n--- FAILED (${failed.length}) ---`)
const failGroup = {}
for (const r of failed) {
  const k = r.error_message ?? '(no error)'
  failGroup[k] = (failGroup[k] ?? []).concat([r])
}
for (const [err, rows] of Object.entries(failGroup).sort((a, b) => b[1].length - a[1].length).slice(0, 15)) {
  console.log(`  ${rows.length.toString().padStart(3)} × "${err.slice(0, 110)}"`)
  console.log(`        sample inv: ${rows.slice(0, 3).map(r => r.fortnox_invoice_number).join(', ')}`)
}

console.log(`\n--- PENDING (${pending.length}) ---`)
const samplePending = pending.slice(0, 10)
for (const r of samplePending) {
  console.log(`  ${r.fortnox_invoice_number?.padEnd(8)} attempts=${r.attempts ?? 0}  pdf=${r.pdf_file_id ? 'Y' : 'N'}  header=${r.total_header}  ${r.invoice_date}  ${r.supplier_name_snapshot?.slice(0, 30)}`)
}
if (pending.length > 10) console.log(`  ... ${pending.length - 10} more`)

console.log(`\n--- NO_PDF (${noPdf.length}) ---`)
console.log(`  (cannot retry — these have no PDF file attached at Fortnox; need #88 verification)`)

// Recoverable = failed + pending WITH pdf_file_id present
const recoverable = [...failed, ...pending].filter(r => r.pdf_file_id)
console.log(`\n=== RECOVERABLE (pdf_file_id present, retryable): ${recoverable.length} ===`)
console.log(`(would re-run through extractInvoicePdf — Marini/Rima force-Sonnet, all validators)`)
