import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

for (const id of ['791a12fa','bf720f6a','2e23fd90','f6023897']) {
  const { data } = await db.from('products')
    .select('id, name, business_id, pack_size, base_unit, default_supplier_name, default_supplier_fortnox_number')
    .ilike('id', id+'%')
  for (const p of data ?? []) {
    console.log(`${p.id.slice(0,8)} "${p.name}"`)
    console.log(`  pack=${p.pack_size} ${p.base_unit}  supplier="${p.default_supplier_name}" fnx=${p.default_supplier_fortnox_number}`)
  }
}
