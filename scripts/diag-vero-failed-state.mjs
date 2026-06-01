#!/usr/bin/env node
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
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

const r = await fetch(`${URL}/rest/v1/invoice_pdf_extractions?business_id=eq.${VERO}&status=eq.failed&select=fortnox_invoice_number,pdf_file_id,attempts,error_message,updated_at&limit=10`, { headers: h })
const rows = await r.json()
console.log(`failed sample: ${rows.length}`)
for (const x of rows) {
  console.log(`  ${x.fortnox_invoice_number?.padEnd(8)} pdf=${x.pdf_file_id ? 'Y' : 'N'} attempts=${x.attempts} err="${x.error_message?.slice(0, 40)}" updated=${x.updated_at}`)
}

// All failed counts by pdf_file_id presence
const allFailed = await fetch(`${URL}/rest/v1/invoice_pdf_extractions?business_id=eq.${VERO}&status=eq.failed&select=pdf_file_id&limit=1000`, { headers: h })
const fjson = await allFailed.json()
const withPdf = fjson.filter(r => r.pdf_file_id).length
const noPdf = fjson.filter(r => !r.pdf_file_id).length
console.log(`\nFailed total: ${fjson.length}`)
console.log(`  with pdf_file_id:    ${withPdf}`)
console.log(`  without pdf_file_id: ${noPdf}`)
