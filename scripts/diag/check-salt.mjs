import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local', 'utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

// Find Salt products at Vero
const { data: salts } = await db.from('products').select('id, name, pack_size, base_unit, archived_at, default_supplier_name').eq('business_id', VERO).ilike('name', '%salt%')
console.log(`Found ${salts?.length ?? 0} Salt-named products at Vero:\n`)
for (const p of salts ?? []) {
  console.log(`${p.id} | "${p.name}"`)
  console.log(`  pack=${p.pack_size} ${p.base_unit} | archived=${p.archived_at ? 'Y' : 'N'} | supplier=${p.default_supplier_name}`)
  const { data: as } = await db.from('product_aliases').select('id, raw_description, supplier_name_snapshot, is_active').eq('product_id', p.id)
  console.log(`  aliases: ${as?.length ?? 0}`)
  for (const a of as ?? []) console.log(`    - ${a.id.slice(0,8)} "${a.raw_description}" @ ${a.supplier_name_snapshot} active=${a.is_active}`)
  const { data: ris } = await db.from('recipe_ingredients').select('id, quantity, unit, recipe_id').eq('product_id', p.id)
  console.log(`  recipe_ingredients: ${ris?.length ?? 0}`)
  if (ris?.length) {
    const recIds = [...new Set(ris.map(r => r.recipe_id))]
    const { data: rs } = await db.from('recipes').select('id, name').in('id', recIds)
    for (const r of ris ?? []) console.log(`    in recipe "${rs?.find(x => x.id === r.recipe_id)?.name ?? '?'}" qty=${r.quantity} ${r.unit}`)
  }
  // Latest line via aliases
  const aliasIds = (as ?? []).map(a => a.id)
  if (aliasIds.length) {
    const { count: lineCount } = await db.from('supplier_invoice_lines').select('id', { count: 'exact', head: true }).eq('business_id', VERO).eq('match_status', 'matched').in('product_alias_id', aliasIds)
    console.log(`  matched lines: ${lineCount ?? 0}`)
  }
  console.log()
}
