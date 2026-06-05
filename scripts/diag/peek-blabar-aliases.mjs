import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const { data: prods } = await db.from('products').select('id, name').ilike('name','%Blåbär%2,5%').is('archived_at', null)
for (const p of prods ?? []) {
  const { data: aliases } = await db.from('product_aliases').select('id, raw_description, is_active, match_method').eq('product_id', p.id).eq('is_active', true)
  console.log(`${p.id.slice(0,8)} "${p.name}"  aliases=${aliases?.length}`)
  for (const a of aliases ?? []) console.log(`  ${a.id.slice(0,8)}  "${a.raw_description}"  m=${a.match_method}`)
}
