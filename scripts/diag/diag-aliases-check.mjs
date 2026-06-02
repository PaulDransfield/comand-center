// Verify product_aliases data — counts only.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

for (const biz of [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]) {
  const { count: prodCount } = await db
    .from('products')
    .select('*', { count: 'exact', head: true })
    .eq('business_id', biz.id)
    .is('archived_at', null)
  const { count: aliasCount } = await db
    .from('product_aliases')
    .select('*', { count: 'exact', head: true })
    .eq('business_id', biz.id)
    .eq('is_active', true)
  // Distinct product_id in aliases
  const { data: distinctProds } = await db
    .from('product_aliases')
    .select('product_id')
    .eq('business_id', biz.id)
    .eq('is_active', true)
    .limit(20000)
  const productsWithAliases = new Set((distinctProds ?? []).map(a => a.product_id))
  console.log(`${biz.name}: products=${prodCount}, active aliases=${aliasCount}, products with ≥1 active alias=${productsWithAliases.size}`)
}
