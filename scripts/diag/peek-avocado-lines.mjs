import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// All supplier_invoice_lines mentioning "avocado hass" and "24st co"
const { data } = await db.from('supplier_invoice_lines')
  .select('id, description, quantity, invoice_unit, unit_price, line_total_excl_vat, line_total_excl_vat_sek, currency, invoice_date, match_status, product_alias_id, business_id')
  .ilike('description', '%avocado hass%')
  .order('invoice_date', { ascending: false }).limit(10)
console.log(`Lines: ${data?.length}`)
for (const l of data ?? []) {
  console.log(`\n${l.invoice_date} ${l.match_status}  alias=${l.product_alias_id?.slice(0,8) ?? '∅'}`)
  console.log(`  "${l.description}"`)
  console.log(`  qty=${l.quantity} unit=${l.invoice_unit} ppu=${l.unit_price} total_excl=${l.line_total_excl_vat} ${l.currency} sek=${l.line_total_excl_vat_sek}`)
}
