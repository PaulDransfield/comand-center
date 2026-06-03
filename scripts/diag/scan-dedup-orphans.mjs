// READ-ONLY scan: find aliases that point at ARCHIVED products,
// segmented by when the product was archived. If today's dedup
// (2026-06-03) left orphans, they'll surface here. Each orphan means
// invoice lines that won't price correctly.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Pull all active aliases (in batches), then check their product is active
let from = 0
const orphans = []
while (true) {
  const { data } = await db.from('product_aliases')
    .select('id, product_id, business_id, supplier_name_snapshot, raw_description, is_active')
    .eq('is_active', true)
    .order('id').range(from, from + 999)
  if (!data?.length) break
  // Batch-check product archived status
  const pids = [...new Set(data.map(a => a.product_id).filter(Boolean))]
  for (let i = 0; i < pids.length; i += 100) {
    const slice = pids.slice(i, i + 100)
    const { data: ps } = await db.from('products')
      .select('id, name, archived_at, business_id')
      .in('id', slice)
    const archivedById = new Map((ps ?? []).filter(p => p.archived_at).map(p => [p.id, p]))
    for (const a of data) {
      const ap = archivedById.get(a.product_id)
      if (ap) orphans.push({ alias: a, prod: ap })
    }
  }
  if (data.length < 1000) break
  from += 1000
}

console.log(`Active aliases pointing at archived products: ${orphans.length}`)
const byDate = new Map()
for (const o of orphans) {
  const day = String(o.prod.archived_at).slice(0, 10)
  byDate.set(day, (byDate.get(day) ?? 0) + 1)
}
console.log('\nBy archived date:')
for (const [day, n] of [...byDate.entries()].sort()) console.log(`  ${day}: ${n}`)

console.log('\nSample (first 10):')
for (const o of orphans.slice(0, 10)) {
  console.log(`  alias ${o.alias.id.slice(0,8)}  supplier="${o.alias.supplier_name_snapshot}"  raw="${o.alias.raw_description?.slice(0,40)}"`)
  console.log(`    → archived product "${o.prod.name}"  (${o.prod.archived_at})`)
}

// Cross-section: lines affected
const orphanAliasIds = orphans.map(o => o.alias.id)
let affectedLines = 0
for (let i = 0; i < orphanAliasIds.length; i += 100) {
  const slice = orphanAliasIds.slice(i, i + 100)
  const { count } = await db.from('supplier_invoice_lines')
    .select('*', { count: 'exact', head: true })
    .in('product_alias_id', slice)
    .eq('match_status', 'matched')
  affectedLines += count ?? 0
}
console.log(`\nMatched invoice lines feeding archived products: ${affectedLines}`)
