// Characterise products in the items list that show "no article / no price /
// 0 observations". Buckets the orphans by likely cause so we can decide on
// the right cleanup.
//
// Buckets:
//   A. recipe_importer    — has at least one recipe_ingredient ref but no aliases at all
//   B. matched_no_lines   — has aliases but no supplier_invoice_lines pointing at them
//   C. lines_no_article   — has lines but none carry article_number
//   D. true_orphan        — no aliases, no lines, no recipe refs (legacy / cleanup)
//   E. dupe_candidate     — name matches an existing PRICED product by Jaccard ≥ 0.5
//
// Plus: for each, attempt a supplier_articles match by official_name.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

function jaccard(a, b) {
  const A = new Set(a.toLowerCase().replace(/[^\wåäöÅÄÖ]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 1))
  const B = new Set(b.toLowerCase().replace(/[^\wåäöÅÄÖ]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 1))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0; for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

for (const biz of BUSINESSES) {
  console.log(`\n=== ${biz.name} (${biz.id.slice(0,8)}) ===`)

  // Pull all active products
  const products = []
  let from = 0
  while (true) {
    const { data } = await db.from('products')
      .select('id, name, category, invoice_unit, default_supplier_name')
      .eq('business_id', biz.id)
      .is('archived_at', null)
      .order('id').range(from, from + 999)
    if (!data?.length) break
    products.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  console.log(`  ${products.length} active products`)

  // For each, count aliases + lines + recipe refs (in chunks)
  const pIds = products.map(p => p.id)
  const aliasCount = new Map()
  const lineCount  = new Map()
  const lineWithArtCount = new Map()
  const recipeRefCount = new Map()

  for (let i = 0; i < pIds.length; i += 200) {
    const slice = pIds.slice(i, i + 200)
    const { data: aliases } = await db.from('product_aliases').select('id, product_id').in('product_id', slice).eq('is_active', true)
    for (const a of aliases ?? []) aliasCount.set(a.product_id, (aliasCount.get(a.product_id) ?? 0) + 1)
    const aliasIds = (aliases ?? []).map(a => a.id)
    const aToP = new Map((aliases ?? []).map(a => [a.id, a.product_id]))
    if (aliasIds.length > 0) {
      for (let j = 0; j < aliasIds.length; j += 200) {
        const aSlice = aliasIds.slice(j, j + 200)
        const { data: lines } = await db.from('supplier_invoice_lines')
          .select('product_alias_id, article_number')
          .in('product_alias_id', aSlice)
        for (const l of lines ?? []) {
          const pid = aToP.get(l.product_alias_id); if (!pid) continue
          lineCount.set(pid, (lineCount.get(pid) ?? 0) + 1)
          if (l.article_number) lineWithArtCount.set(pid, (lineWithArtCount.get(pid) ?? 0) + 1)
        }
      }
    }
    const { data: recIngs } = await db.from('recipe_ingredients').select('product_id').in('product_id', slice)
    for (const r of recIngs ?? []) recipeRefCount.set(r.product_id, (recipeRefCount.get(r.product_id) ?? 0) + 1)
  }

  // Bucket
  const buckets = { A: [], B: [], C: [], D: [], E: [] }
  const priced = products.filter(p => (lineWithArtCount.get(p.id) ?? 0) > 0)
  for (const p of products) {
    const aliases = aliasCount.get(p.id) ?? 0
    const lines = lineCount.get(p.id) ?? 0
    const linesArt = lineWithArtCount.get(p.id) ?? 0
    const recipeRefs = recipeRefCount.get(p.id) ?? 0
    if (linesArt > 0) continue   // has a real article, fine
    // No article — categorise
    if (aliases === 0 && lines === 0 && recipeRefs > 0) {
      buckets.A.push({ p, aliases, lines, recipeRefs })
    } else if (aliases > 0 && lines === 0) {
      buckets.B.push({ p, aliases, lines, recipeRefs })
    } else if (aliases > 0 && lines > 0 && linesArt === 0) {
      buckets.C.push({ p, aliases, lines, recipeRefs })
    } else if (aliases === 0 && lines === 0 && recipeRefs === 0) {
      buckets.D.push({ p, aliases, lines, recipeRefs })
    } else {
      // dupe candidate? Search priced products for a similar name
      const top = priced.map(q => ({ q, sim: jaccard(p.name, q.name) }))
        .filter(x => x.sim >= 0.5)
        .sort((a, b) => b.sim - a.sim)[0]
      if (top) buckets.E.push({ p, ...top, aliases, lines, recipeRefs })
      else buckets.D.push({ p, aliases, lines, recipeRefs })
    }
  }
  // Re-categorise D candidates as E if they have a dupe match
  buckets.D = buckets.D.filter(d => {
    const top = priced.map(q => ({ q, sim: jaccard(d.p.name, q.name) }))
      .filter(x => x.sim >= 0.5)
      .sort((a, b) => b.sim - a.sim)[0]
    if (top) { buckets.E.push({ p: d.p, ...top, aliases: d.aliases, lines: d.lines, recipeRefs: d.recipeRefs }); return false }
    return true
  })

  console.log(`  Bucket A (recipe-importer, no aliases): ${buckets.A.length}`)
  console.log(`  Bucket B (aliases but no lines):        ${buckets.B.length}`)
  console.log(`  Bucket C (lines but no article):        ${buckets.C.length}`)
  console.log(`  Bucket D (true orphan):                 ${buckets.D.length}`)
  console.log(`  Bucket E (dupe candidate, ≥0.5 Jaccard): ${buckets.E.length}`)
  console.log(`  Total no-article: ${buckets.A.length+buckets.B.length+buckets.C.length+buckets.D.length+buckets.E.length}`)

  // Show first 5 of each
  for (const [b, list] of Object.entries(buckets)) {
    if (list.length === 0) continue
    console.log(`\n  --- Bucket ${b} (showing first 5 of ${list.length}) ---`)
    for (const item of list.slice(0, 5)) {
      const p = item.p
      console.log(`    "${p.name}" sup="${p.default_supplier_name ?? '∅'}" cat=${p.category}`)
      console.log(`      aliases=${item.aliases} lines=${item.lines} recipeRefs=${item.recipeRefs}`)
      if (item.q) console.log(`      DUPE? "${item.q.name}" sim=${item.sim.toFixed(2)}`)
    }
  }
}
