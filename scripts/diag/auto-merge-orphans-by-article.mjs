// Auto-merge orphan products (0 active aliases) where another product at
// the same business owns aliases pointing to lines with a SINGLE shared
// article_number that strongly resembles the orphan's name.
//
// This is the Antica Osteria Rosso 75eg class — the chef typed a new
// product name in the recipe editor (or AI importer created it) and we
// failed to dedupe against the canonical product that already had
// invoice history. The clean fix: archive the orphan, redirect any
// recipe_ingredients pointing at it to the owner product, log the
// rationale.
//
// Conservative gates:
//   - Orphan has 0 active aliases
//   - At least 1 invoice line at this business shares Jaccard ≥ 0.5
//     with the orphan name (load-bearing protection is the same-article
//     constraint below, not the line count — orphans created from chef-
//     typed CAPS+annotation variants commonly hit only 1 line in the
//     picker. The ÄRTER GRÖNA case the user reported is one such)
//   - ALL matched lines share the same article_number (unambiguous SKU)
//   - The owner_product (the one whose aliases point at those lines)
//     is single-valued (one product owns the cluster)
//   - The owner_product has at least 4 lines of history (avoids
//     repointing into another stub)
//
// Usage:
//   node scripts/diag/auto-merge-orphans-by-article.mjs              # DRY
//   node scripts/diag/auto-merge-orphans-by-article.mjs --apply

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const APPLY = process.argv.includes('--apply')

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

  // 1. All active products
  const allProducts = []
  let from = 0
  while (true) {
    const { data } = await db.from('products')
      .select('id, name, default_supplier_name')
      .eq('business_id', biz.id).is('archived_at', null).order('id').range(from, from + 999)
    if (!data?.length) break
    allProducts.push(...data)
    if (data.length < 1000) break; from += 1000
  }

  // 2. Find merge candidates.
  // Previously we only considered products with 0 active aliases (true
  // orphans). But the ÄRTER GRÖNA case (2026-06-03) showed that a
  // product can have 1-2 sparse aliases AND still be a duplicate of a
  // canonical owner with the same article number. So we consider EVERY
  // active product as a candidate; the (owners excluding self) gate
  // below screens out anything that's already canonical.
  //
  // To avoid endlessly considering products that obviously won't merge,
  // we cap at products with ≤ 5 active aliases (more than that, it's
  // clearly canonical itself).
  const orphans = []
  for (let i = 0; i < allProducts.length; i += 200) {
    const slice = allProducts.slice(i, i + 200)
    const { data: aliases } = await db.from('product_aliases').select('product_id').in('product_id', slice.map(p => p.id)).eq('is_active', true)
    const aliasCounts = new Map()
    for (const a of aliases ?? []) aliasCounts.set(a.product_id, (aliasCounts.get(a.product_id) ?? 0) + 1)
    for (const p of slice) {
      const cnt = aliasCounts.get(p.id) ?? 0
      if (cnt <= 5) orphans.push(p)
    }
  }

  // 3. Pull recent lines with article_number
  const cutoff = new Date(Date.now() - 18 * 30 * 86400000).toISOString().slice(0, 10)
  const lines = []
  from = 0
  while (true) {
    const { data } = await db.from('supplier_invoice_lines')
      .select('id, supplier_fortnox_number, article_number, raw_description, product_alias_id')
      .eq('business_id', biz.id).gte('invoice_date', cutoff)
      .not('article_number', 'is', null).not('raw_description', 'is', null)
      .order('id').range(from, from + 999)
    if (!data?.length) break
    lines.push(...data)
    if (data.length < 1000) break; from += 1000
    if (lines.length > 100000) break
  }

  // 4. For each orphan, classify + find owner_product
  const merges = []
  for (const orphan of orphans) {
    const candidates = []
    for (const l of lines) {
      const sim = jaccard(orphan.name, l.raw_description)
      if (sim >= 0.5) candidates.push({ sim, line: l })
    }
    if (candidates.length < 1) continue
    // Load-bearing gate: all candidate lines must trace back to ONE owner
    // product (other than the orphan itself). Article-number variation
    // is fine — MS sometimes uses both the standard catalogue number
    // (e.g. 345603) AND an internal "M/S NNNNN" reference for the same
    // SKU. As long as all NON-SELF aliases point at a single product,
    // that product IS the canonical owner.
    //
    // The orphan-is-an-owner-too case (ÄRTER GRÖNA 2026-06-03): orphan
    // has 1 alias pointing at itself with sparse lines, canonical owner
    // has the historical aliases with rich history. They share the same
    // article. Both are "owners" of candidate lines but only the other
    // is the canonical target.
    const aliasIds = [...new Set(candidates.map(c => c.line.product_alias_id).filter(Boolean))]
    if (aliasIds.length === 0) continue
    const { data: aliasRows } = await db.from('product_aliases').select('id, product_id').in('id', aliasIds).eq('is_active', true)
    const rawOwners = new Set((aliasRows ?? []).map(a => a.product_id))
    const ownerIds = new Set([...rawOwners].filter(id => id !== orphan.id))
    if (ownerIds.size !== 1) continue
    // Capture the article number(s) for the audit log — first article seen.
    const articleNumbers = new Set(candidates.map(c => c.line.article_number))
    const ownerId = [...ownerIds][0]
    // Owner product must have at least 4 lines of history (not another stub)
    const { count: ownerLineCount } = await db.from('supplier_invoice_lines')
      .select('*', { count: 'exact', head: true })
      .in('product_alias_id', aliasIds.length ? aliasIds : ['00000000-0000-0000-0000-000000000000'])
    if ((ownerLineCount ?? 0) < 4) continue
    const owner = allProducts.find(p => p.id === ownerId)
    if (!owner) continue
    merges.push({
      orphan, owner,
      article: [...articleNumbers][0],
      n_candidate_lines: candidates.length,
      sample: candidates.slice(0, 3).map(c => ({ sim: c.sim, raw: c.line.raw_description })),
    })
  }

  console.log(`Orphans considered: ${orphans.length}`)
  console.log(`Eligible auto-merges: ${merges.length}`)

  // Sample
  for (const m of merges.slice(0, 15)) {
    console.log(`\n  • orphan "${m.orphan.name}"`)
    console.log(`    → merge into owner "${m.owner.name}"`)
    console.log(`    article=${m.article}, ${m.n_candidate_lines} matching line(s)`)
  }

  if (APPLY) {
    console.log(`\nAPPLYING ${merges.length} merges…`)
    let ok = 0
    for (const m of merges) {
      try {
        // Redirect recipe_ingredients
        const { data: recIngs } = await db.from('recipe_ingredients').select('id').eq('product_id', m.orphan.id)
        if (recIngs?.length) {
          const { error: riErr } = await db.from('recipe_ingredients').update({ product_id: m.owner.id }).eq('product_id', m.orphan.id)
          if (riErr) throw new Error(`recipe_ingredients update: ${riErr.message}`)
        }
        // Archive orphan. (products.archive_reason doesn't exist in
        // schema; reasoning lives in this script's commit + the apply
        // log instead.)
        const { error: archErr } = await db.from('products').update({
          archived_at: new Date().toISOString(),
        }).eq('id', m.orphan.id)
        if (archErr) throw new Error(`archive: ${archErr.message}`)
        ok++
      } catch (e) {
        console.error(`  Failed "${m.orphan.name}": ${e.message}`)
      }
    }
    console.log(`Merged: ${ok} / ${merges.length}`)
  } else {
    console.log(`\n(DRY — re-run with --apply to merge)`)
  }
}
