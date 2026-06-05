import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

for (const term of ['BLÅBÄR%2,5KG%Nyckelhål', 'Cuvee Negociants%Bib%']) {
  const { data: prods } = await db.from('products')
    .select('id, name, business_id, default_supplier_name, default_supplier_fortnox_number, price_override, archived_at')
    .ilike('name', term).is('archived_at', null)
  for (const p of prods ?? []) {
    console.log(`\n── ${p.id.slice(0,8)} "${p.name}"`)
    console.log(`   biz=${p.business_id.slice(0,8)} default_supplier="${p.default_supplier_name}" fnx=${p.default_supplier_fortnox_number} price_override=${p.price_override}`)
    const { data: aliases } = await db.from('product_aliases')
      .select('id, raw_description, is_active, supplier_name_snapshot, match_method, deactivated_reason')
      .eq('product_id', p.id)
    console.log(`   aliases: ${aliases?.length}`)
    for (const a of aliases ?? []) console.log(`     [active=${a.is_active}] ${a.id.slice(0,8)}  "${a.raw_description}"  sup="${a.supplier_name_snapshot}"  method=${a.match_method}  deact=${a.deactivated_reason}`)
  }
}
