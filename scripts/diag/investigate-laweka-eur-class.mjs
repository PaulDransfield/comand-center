// Map the scope of Laweka EUR-tagged-as-SEK lines.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// All Laweka lines with non-zero qty, ppu, total
const lawekaLines = []
let from = 0
while (true) {
  const { data } = await db.from('supplier_invoice_lines')
    .select('id, business_id, fortnox_invoice_number, invoice_date, quantity, price_per_unit, total_excl_vat, currency, supplier_name_snapshot')
    .ilike('supplier_name_snapshot', '%laweka%')
    .order('invoice_date', { ascending: false })
    .range(from, from + 999)
  if (!data?.length) break
  lawekaLines.push(...data)
  if (data.length < 1000) break
  from += 1000
}
console.log(`Total Laweka lines: ${lawekaLines.length}`)

// Compute the ratio per line and bucket
const buckets = { consistent: 0, eur_ratio: 0, other: 0, zero_qty_or_ppu: 0 }
const invoiceRatios = new Map()
for (const l of lawekaLines) {
  const q = Number(l.quantity ?? 0)
  const p = Number(l.price_per_unit ?? 0)
  const t = Number(l.total_excl_vat ?? 0)
  if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(p) || p <= 0 || !Number.isFinite(t) || t === 0) {
    buckets.zero_qty_or_ppu++; continue
  }
  const computed = q * p
  const ratio = t / computed
  if (Math.abs(ratio - 1) < 0.05) buckets.consistent++
  else if (ratio > 10.5 && ratio < 12.5) buckets.eur_ratio++
  else buckets.other++

  const arr = invoiceRatios.get(`${l.business_id}|${l.fortnox_invoice_number}`) ?? []
  arr.push({ ratio, date: l.invoice_date })
  invoiceRatios.set(`${l.business_id}|${l.fortnox_invoice_number}`, arr)
}
console.log('\nLine-level distribution:')
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k}: ${v}`)

// Per-invoice median ratio
const invoiceBuckets = { consistent: 0, eur_only: 0, mixed: 0, sparse: 0 }
for (const [k, ratios] of invoiceRatios) {
  if (ratios.length < 2) { invoiceBuckets.sparse++; continue }
  const eurish = ratios.filter(r => r.ratio > 10.5 && r.ratio < 12.5).length
  const consistent = ratios.filter(r => Math.abs(r.ratio - 1) < 0.05).length
  if (eurish === ratios.length) invoiceBuckets.eur_only++
  else if (consistent === ratios.length) invoiceBuckets.consistent++
  else invoiceBuckets.mixed++
}
console.log('\nInvoice-level distribution:')
for (const [k, v] of Object.entries(invoiceBuckets)) console.log(`  ${k}: ${v}`)

// Distinct businesses affected
const bizes = new Set(lawekaLines.map(l => l.business_id))
console.log(`\nDistinct businesses with Laweka invoices: ${bizes.size}`)
