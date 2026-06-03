import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
for (const id of ['00b80bd8-1ea3-474b-abe2-72ddb775870f', 'f82dcde6-5544-41f1-a79b-320a7e91d4d9']) {
  const { data, error } = await db.from('product_aliases').select('id, product_id, business_id, is_active, supplier_name_snapshot').eq('id', id)
  console.log(`${id}: error=${error?.message}  rows=${data?.length}`)
  for (const r of data ?? []) console.log(`  → product=${r.product_id} biz=${r.business_id} active=${r.is_active} sup="${r.supplier_name_snapshot}"`)
}
