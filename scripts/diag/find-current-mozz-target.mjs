import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

for (const aliasId of ['00b80bd8-1ea3-474b-abe2-72ddb775870f', 'f82dcde6-5544-41f1-a79b-320a7e91d4d9']) {
  const { data: a } = await db.from('product_aliases').select('id, product_id, is_active, normalized_description, supplier_name_snapshot, match_method').eq('id', aliasId).maybeSingle()
  if (!a) { console.log(`alias ${aliasId}: NOT FOUND`); continue }
  console.log(`alias ${a.id}  is_active=${a.is_active}  method=${a.match_method}  norm="${a.normalized_description}"  supplier="${a.supplier_name_snapshot}"`)
  if (a.product_id) {
    const { data: p } = await db.from('products').select('id, name, pack_size, base_unit, archived_at').eq('id', a.product_id).maybeSingle()
    console.log(`  → product ${p?.id}  "${p?.name}"  pack=${p?.pack_size} ${p?.base_unit}  archived=${p?.archived_at}`)
  } else {
    console.log(`  → product_id is NULL (unmatched)`)
  }
  console.log()
}
