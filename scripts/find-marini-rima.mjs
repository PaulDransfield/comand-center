#!/usr/bin/env node
// Locate the 5 Marini/Rima passthrough invoices across all businesses.
// Reads prod env (.env.production.local) per the established diag pattern.
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

const targets = ['3174', '2902', '2948', '2975', '3278']

console.log('--- by fortnox_invoice_number ---')
for (const inv of targets) {
  const rows = await q(`invoice_pdf_extractions?fortnox_invoice_number=eq.${inv}&select=business_id,fortnox_invoice_number,supplier_name_snapshot,status,rows_extracted,total_header,total_extracted,pdf_file_id,invoice_date,org_id`)
  console.log(`  ${inv}: ${rows.length}`)
  for (const r of rows) console.log(`    biz=${r.business_id} org=${r.org_id} supplier=${r.supplier_name_snapshot} status=${r.status} rows=${r.rows_extracted} header=${r.total_header} date=${r.invoice_date} pdf=${r.pdf_file_id ? 'Y' : 'N'}`)
}

console.log('\n--- Chicce businesses ---')
const orgs = await q(`organisations?name=ilike.*chicce*&select=id,name`)
console.log(`  orgs: ${JSON.stringify(orgs)}`)
for (const o of orgs) {
  const bizes = await q(`businesses?org_id=eq.${o.id}&select=id,name`)
  console.log(`  org ${o.name}: ${JSON.stringify(bizes)}`)
}
