import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Find ALL active Mozzarella products at Chicce (business 63ada0ac-18af-406a-8ad3-4acfd0379f2c)
const { data: prods } = await db.from('products')
  .select('id, name, pack_size, base_unit, archived_at, dedupe_canonical_id')
  .eq('business_id', '63ada0ac-18af-406a-8ad3-4acfd0379f2c')
  .ilike('name', '%Mozzarella%julienne%')
  .order('archived_at', { ascending: true, nullsFirst: true })
for (const p of prods ?? []) {
  console.log(`  ${p.id}  "${p.name}"  pack=${p.pack_size} ${p.base_unit}  archived=${p.archived_at}  canonical=${p.dedupe_canonical_id ?? ''}`)
}

// Find lines pointing at dangling aliases — match_status='matched' but no alias row exists
const { data: lines } = await db.from('supplier_invoice_lines')
  .select('id, business_id, fortnox_invoice_number, invoice_date, raw_description, product_alias_id, match_status')
  .ilike('raw_description', '%Mozzarella per pizza Julienne%')
  .order('invoice_date', { ascending: false })
const aliasIds = [...new Set((lines ?? []).map(l => l.product_alias_id).filter(Boolean))]
const { data: aliveAliases } = await db.from('product_aliases').select('id, product_id, is_active, normalized_description, supplier_name_snapshot').in('id', aliasIds)
console.log('\nAlive alias details:')
for (const a of aliveAliases ?? []) {
  const { data: p } = await db.from('products').select('id, name, archived_at, pack_size, base_unit').eq('id', a.product_id ?? '00000000-0000-0000-0000-000000000000').maybeSingle()
  console.log(`  ${a.id}  → product ${a.product_id}  is_active=${a.is_active}`)
  console.log(`     "${p?.name ?? '(no product)'}"  archived=${p?.archived_at}  pack=${p?.pack_size} ${p?.base_unit}`)
}
const aliveSet = new Set((aliveAliases ?? []).map(a => a.id))
console.log(`\nLines: ${lines?.length}  unique alias ids referenced: ${aliasIds.length}  alive: ${aliveSet.size}`)
for (const l of lines ?? []) {
  const dangling = l.product_alias_id && !aliveSet.has(l.product_alias_id)
  console.log(`  ${l.invoice_date} inv=${l.fortnox_invoice_number} alias=${l.product_alias_id?.slice(0,8)}${dangling ? ' DANGLING' : ''} status=${l.match_status}  "${l.raw_description?.slice(0,55)}"`)
}
