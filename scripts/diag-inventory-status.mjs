import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// 1. Path B extraction job state
const { data: extByStatus } = await db
  .from('invoice_pdf_extractions')
  .select('status', { count: 'exact' })
  .eq('business_id', bizId)
const counts = {}
for (const r of extByStatus ?? []) counts[r.status] = (counts[r.status] ?? 0) + 1
console.log('invoice_pdf_extractions by status:')
for (const [s, c] of Object.entries(counts).sort()) console.log(`  ${s}: ${c}`)
console.log(`  TOTAL: ${(extByStatus ?? []).length}`)

// 2. Phase A backfill state
const { data: bfState } = await db
  .from('inventory_backfill_state')
  .select('*')
  .eq('business_id', bizId)
  .order('created_at', { ascending: false })
  .limit(3)
console.log(`\ninventory_backfill_state: ${bfState?.length ?? 0} rows`)
for (const s of bfState ?? []) {
  console.log(`  phase=${s.phase}  status=${s.status}  attempted=${s.attempted}  succeeded=${s.succeeded}  failed=${s.failed}  needs_review=${s.needs_review}  updated=${s.updated_at}`)
}

// 3. supplier_invoice_lines aggregate
const { count: linesTotal } = await db
  .from('supplier_invoice_lines')
  .select('*', { count: 'exact', head: true })
  .eq('business_id', bizId)
console.log(`\nsupplier_invoice_lines total: ${linesTotal}`)

const { data: linesBySource } = await db
  .from('supplier_invoice_lines')
  .select('source')
  .eq('business_id', bizId)
  .range(0, 9999)
const sourceCounts = {}
for (const r of linesBySource ?? []) sourceCounts[r.source ?? 'null'] = (sourceCounts[r.source ?? 'null'] ?? 0) + 1
console.log('  by source:')
for (const [s, c] of Object.entries(sourceCounts).sort()) console.log(`    ${s}: ${c}`)

// 4. products + aliases count
const { count: productsCount } = await db.from('products').select('*', { count: 'exact', head: true }).eq('business_id', bizId)
const { count: aliasesCount }  = await db.from('product_aliases').select('*', { count: 'exact', head: true }).eq('business_id', bizId)
console.log(`\nproducts (Chicce): ${productsCount}`)
console.log(`product_aliases:    ${aliasesCount}`)

// 5. Latest extractions (just to see what's happening)
const { data: recent } = await db
  .from('invoice_pdf_extractions')
  .select('fortnox_invoice_number, status, rows_extracted, total_delta_pct, error_message, completed_at, ai_model, cost_usd')
  .eq('business_id', bizId)
  .order('completed_at', { ascending: false, nullsFirst: false })
  .limit(8)
console.log(`\nMost recent extractions:`)
for (const e of recent ?? []) {
  console.log(`  #${e.fortnox_invoice_number}  status=${e.status}  rows=${e.rows_extracted ?? '—'}  delta=${e.total_delta_pct ?? '—'}  cost=$${e.cost_usd ?? '—'}  model=${e.ai_model ?? '—'}  done=${e.completed_at ?? '—'}  err=${(e.error_message ?? '').slice(0, 80)}`)
}
