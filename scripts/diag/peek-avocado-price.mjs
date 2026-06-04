// Avocado Hass shows 9 kr/St on the article page but 0 kr on a recipe
// row using 1 st. Likely pack_size mismatch: name says "24st" → resolver
// set pack_size=24, so cost_per_base_unit becomes 9/24 = 0.375 → rounds
// to 0 on display.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const { data: prods } = await db.from('products').select('id, name, business_id, invoice_unit, pack_size, base_unit, pack_source, archived_at').ilike('name','%avocado hass%').is('archived_at', null)
for (const p of prods ?? []) {
  console.log(`\n── ${p.id.slice(0,8)} "${p.name}"  biz=${p.business_id.slice(0,8)}`)
  console.log(`   pack_size=${p.pack_size} base_unit=${p.base_unit} invoice_unit=${p.invoice_unit} pack_source=${p.pack_source}`)

  const { data: aliases } = await db.from('product_aliases').select('id').eq('product_id', p.id).eq('is_active', true)
  const aliasIds = (aliases ?? []).map(a => a.id)
  if (aliasIds.length === 0) { console.log('   no active aliases'); continue }

  const { data: lines } = await db.from('supplier_invoice_lines')
    .select('description, quantity, invoice_unit, unit_price, line_total_excl_vat, line_total_excl_vat_sek, currency, invoice_date')
    .in('product_alias_id', aliasIds).eq('match_status', 'matched')
    .order('invoice_date', { ascending: false }).limit(5)
  console.log(`   latest 5 lines:`)
  for (const l of lines ?? []) {
    console.log(`     ${l.invoice_date} qty=${l.quantity} unit=${l.invoice_unit} ppu=${l.unit_price} total_excl=${l.line_total_excl_vat} sek=${l.line_total_excl_vat_sek} cur=${l.currency}`)
    console.log(`        "${l.description?.slice(0,60)}"`)
  }
}
