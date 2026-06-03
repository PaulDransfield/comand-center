// Trace 346fa1c3 ÄGG LV FRIGÅENDE M 30P — does it have lines with article_number?
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const PID = '346fa1c3'  // partial id from prev diag

const { data: prodsList } = await db.from('products')
  .select('id, name, pack_size, base_unit, pack_source')
  .eq('business_id', '63ada0ac-18af-406a-8ad3-4acfd0379f2c')
  .ilike('name', 'ÄGG LV FRIGÅENDE M 30P')
  .limit(5)
const prods = prodsList?.[0]
console.log('Product:', prods)

if (prods) {
  const { data: aliases } = await db.from('product_aliases')
    .select('id, supplier_fortnox_number, normalised_description, match_method')
    .eq('product_id', prods.id)
    .eq('is_active', true)
  console.log(`Aliases (${aliases?.length ?? 0}):`)
  for (const a of aliases ?? []) console.log(`  ${a.id.slice(0,8)} sup=${a.supplier_fortnox_number} method=${a.match_method} norm="${a.normalised_description?.slice(0,40)}"`)

  if (aliases?.length) {
    const { data: lines } = await db.from('supplier_invoice_lines')
      .select('id, invoice_date, supplier_fortnox_number, article_number, raw_description, unit')
      .in('product_alias_id', aliases.map(a => a.id))
      .order('invoice_date', { ascending: false })
      .limit(10)
    console.log(`\nRecent lines (${lines?.length ?? 0}):`)
    for (const l of lines ?? []) console.log(`  ${l.invoice_date} sup=${l.supplier_fortnox_number} art="${l.article_number ?? '∅'}" "${l.raw_description?.slice(0,40)}"`)
  }
}
