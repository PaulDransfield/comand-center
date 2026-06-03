// Search by raw line description to find the actual offending line.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// The user's number: 421.08 vs 4655.67. Ratio = 11.06. Let me search by total_excl_vat.
const TARGET_TOTAL = 4655.67
const { data: lines } = await db.from('supplier_invoice_lines')
  .select('id, business_id, fortnox_invoice_number, invoice_date, raw_description, quantity, unit, price_per_unit, total_excl_vat, currency, product_alias_id, match_status')
  .gte('total_excl_vat', TARGET_TOTAL - 0.5)
  .lte('total_excl_vat', TARGET_TOTAL + 0.5)
  .order('invoice_date', { ascending: false })
  .limit(20)
console.log(`Lines matching total ${TARGET_TOTAL}: ${lines?.length ?? 0}`)
for (const l of lines ?? []) {
  console.log(`  ${l.business_id.slice(0,8)} ${l.invoice_date}  inv=${l.fortnox_invoice_number}  qty=${l.quantity} ${l.unit}  ppu=${l.price_per_unit}  total=${l.total_excl_vat}  alias=${l.product_alias_id?.slice(0,8)}  "${l.raw_description?.slice(0,80)}"`)
}

if (lines?.length) {
  const aliasIds = lines.map(l => l.product_alias_id).filter(Boolean)
  if (aliasIds.length) {
    const { data: as } = await db.from('product_aliases').select('id, product_id, is_active, normalized_description').in('id', aliasIds)
    console.log(`\nAliases:`)
    for (const a of as ?? []) console.log(`  ${a.id.slice(0,8)}  product=${a.product_id?.slice(0,8)}  active=${a.is_active}  norm="${a.normalized_description}"`)
    const productIds = (as ?? []).map(a => a.product_id).filter(Boolean)
    if (productIds.length) {
      const { data: ps } = await db.from('products').select('id, name, pack_size, base_unit, invoice_unit, archived_at').in('id', productIds)
      console.log(`\nProducts:`)
      for (const p of ps ?? []) console.log(`  ${p.id.slice(0,8)}  "${p.name}"  pack=${p.pack_size} ${p.base_unit}  invoice_unit=${p.invoice_unit}  archived=${p.archived_at}`)
    }
  }
}
