import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local', 'utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const names = ['Crema al formaggio Pecorino', 'Panko ströbröd', 'Grapefrukt Röd 40st']
for (const n of names) {
  console.log(`\n══ ${n} ══`)
  const { data: prods } = await db.from('products').select('id, name, pack_size, base_unit, price_override, archived_at').ilike('name', `%${n.split(' ')[0]}%`).eq('business_id', '63ada0ac-18af-406a-8ad3-4acfd0379f2c').limit(10)
  for (const p of prods ?? []) {
    if (!p.name.toLowerCase().includes(n.split(' ')[0].toLowerCase())) continue
    const { data: aliases } = await db.from('product_aliases').select('id').eq('product_id', p.id)
    const aliasIds = (aliases ?? []).map(a => a.id)
    let lineCount = 0
    if (aliasIds.length > 0) {
      const { count } = await db.from('supplier_invoice_lines').select('id', { count: 'exact', head: true }).eq('business_id', '63ada0ac-18af-406a-8ad3-4acfd0379f2c').eq('match_status', 'matched').in('product_alias_id', aliasIds)
      lineCount = count ?? 0
    }
    console.log(`  "${p.name}"  archived=${p.archived_at ? 'Y' : 'N'}  override=${p.price_override}  aliases=${aliasIds.length}  matched_lines=${lineCount}`)
  }
}
