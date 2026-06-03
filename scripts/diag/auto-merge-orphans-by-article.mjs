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
//   - At least 3 invoice lines at this business share Jaccard ≥ 0.5
//     with the orphan name
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

  // 2. Find orphans
  const orphans = []
  for (let i = 0; i < allProducts.length; i += 200) {
    const slice = allProducts.slice(i, i + 200)
    const { data: aliases } = await db.from('product_aliases').select('product_id').in('product_id', slice.map(p => p.id)).eq('is_active', true)
    const withAliases = new Set((aliases ?? []).map(a => a.product_id))
    for (const p of slice) if (!withAliases.has(p.id)) orphans.push(p)
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
    if (candidates.length < 3) continue
    const articleNumbers = new Set(candidates.map(c => c.line.article_number))
    if (articleNumbers.size !== 1) continue
    const aliasIds = [...new Set(candidates.map(c => c.line.product_alias_id).filter(Boolean))]
    if (aliasIds.length === 0) continue
    const { data: aliasRows } = await db.from('product_aliases').select('id, product_id').in('id', aliasIds).eq('is_active', true)
    const ownerIds = new Set((aliasRows ?? []).map(a => a.product_id))
    if (ownerIds.size !== 1) continue
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
        // Archive orphan
        const { error: archErr } = await db.from('products').update({
          archived_at: new Date().toISOString(),
          archive_reason: `auto_merged_to_${m.owner.id}_article_${m.article}`,
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
