// List every product currently flagged pack_source='supplier_official'.
// After running branch=1 apply, this is the canonical list of what got changed.
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
  const { data } = await db.from('products')
    .select('id, name, pack_size, base_unit, invoice_unit')
    .eq('business_id', biz.id)
    .eq('pack_source', 'supplier_official')
    .is('archived_at', null)
    .order('name')
  console.log(`\n=== ${biz.name}: ${data?.length ?? 0} supplier_official products ===`)
  for (const p of data ?? []) {
    console.log(`  ${p.pack_size} ${p.base_unit}  · invoice_unit=${p.invoice_unit ?? '∅'}  · ${p.name}`)
  }
}
