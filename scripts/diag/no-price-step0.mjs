// no-price Step 0.
//
// Find recipe-referenced products with no_price (no alias OR no recent
// supplier_invoice_line). For each one, search supplier_invoice_lines
// at this business for lexically-plausible matches the LLM could
// reasonably link.
//
// Buckets:
//   A. Has ≥1 plausible unmatched line  → LLM auto-link candidate
//   B. Has matched lines pointing at ANOTHER product → repoint candidate
//   C. Zero plausible lines             → owner-must-handle (price_override or buy first)
//
// READ-ONLY.

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

// Lexical-similarity helpers. Cheap candidate filter only — Loka-lokalhyra
// principle: we still let the LLM verify.
function tokens(s) {
  return new Set(String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{Letter}\s]/gu, ' ').split(/\s+/).filter(t => t.length >= 3))
}
function jaccard(a, b) {
  const A = tokens(a); const B = tokens(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)

  // 1. recipe ids
  const recipeIds = []
  let from = 0
  while (true) {
    const { data, error } = await db.from('recipes').select('id').eq('business_id', biz.id).order('id').range(from, from + 999)
    if (error) { console.error(error.message); break }
    if (!data || data.length === 0) break
    for (const r of data) recipeIds.push(r.id)
    if (data.length < 1000) break
    from += 1000
  }

  // 2. recipe_ingredients (product-pointing only)
  const ingredients = []
  for (let i = 0; i < recipeIds.length; i += 100) {
    const slice = recipeIds.slice(i, i + 100)
    const { data, error } = await db.from('recipe_ingredients').select('product_id').in('recipe_id', slice).not('product_id', 'is', null)
    if (error) { console.error(error.message); continue }
    ingredients.push(...(data ?? []))
  }
  const productIds = [...new Set(ingredients.map(i => i.product_id))]

  // 3. products
  const products = new Map()
  for (let i = 0; i < productIds.length; i += 100) {
    const slice = productIds.slice(i, i + 100)
    const { data, error } = await db.from('products').select('id, name, category, invoice_unit, pack_size, base_unit, price_override, default_supplier_name').in('id', slice)
    if (error) { console.error(error.message); continue }
    for (const p of data ?? []) products.set(p.id, p)
  }

  // 4. aliases per product (the link to supplier_invoice_lines)
  const aliasesByProduct = new Map()
  for (let i = 0; i < productIds.length; i += 100) {
    const slice = productIds.slice(i, i + 100)
    const { data, error } = await db.from('product_aliases').select('id, product_id').in('product_id', slice)
    if (error) { console.error(error.message); continue }
    for (const a of data ?? []) {
      const arr = aliasesByProduct.get(a.product_id) ?? []
      arr.push(a.id)
      aliasesByProduct.set(a.product_id, arr)
    }
  }

  // 5. latest supplier line per alias
  const allAliasIds = [...new Set([...aliasesByProduct.values()].flat())]
  const linesByAlias = new Map()
  for (let i = 0; i < allAliasIds.length; i += 200) {
    const slice = allAliasIds.slice(i, i + 200)
    const { data, error } = await db.from('supplier_invoice_lines').select('product_alias_id, total_excl_vat, quantity, invoice_date').eq('business_id', biz.id).eq('match_status', 'matched').in('product_alias_id', slice).order('invoice_date', { ascending: false }).limit(2000)
    if (error) { console.error(error.message); continue }
    for (const l of data ?? []) {
      if (!linesByAlias.has(l.product_alias_id)) linesByAlias.set(l.product_alias_id, l)
    }
  }

  // 6. classify each recipe-referenced product
  const noPrice = []
  const hasPrice = []
  for (const pid of productIds) {
    const p = products.get(pid)
    if (!p) continue
    // price_override wins over invoice lines
    if (p.price_override != null) { hasPrice.push(p); continue }
    const aliases = aliasesByProduct.get(pid) ?? []
    const hasLine = aliases.some(aid => linesByAlias.has(aid))
    if (hasLine) hasPrice.push(p)
    else noPrice.push(p)
  }

  console.log(`  recipe-referenced products: ${productIds.length}`)
  console.log(`  with price:    ${hasPrice.length}`)
  console.log(`  NO PRICE:      ${noPrice.length}`)
  if (noPrice.length === 0) continue

  // 7. for each no_price product, find candidate supplier lines
  // (unmatched at this business with overlapping tokens). Bucket A/B/C.
  // Pull EVERY supplier line for this business (paginated — Supabase
  // caps SELECT at 1000/req regardless of .limit).
  const unmatchedLines = []
  let lfrom = 0
  while (lfrom < 50000) {
    const { data, error } = await db.from('supplier_invoice_lines')
      .select('id, raw_description, supplier_name_snapshot, total_excl_vat, quantity, unit, product_alias_id, match_status, invoice_date')
      .eq('business_id', biz.id)
      .order('id').range(lfrom, lfrom + 999)
    if (error) { console.error(error.message); break }
    if (!data || data.length === 0) break
    unmatchedLines.push(...data)
    if (data.length < 1000) break
    lfrom += 1000
  }
  console.log(`  supplier lines in scope: ${unmatchedLines.length}`)

  const bucketA = []   // plausible unmatched lines exist → LLM auto-link
  const bucketB = []   // matched lines exist pointing to another product → repoint
  const bucketC = []   // no plausible match → owner

  for (const p of noPrice) {
    const cands = []
    for (const l of unmatchedLines ?? []) {
      const sim = jaccard(p.name, l.raw_description)
      if (sim >= 0.30) cands.push({ ...l, sim })
    }
    cands.sort((a, b) => b.sim - a.sim)
    const top = cands.slice(0, 5)
    const hasUnmatched = top.some(c => !c.product_alias_id)
    const hasMatchedElsewhere = top.some(c => c.product_alias_id)
    if (hasUnmatched) bucketA.push({ product: p, candidates: top })
    else if (hasMatchedElsewhere) bucketB.push({ product: p, candidates: top })
    else bucketC.push({ product: p })
  }

  console.log(`\n  Bucket A (unmatched lines available — LLM auto-link): ${bucketA.length}`)
  console.log(`  Bucket B (matched-elsewhere — repoint via owner UI):   ${bucketB.length}`)
  console.log(`  Bucket C (zero plausible match — owner override/buy):  ${bucketC.length}`)

  console.log(`\n  Bucket A sample (first 10):`)
  for (const e of bucketA.slice(0, 10)) {
    const t = e.candidates[0]
    console.log(`    • "${e.product.name}"  (top match sim=${t.sim.toFixed(2)})`)
    console.log(`        → "${t.raw_description}"  ${t.supplier_name_snapshot ?? '?'}  ${t.product_alias_id ? '[ALREADY LINKED]' : ''}`)
  }
  console.log(`\n  Bucket B sample (first 5):`)
  for (const e of bucketB.slice(0, 5)) {
    const t = e.candidates[0]
    console.log(`    • "${e.product.name}"  (top match sim=${t.sim.toFixed(2)})`)
    console.log(`        → "${t.raw_description}"  [LINKED ELSEWHERE — repoint needed]`)
  }
  console.log(`\n  Bucket C sample (first 5):`)
  for (const e of bucketC.slice(0, 5)) {
    console.log(`    • "${e.product.name}"  invoice_unit=${e.product.invoice_unit ?? '∅'}  supplier=${e.product.default_supplier_name ?? '?'}`)
  }
}

console.log('\ndone')
