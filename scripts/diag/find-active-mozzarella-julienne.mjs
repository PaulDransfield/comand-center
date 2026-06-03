import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const BIZ = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// All active Mozzarella products at Chicce
const { data: prods } = await db.from('products')
  .select('id, name, pack_size, base_unit, archived_at')
  .eq('business_id', BIZ)
  .is('archived_at', null)
  .ilike('name', '%Mozzarella%')
console.log(`Active Mozzarella products at Chicce: ${prods?.length}`)
for (const p of prods ?? []) console.log(`  ${p.id}  "${p.name}"  pack=${p.pack_size} ${p.base_unit}`)

// Per-name search to find any "julienne" survivor
const { data: julienne } = await db.from('products')
  .select('id, name, pack_size, base_unit, archived_at')
  .eq('business_id', BIZ)
  .is('archived_at', null)
  .ilike('name', '%julienne%')
console.log(`\nAny active "julienne" products: ${julienne?.length}`)
for (const p of julienne ?? []) console.log(`  ${p.id}  "${p.name}"  pack=${p.pack_size} ${p.base_unit}`)
