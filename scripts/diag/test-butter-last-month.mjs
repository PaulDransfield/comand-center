// Test: "how much butter did I buy last month" → top_products_by_supplier
// with product_filter="smör" and date range = May 2026.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
    const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')]
  })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const businessId = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'  // Vero
const productFilter = 'smör'
const dateFrom = '2026-04-01'
const dateTo   = '2026-04-30'

const { data: lines } = await db.from('supplier_invoice_lines')
  .select('product_alias_id, raw_description, supplier_name_snapshot, quantity, unit, total_excl_vat, price_per_unit, invoice_date, fortnox_invoice_number')
  .eq('business_id', businessId).not('product_alias_id', 'is', null)
  .gte('invoice_date', dateFrom).lte('invoice_date', dateTo).range(0, 49_999)

const aliasIds = Array.from(new Set(lines.map(l => l.product_alias_id).filter(Boolean)))
const aliasToProduct = new Map()
for (let i = 0; i < aliasIds.length; i += 100) {
  const { data } = await db.from('product_aliases').select('id, product_id').in('id', aliasIds.slice(i, i+100))
  for (const a of data ?? []) aliasToProduct.set(a.id, a.product_id)
}
const productIds = Array.from(new Set(aliasToProduct.values()))
const productById = new Map()
for (let i = 0; i < productIds.length; i += 100) {
  const { data } = await db.from('products').select('id, name, category, default_supplier_name').in('id', productIds.slice(i, i+100))
  for (const p of data ?? []) productById.set(p.id, p)
}

const agg = new Map()
for (const l of lines) {
  const pid = aliasToProduct.get(l.product_alias_id); if (!pid) continue
  const prod = productById.get(pid); if (!prod) continue
  const matches = (prod.name?.toLowerCase().includes(productFilter)) || (l.raw_description?.toLowerCase().includes(productFilter))
  let row = agg.get(pid)
  if (!row) row = agg.set(pid, { name: prod.name, supplier: prod.default_supplier_name, spend: 0, qty: 0, lines: 0, matched: false }).get(pid)
  if (matches) row.matched = true
  row.spend += Number(l.total_excl_vat ?? 0)
  row.qty   += Number(l.quantity ?? 0)
  row.lines += 1
}

const matched = Array.from(agg.values()).filter(r => r.matched).sort((a, b) => b.spend - a.spend)
console.log(`\nButter (smör) purchases @ Vero in May 2026:\n`)
console.log(`Distinct products matched: ${matched.length}`)
let totalSpend = 0, totalQty = 0, totalLines = 0
for (const m of matched) {
  console.log(`  · ${m.name.padEnd(50)} | SEK ${Math.round(m.spend).toString().padStart(7)} | ${m.qty.toFixed(2).padStart(7)} units | ${m.lines.toString().padStart(2)} lines | ${m.supplier ?? '?'}`)
  totalSpend += m.spend; totalQty += m.qty; totalLines += m.lines
}
console.log(`\n  TOTAL: SEK ${Math.round(totalSpend).toLocaleString('sv-SE')} | ${totalQty.toFixed(2)} units | ${totalLines} lines`)
