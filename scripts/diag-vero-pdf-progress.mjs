// Read-only: Vero PDF-extraction + catalogue progress (production).
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

for (const line of readFileSync('.env.production.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const biz = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

async function cnt(table, build) {
  const { count, error } = await build(db.from(table).select('*', { count: 'exact', head: true }))
  if (error) return `ERR:${error.message}`
  return count ?? 0
}

console.log('Supabase URL:', process.env.NEXT_PUBLIC_SUPABASE_URL)
console.log('── invoice_pdf_extractions (by status) ──')
for (const s of ['pending', 'extracting', 'extracted', 'needs_review', 'no_pdf', 'failed']) {
  console.log(`  ${s.padEnd(13)} ${await cnt('invoice_pdf_extractions', q => q.eq('business_id', biz).eq('status', s))}`)
}
console.log(`  TOTAL         ${await cnt('invoice_pdf_extractions', q => q.eq('business_id', biz))}`)

console.log('── catalogue ──')
console.log(`  products      ${await cnt('products', q => q.eq('business_id', biz).is('archived_at', null))}`)

console.log('── supplier_invoice_lines (match_status) ──')
for (const s of ['matched', 'needs_review', 'not_inventory']) {
  console.log(`  ${s.padEnd(13)} ${await cnt('supplier_invoice_lines', q => q.eq('business_id', biz).eq('match_status', s))}`)
}
console.log(`  TOTAL         ${await cnt('supplier_invoice_lines', q => q.eq('business_id', biz))}`)

const { data: recent } = await db.from('invoice_pdf_extractions')
  .select('fortnox_invoice_number, supplier_name_snapshot, status, rows_extracted, error_message, completed_at')
  .eq('business_id', biz).order('completed_at', { ascending: false, nullsFirst: false }).limit(6)
console.log('── latest extractions ──')
for (const r of recent ?? []) {
  console.log(`  #${r.fortnox_invoice_number} ${(r.supplier_name_snapshot ?? '?').slice(0,24).padEnd(26)} ${r.status.padEnd(12)} rows=${r.rows_extracted ?? '-'} ${r.error_message ?? ''}`)
}
