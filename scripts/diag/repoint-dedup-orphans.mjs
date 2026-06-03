// Recover dedup-orphan aliases: alias.is_active=true but
// products.archived_at IS NOT NULL for its target.
//
// Why "un-archive", not "repoint"?
//   The dedup author (clean-clusters-dedup.mjs) ran today and archived
//   275 products' targets without migrating their aliases. Name-matching
//   for a canonical is unreliable here — sample dry runs surfaced cases
//   like Nötfärs 23% → 10%, Lök Gul 12kg → 2kg, etc., which the dedup
//   author's OWN system prompt called out as "set verdict='different'".
//   Without the original cluster verdict + canonical pointer, the right
//   conservative move is to un-archive every orphan target so the alias
//   has a valid product again. Owner can re-run dedup with stricter
//   verdicts later. Smallest, fully reversible action.
//
// Default DRY. --apply to write.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const APPLY = process.argv.includes('--apply')

// 1. Build orphan list: active aliases whose target product is archived
const orphans = []
{
  let from = 0
  while (true) {
    const { data } = await db.from('product_aliases')
      .select('id, product_id, business_id')
      .eq('is_active', true)
      .order('id').range(from, from + 999)
    if (!data?.length) break
    const pids = [...new Set(data.map(a => a.product_id).filter(Boolean))]
    const archivedById = new Map()
    for (let i = 0; i < pids.length; i += 100) {
      const slice = pids.slice(i, i + 100)
      const { data: ps } = await db.from('products')
        .select('id, name, archived_at, business_id')
        .in('id', slice)
        .not('archived_at','is',null)
      for (const p of ps ?? []) archivedById.set(p.id, p)
    }
    for (const a of data) {
      const ap = archivedById.get(a.product_id)
      if (ap) orphans.push({ alias: a, archivedProduct: ap })
    }
    if (data.length < 1000) break
    from += 1000
  }
}
console.log(`Orphan aliases: ${orphans.length}`)

// 2. Unique target products
const targetIds = [...new Set(orphans.map(o => o.archivedProduct.id))]
console.log(`Unique archived target products: ${targetIds.length}`)

// 3. Segment by archived_at date for visibility
const byDate = new Map()
const seenTargets = new Set()
for (const o of orphans) {
  if (seenTargets.has(o.archivedProduct.id)) continue
  seenTargets.add(o.archivedProduct.id)
  const day = String(o.archivedProduct.archived_at).slice(0, 10)
  byDate.set(day, (byDate.get(day) ?? 0) + 1)
}
console.log(`\nArchived target by day:`)
for (const [day, n] of [...byDate.entries()].sort()) console.log(`  ${day}: ${n}`)

console.log(`\n=== Sample targets to un-archive (first 10) ===`)
for (const id of targetIds.slice(0, 10)) {
  const sample = orphans.find(o => o.archivedProduct.id === id)?.archivedProduct
  console.log(`  ${id.slice(0,8)}  "${sample?.name?.slice(0,50)}"  archived=${String(sample?.archived_at).slice(0,10)}`)
}

if (!APPLY) { console.log(`\n(DRY — re-run with --apply to un-archive ${targetIds.length} targets)`); process.exit(0) }

console.log(`\n=== Un-archiving ${targetIds.length} targets ===`)
let ok = 0, fail = 0
for (let i = 0; i < targetIds.length; i += 100) {
  const slice = targetIds.slice(i, i + 100)
  const { error, count } = await db.from('products')
    .update({ archived_at: null }, { count: 'exact' })
    .in('id', slice)
  if (error) { console.error(`  batch ${i / 100}: ${error.message}`); fail += slice.length; continue }
  ok += count ?? slice.length
}
console.log(`Un-archived: ${ok} / ${targetIds.length}  (failed: ${fail})`)
