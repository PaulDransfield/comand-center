import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Find both Mozzarella per pizza Julienne products at Chicce
const { data: prods } = await db.from('products')
  .select('id, name, business_id, archived_at, pack_size, base_unit')
  .ilike('name', '%Mozzarella per pizza Julienne%')
for (const p of prods ?? []) console.log(`  product ${p.id}  "${p.name}"  pack=${p.pack_size} ${p.base_unit}  archived=${p.archived_at}`)

// Find all aliases pointing at either
const ids = (prods ?? []).map(p => p.id)
const { data: aliases } = await db.from('product_aliases')
  .select('id, product_id, normalized_description, supplier_name_snapshot, match_method, is_active')
  .in('product_id', ids)
console.log(`\nAliases: ${aliases?.length ?? 0}`)
for (const a of aliases ?? []) {
  console.log(`  alias ${a.id}`)
  console.log(`     → product ${a.product_id}`)
  console.log(`     supplier: ${a.supplier_name_snapshot}`)
  console.log(`     norm:     "${a.normalized_description}"`)
  console.log(`     method:   ${a.match_method}  active=${a.is_active}`)
}

// Find recent lines that look like Mozzarella per pizza Julienne
const { data: lines } = await db.from('supplier_invoice_lines')
  .select('id, business_id, fortnox_invoice_number, invoice_date, raw_description, product_alias_id, match_status, total_excl_vat, quantity, price_per_unit')
  .ilike('raw_description', '%Mozzarella per pizza Julienne%')
  .order('invoice_date', { ascending: false })
  .limit(10)
console.log(`\nRecent lines mentioning the product: ${lines?.length}`)
for (const l of lines ?? []) console.log(`  ${l.invoice_date} inv=${l.fortnox_invoice_number} alias=${l.product_alias_id} status=${l.match_status}  "${l.raw_description?.slice(0,60)}"  qty=${l.quantity}  total=${l.total_excl_vat}  ppu=${l.price_per_unit}`)
