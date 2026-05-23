import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Catalogue counts
const { count: products } = await db.from('products').select('*', { count: 'exact', head: true }).eq('business_id', bizId)
const { count: aliases }  = await db.from('product_aliases').select('*', { count: 'exact', head: true }).eq('business_id', bizId)
const { count: linesTotal } = await db.from('supplier_invoice_lines').select('*', { count: 'exact', head: true }).eq('business_id', bizId)
const { count: linesMatched } = await db.from('supplier_invoice_lines').select('*', { count: 'exact', head: true }).eq('business_id', bizId).eq('match_status', 'matched')
const { count: linesNeedsReview } = await db.from('supplier_invoice_lines').select('*', { count: 'exact', head: true }).eq('business_id', bizId).eq('match_status', 'needs_review')

console.log('Catalogue:')
console.log(`  products:        ${products}`)
console.log(`  aliases:         ${aliases}`)
console.log(`  supplier lines:  ${linesTotal}`)
console.log(`    matched:         ${linesMatched}`)
console.log(`    needs review:    ${linesNeedsReview}`)

// Recent extraction completions (last 10)
const { data: recent } = await db.from('invoice_pdf_extractions')
  .select('fortnox_invoice_number, supplier_name_snapshot, status, rows_extracted, total_extracted, cost_usd, completed_at')
  .eq('business_id', bizId)
  .eq('status', 'extracted')
  .order('completed_at', { ascending: false })
  .limit(5)
console.log('\nLatest 5 successful extractions:')
for (const r of recent ?? []) {
  console.log(`  ${r.completed_at?.slice(11,19)} #${r.fortnox_invoice_number} ${(r.supplier_name_snapshot ?? '?').slice(0,25).padEnd(27)} rows=${r.rows_extracted} total=${Number(r.total_extracted).toFixed(0)} kr cost=$${Number(r.cost_usd).toFixed(3)}`)
}

// Cost totals
const { data: allCost } = await db.from('invoice_pdf_extractions')
  .select('cost_usd, tokens_input, tokens_output')
  .eq('business_id', bizId)
  .not('cost_usd', 'is', null)
  .range(0, 9999)
const totalCost = (allCost ?? []).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0)
const totalInTok = (allCost ?? []).reduce((s, r) => s + Number(r.tokens_input ?? 0), 0)
const totalOutTok = (allCost ?? []).reduce((s, r) => s + Number(r.tokens_output ?? 0), 0)
console.log(`\nAI cost so far: $${totalCost.toFixed(2)} USD`)
console.log(`  input tokens:  ${totalInTok.toLocaleString('en-GB')}`)
console.log(`  output tokens: ${totalOutTok.toLocaleString('en-GB')}`)
console.log(`Projected total for 785 invoices: $${(totalCost * 785 / Math.max(1, (allCost ?? []).length)).toFixed(2)} USD`)
