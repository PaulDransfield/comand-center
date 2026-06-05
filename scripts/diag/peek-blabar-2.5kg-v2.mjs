import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const { data: prods } = await db.from('products')
  .select('id, name, business_id, pack_size, base_unit, default_supplier_name, default_supplier_fortnox_number, archived_at')
  .ilike('name','%Blåbär%2,5kg%').is('archived_at', null)
console.log(`Blåbär 2,5kg products: ${prods?.length}`)
for (const p of prods ?? []) {
  console.log(`\n${p.id.slice(0,8)} "${p.name}"`)
  console.log(`  pack=${p.pack_size} ${p.base_unit}  sup="${p.default_supplier_name}" fnx=${p.default_supplier_fortnox_number}`)
  const { data: aliases } = await db.from('product_aliases').select('id, raw_description, is_active, match_method, supplier_fortnox_number').eq('product_id', p.id)
  for (const a of aliases ?? []) console.log(`  [active=${a.is_active}] ${a.id.slice(0,8)} "${a.raw_description}" sup=${a.supplier_fortnox_number} m=${a.match_method}`)
}
