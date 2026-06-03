// Find every orphan product (0 invoice lines) where ANOTHER product at the
// same business has aliases pointing to lines whose article_number + name
// would unambiguously identify the same SKU. This is the Antica Osteria
// Rosso class — the user shouldn't have to manually click "Link supplier
// article" when the data is already there.
//
// Detection:
//   - Product P at business B with 0 active aliases (orphan)
//   - Search supplier_invoice_lines at B where the line's normalised
//     description shares Jaccard ≥ 0.5 with P.name AND article_number is set
//   - If matched lines exist + all share the SAME article_number → SKU is
//     unambiguous. The orphan P is a duplicate.
//   - If different article numbers → SKU ambiguous; defer.
//
// We classify each orphan into:
//   A. UNAMBIGUOUS_DUP — clear winner; ready to auto-repoint
//   B. AMBIGUOUS       — multiple article_numbers tied; owner review
//   C. NO_MATCH        — no invoice lines remotely resemble; true orphan
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

function jaccard(a, b) {
  const A = new Set(a.toLowerCase().replace(/[^\wåäöÅÄÖ]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 1))
  const B = new Set(b.toLowerCase().replace(/[^\wåäöÅÄÖ]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 1))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0; for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

for (const biz of [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]) {
  console.log(`\n=== ${biz.name} ===`)

  // 1. Products with 0 active aliases (= orphans)
  const allProducts = []
  let from = 0
  while (true) {
    const { data } = await db.from('products')
      .select('id, name, category, default_supplier_name')
      .eq('business_id', biz.id)
      .is('archived_at', null)
      .order('id').range(from, from + 999)
    if (!data?.length) break
    allProducts.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  const orphans = []
  for (let i = 0; i < allProducts.length; i += 200) {
    const slice = allProducts.slice(i, i + 200)
    const { data: aliases } = await db.from('product_aliases').select('product_id').in('product_id', slice.map(p => p.id)).eq('is_active', true)
    const withAliases = new Set((aliases ?? []).map(a => a.product_id))
    for (const p of slice) if (!withAliases.has(p.id)) orphans.push(p)
  }
  console.log(`Total products: ${allProducts.length}, orphans (0 active aliases): ${orphans.length}`)

  // 2. Pull supplier_invoice_lines with article_number at this business
  // in chunks. To keep scope reasonable, only pull the last 18 months.
  const cutoff = new Date(Date.now() - 18 * 30 * 86400000).toISOString().slice(0, 10)
  const lines = []
  from = 0
  while (true) {
    const { data } = await db.from('supplier_invoice_lines')
      .select('id, supplier_fortnox_number, article_number, raw_description, product_alias_id, invoice_date')
      .eq('business_id', biz.id)
      .gte('invoice_date', cutoff)
      .not('article_number', 'is', null)
      .not('raw_description', 'is', null)
      .order('id').range(from, from + 999)
    if (!data?.length) break
    lines.push(...data)
    if (data.length < 1000) break
    from += 1000
    if (lines.length > 100000) break
  }
  console.log(`Lines with article_number (last 18mo): ${lines.length}`)

  // 3. For each orphan, find candidate lines by Jaccard ≥ 0.5
  const buckets = { A: [], B: [], C: [] }
  for (const orphan of orphans) {
    const candidates = []
    for (const l of lines) {
      const sim = jaccard(orphan.name, l.raw_description)
      if (sim >= 0.5) candidates.push({ sim, line: l })
    }
    if (candidates.length === 0) { buckets.C.push({ orphan }); continue }

    const articleNumbers = new Set(candidates.map(c => c.line.article_number))
    const aliasOwners    = new Set(candidates.map(c => c.line.product_alias_id).filter(Boolean))
    if (articleNumbers.size === 1) {
      // Unambiguous — single article_number. Find the OWNER product (the
      // existing product that owns the aliases matching these lines).
      let ownerProductId = null
      if (aliasOwners.size > 0) {
        const { data: aliasRows } = await db.from('product_aliases')
          .select('id, product_id').in('id', [...aliasOwners]).eq('is_active', true)
        const ownerIds = new Set((aliasRows ?? []).map(a => a.product_id))
        if (ownerIds.size === 1) ownerProductId = [...ownerIds][0]
      }
      buckets.A.push({ orphan, candidates: candidates.slice(0, 3), article: [...articleNumbers][0], owner_product_id: ownerProductId, n_lines: candidates.length })
    } else {
      buckets.B.push({ orphan, candidates: candidates.slice(0, 3), article_numbers: [...articleNumbers] })
    }
  }

  console.log(`\n  Bucket A (UNAMBIGUOUS_DUP):  ${buckets.A.length}`)
  console.log(`  Bucket B (AMBIGUOUS):         ${buckets.B.length}`)
  console.log(`  Bucket C (NO_MATCH):          ${buckets.C.length}`)

  if (buckets.A.length > 0) {
    console.log(`\n  --- Bucket A (first 10) ---`)
    for (const a of buckets.A.slice(0, 10)) {
      console.log(`    "${a.orphan.name}"`)
      console.log(`      article=${a.article}, ${a.n_lines} matching line(s), owner_product=${a.owner_product_id?.slice(0,8) ?? 'NONE'}`)
      for (const c of a.candidates) console.log(`      sim=${c.sim.toFixed(2)} "${c.line.raw_description?.slice(0,60)}"`)
    }
  }
  if (buckets.B.length > 0) {
    console.log(`\n  --- Bucket B (first 5) ---`)
    for (const b of buckets.B.slice(0, 5)) {
      console.log(`    "${b.orphan.name}"`)
      console.log(`      articles: ${b.article_numbers.slice(0,4).join(', ')}`)
    }
  }
}
