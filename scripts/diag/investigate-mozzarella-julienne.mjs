// Find the Mozzarella per pizza Julienne FRYST product + its latest line,
// understand the 91% off (qty × ppu = 421.08 but total = 4655.67) discrepancy.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Find products with this name
const { data: prods } = await db.from('products')
  .select('id, business_id, name, pack_size, base_unit, invoice_unit, pack_source')
  .or('name.ilike.%julienne%,name.ilike.%mozzarella per pizza%')
console.log(`Products: ${prods?.length ?? 0}`)
for (const p of prods ?? []) console.log(`  ${p.business_id.slice(0,8)} ${p.id.slice(0,8)} "${p.name}"  pack=${p.pack_size} ${p.base_unit}  invoice_unit=${p.invoice_unit}  pack_source=${p.pack_source}`)

if (!prods?.length) process.exit(0)

const allProductIds = prods.map(p => p.id)
const { data: aliases } = await db.from('product_aliases').select('id, product_id, supplier_name_snapshot, normalized_description, is_active').in('product_id', allProductIds)
console.log(`\nAliases: ${aliases?.length ?? 0}`)
const aliasIds = (aliases ?? []).map(a => a.id)

const { data: lines } = await db.from('supplier_invoice_lines')
  .select('id, fortnox_invoice_number, invoice_date, raw_description, quantity, unit, price_per_unit, total_excl_vat, currency, product_alias_id, match_status, business_id')
  .in('product_alias_id', aliasIds)
  .order('invoice_date', { ascending: false })
  .limit(20)
console.log(`\nRecent lines: ${lines?.length ?? 0}`)
for (const l of lines ?? []) {
  const computed = (Number(l.quantity) || 0) * (Number(l.price_per_unit) || 0)
  const delta = l.total_excl_vat ? Math.abs(computed - Number(l.total_excl_vat)) / Math.abs(Number(l.total_excl_vat)) : null
  console.log(`  ${l.invoice_date}  inv=${l.fortnox_invoice_number}  qty=${l.quantity} ${l.unit}  ppu=${l.price_per_unit}  total=${l.total_excl_vat}  computed=${computed.toFixed(2)}  delta=${delta != null ? (delta*100).toFixed(1)+'%' : 'n/a'}  "${l.raw_description?.slice(0,60)}"`)
}
