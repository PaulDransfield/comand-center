import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const { data, error } = await db.from('recipes').select('id, name, type, is_subrecipe, menu_price, selling_price_ex_vat, updated_at').ilike('name', '%tiramisu%')
if (error) { console.error(error.message); process.exit(1) }
for (const r of data ?? []) {
  console.log(`${r.id.slice(0,8)}  "${r.name}"`)
  console.log(`    type=${r.type}  is_subrecipe=${r.is_subrecipe}  menu_price=${r.menu_price}  ex_vat=${r.selling_price_ex_vat}  updated=${r.updated_at}`)
}
