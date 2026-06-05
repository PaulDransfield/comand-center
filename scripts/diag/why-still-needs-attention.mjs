// Why are these 27 Chicce items still in needs-attention after the
// orphan-rescue agent ran? Group by the agent's skip reason and surface
// what the LLM said about each.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const BIZ = '63ada0ac-18af-406a-8ad3-4acfd0379f2c' // Chicce

// 1. Current orphans (no aliases + default_supplier)
const { data: prods } = await db.from('products')
  .select('id, name, default_supplier_fortnox_number, source_recipe_id, pack_size, base_unit')
  .eq('business_id', BIZ).is('archived_at', null).limit(5000)
const productIds = (prods ?? []).map(p => p.id)
const aliasCount = new Map()
for (let i = 0; i < productIds.length; i += 200) {
  const slice = productIds.slice(i, i + 200)
  const { data } = await db.from('product_aliases').select('product_id').in('product_id', slice).eq('is_active', true)
  for (const a of data ?? []) aliasCount.set(a.product_id, (aliasCount.get(a.product_id) ?? 0) + 1)
}
const orphans = (prods ?? []).filter(p =>
  (aliasCount.get(p.id) ?? 0) === 0 &&
  !p.source_recipe_id   // recipe-promoted items don't count after my earlier fix
)
console.log(`Total non-recipe-sourced orphans at Chicce: ${orphans.length}`)
const withSupplier = orphans.filter(o => o.default_supplier_fortnox_number)
const noSupplier   = orphans.filter(o => !o.default_supplier_fortnox_number)
console.log(`  With default_supplier_fortnox_number: ${withSupplier.length}`)
console.log(`  Without (agent skipped):              ${noSupplier.length}`)

// 2. For each orphan WITH supplier, fetch its latest agent log entry
for (const o of withSupplier.slice(0, 27)) {
  const { data: logs } = await db.from('orphan_rescue_log').select('action, canonical_name, verdict, confidence, reasoning').eq('orphan_product_id', o.id).order('created_at', { ascending: false }).limit(1)
  const l = logs?.[0]
  if (l) {
    const tag = l.action === 'skipped_low_confidence' ? `LOW(${l.confidence})` : l.action.replace('skipped_', '').toUpperCase()
    console.log(`  [${tag.padEnd(15)}] "${o.name?.slice(0,40)}" → "${l.canonical_name?.slice(0,35) ?? ''}"`)
    if (l.reasoning) console.log(`      ${l.reasoning?.slice(0, 120)}`)
  } else {
    console.log(`  [NEVER PROCESSED] "${o.name?.slice(0,40)}"  pack=${o.pack_size} ${o.base_unit}`)
  }
}
console.log(`\nNo-supplier orphans (agent skips these — owner must set default_supplier first):`)
for (const o of noSupplier.slice(0, 10)) console.log(`  "${o.name?.slice(0,50)}"  pack=${o.pack_size} ${o.base_unit}`)
