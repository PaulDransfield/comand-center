import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Check the cached recent-invoices payload
const { data: cache } = await db
  .from('overhead_drilldown_cache')
  .select('category, fetched_at, payload')
  .eq('business_id', bizId)
  .like('category', '__recent_invoices%')
  .order('fetched_at', { ascending: false })
console.log(`Cached recent_invoices payloads: ${cache?.length ?? 0}`)
for (const r of cache ?? []) {
  const p = r.payload
  console.log(`  ${r.category}  fetched=${r.fetched_at}  invoice_count=${p?.invoices?.length ?? 0}`)
  if (p?.invoices?.length > 0) {
    for (const inv of p.invoices.slice(0, 3)) {
      console.log(`    ${inv.invoice_date}  ${inv.supplier_name}  ${inv.total} ${inv.currency}`)
    }
  }
}

// Check the local invoices table
const { data: localInv, count: localCount } = await db
  .from('invoices')
  .select('*', { count: 'exact' })
  .eq('business_id', bizId)
  .limit(5)
console.log(`\nLocal invoices table: ${localCount} rows`)
for (const i of localInv ?? []) {
  console.log(`  ${i.invoice_date}  ${i.vendor}  ${i.amount}`)
}

// What's the most recent voucher_cache supplier-invoice activity we can detect?
// Look at vouchers with account 2440 (Leverantörsskulder)
const { data: vouchers } = await db
  .from('fortnox_vouchers_cache')
  .select('transaction_date, voucher_series, voucher_number, description, rows')
  .eq('business_id', bizId)
  .gte('transaction_date', '2026-04-01')
  .order('transaction_date', { ascending: false })
  .limit(20)
console.log(`\nMost recent vouchers (any kind, Apr 2026+):`)
let supplierVouchers = 0
for (const v of vouchers ?? []) {
  const has2440 = (v.rows ?? []).some(r => Number(r.Account) === 2440)
  if (has2440) {
    supplierVouchers++
    if (supplierVouchers <= 5) {
      console.log(`  ${v.transaction_date}  ${v.voucher_series}/${v.voucher_number}  ${(v.description ?? '').slice(0, 60)}`)
    }
  }
}
console.log(`Total vouchers touching 2440 in window: ${supplierVouchers}`)
