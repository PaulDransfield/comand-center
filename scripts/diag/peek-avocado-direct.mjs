import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const PROD_ID = 'cc651cce-' // prefix
const { data: prods } = await db.from('products').select('id, name, business_id, pack_size, base_unit, invoice_unit, pack_source').ilike('name', 'Avocado Hass RTE 24st CO')
const p = prods?.[0]
if (!p) { console.log('Product not found'); process.exit(0) }
console.log(`Product ${p.id.slice(0,8)} "${p.name}"`)
console.log(`  pack_size=${p.pack_size} base_unit=${p.base_unit} invoice_unit=${p.invoice_unit} pack_source=${p.pack_source}`)

const { data: aliases } = await db.from('product_aliases').select('id, raw_description, is_active, supplier_name_snapshot, match_method').eq('product_id', p.id)
console.log(`\nAliases: ${aliases?.length}`)
for (const a of aliases ?? []) console.log(`  [${a.is_active}] ${a.id.slice(0,8)} sup="${a.supplier_name_snapshot}" raw="${a.raw_description}"`)

const aliasIds = (aliases ?? []).map(a => a.id)
const { data: lines } = await db.from('supplier_invoice_lines')
  .select('description, quantity, invoice_unit, unit_price, price_per_unit, line_total_excl_vat, line_total_excl_vat_sek, currency, invoice_date, match_status')
  .in('product_alias_id', aliasIds).order('invoice_date', { ascending: false }).limit(5)
console.log(`\nLines via aliases: ${lines?.length}`)
for (const l of lines ?? []) {
  console.log(`  ${l.invoice_date} ${l.match_status}  qty=${l.quantity} unit=${l.invoice_unit} ppu=${l.price_per_unit} unit_p=${l.unit_price} total=${l.line_total_excl_vat} ${l.currency} sek=${l.line_total_excl_vat_sek}`)
  console.log(`    "${l.description?.slice(0,80)}"`)
}
