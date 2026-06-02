// scope-llm-pack-resolver.mjs
//
// READ-ONLY. Sizes the LLM pack-size auto-resolver opportunity:
//
//   1. How many products have no pack_size/base_unit?
//   2. Of those, how many are REFERENCED by recipe_ingredients (i.e.
//      actually mattering for cost — not orphan catalogue rows)?
//   3. Of the referenced ones, how many would the deterministic regex
//      parser solve right now if we just re-ran the backfill?
//   4. What does the residue look like — the names the regex can't
//      solve but a human would say "obviously X liters of Y"?
//
// Plus: a sample of 20 residue product names so we can eyeball whether
// Haiku could reasonably solve them.

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

// Inlined copy of parseProductPackSize — kept simple so the diag doesn't
// drift from the canonical lib copy; matches the same regex shape.
const PACK_RE = /(\d+(?:[.,]\d+)?)\s*(kg|g|gram|gr|l|liter|litre|ml|cl|dl|st|stk|styck|pcs|pack|pkt|burk|flaska)\b/gi
function parsePack(name) {
  if (!name) return null
  const matches = Array.from(String(name).matchAll(PACK_RE))
  if (matches.length === 0) return null
  const m = matches[matches.length - 1]
  const num = Number(m[1].replace(',', '.'))
  if (!Number.isFinite(num) || num <= 0) return null
  const u = m[2].toLowerCase()
  // Map to {pack_size_in_base_unit, base_unit}.
  if (u === 'kg')                    return { pack: num * 1000, base: 'g',  raw: m[0] }
  if (u === 'g' || u === 'gram' || u === 'gr') return { pack: num,        base: 'g',  raw: m[0] }
  if (u === 'l' || u === 'liter' || u === 'litre') return { pack: num * 1000, base: 'ml', raw: m[0] }
  if (u === 'cl')                    return { pack: num * 10,   base: 'ml', raw: m[0] }
  if (u === 'dl')                    return { pack: num * 100,  base: 'ml', raw: m[0] }
  if (u === 'ml')                    return { pack: num,        base: 'ml', raw: m[0] }
  if (['st','stk','styck','pcs','pack','pkt','burk','flaska'].includes(u)) return { pack: num, base: 'st', raw: m[0] }
  return null
}

for (const biz of BUSINESSES) {
  console.log(`\n══════════════════════════════════════════════════════════════════`)
  console.log(`  ${biz.name}`)
  console.log(`══════════════════════════════════════════════════════════════════`)

  // Step 1 — pull all products (paginated, batch 1000).
  const allProducts = []
  let pfrom = 0
  while (true) {
    const { data, error } = await db.from('products')
      .select('id, name, category, pack_size, base_unit, invoice_unit')
      .eq('business_id', biz.id)
      .order('id').range(pfrom, pfrom + 999)
    if (error) { console.error('products fetch:', error.message); break }
    if (!data || data.length === 0) break
    allProducts.push(...data)
    if (data.length < 1000) break
    pfrom += 1000
  }
  console.log(`  total products: ${allProducts.length}`)

  // Step 2 — products with missing pack info.
  const noPack = allProducts.filter(p => p.pack_size == null || p.base_unit == null)
  console.log(`  no pack_size or base_unit: ${noPack.length} (${(100 * noPack.length / allProducts.length).toFixed(1)}%)`)

  // Step 3 — which of those are REFERENCED by recipe_ingredients (matter for cost)?
  // Two-step query to dodge PostgREST dual-FK and silent-null limits.
  const noPackIds = noPack.map(p => p.id)
  const refIds = new Set()
  for (let i = 0; i < noPackIds.length; i += 100) {
    const slice = noPackIds.slice(i, i + 100)
    const { data: ri, error: rErr } = await db.from('recipe_ingredients')
      .select('product_id').in('product_id', slice)
    if (rErr) { console.error('recipe_ingredients lookup:', rErr.message); continue }
    for (const r of ri ?? []) refIds.add(r.product_id)
  }
  const referenced = noPack.filter(p => refIds.has(p.id))
  console.log(`  ↳ referenced by ≥1 recipe ingredient: ${referenced.length}`)

  // Step 4 — regex would solve which of those?
  const regexSolvable = referenced.filter(p => parsePack(p.name) != null)
  const regexResidue  = referenced.filter(p => parsePack(p.name) == null)
  console.log(`  ↳ regex would solve right now:        ${regexSolvable.length}`)
  console.log(`  ↳ residue (regex can't solve):        ${regexResidue.length}`)

  // Step 5 — sample 20 names from each bucket.
  console.log(`\n  REGEX-SOLVABLE sample (these the backfill alone would fix — confirm):`)
  for (const p of regexSolvable.slice(0, 10)) {
    const r = parsePack(p.name)
    console.log(`    • "${p.name}" → ${r.pack} ${r.base} (from "${r.raw}")`)
  }
  console.log(`\n  RESIDUE sample (these are the LLM opportunity — eyeball each):`)
  for (const p of regexResidue.slice(0, 20)) {
    console.log(`    • "${p.name}" — invoice unit: ${p.invoice_unit ?? '—'}`)
  }

  // Step 6 — separate slice: unit-MISMATCH ingredients specifically.
  // These are the lines that show up RED in recipe drawers right now.
  // Two-step query — recipe_ingredients has TWO FKs to recipes
  // (recipe_id + subrecipe_id); the !inner embed silently picks the
  // wrong one. See feedback_postgrest_dual_fk_ambiguity memory.

  // Step 6a — every recipe id for this business.
  const recipeIds = []
  let recfrom = 0
  while (true) {
    const { data, error } = await db.from('recipes')
      .select('id').eq('business_id', biz.id)
      .order('id').range(recfrom, recfrom + 999)
    if (error) { console.error('recipes(biz):', error.message); break }
    if (!data || data.length === 0) break
    for (const r of data) recipeIds.push(r.id)
    if (data.length < 1000) break
    recfrom += 1000
  }
  console.log(`  recipes in business: ${recipeIds.length}`)

  // Step 6b — recipe_ingredients filtered by recipe_id in batches of 100.
  const allRecipeIng = []
  for (let i = 0; i < recipeIds.length; i += 100) {
    const slice = recipeIds.slice(i, i + 100)
    const { data, error } = await db.from('recipe_ingredients')
      .select('product_id, unit')
      .in('recipe_id', slice)
      .not('product_id', 'is', null)
    if (error) { console.error('recipe_ingredients lookup:', error.message); break }
    if (data) allRecipeIng.push(...data)
  }
  console.log(`\n  recipe_ingredients linked to a product: ${allRecipeIng.length}`)
  // Indices.
  const productById = new Map(allProducts.map(p => [p.id, p]))
  const mismatchProducts = new Map()  // product_id → product
  for (const ri of allRecipeIng) {
    const p = productById.get(ri.product_id)
    if (!p) continue
    // Mismatch = recipe says g/ml/kg/l etc but product has no base_unit
    // OR family disagrees. Without base_unit the cost engine can't convert.
    if (p.base_unit == null || p.pack_size == null) {
      // recipe wants weight/volume?
      const ru = String(ri.unit ?? '').toLowerCase()
      if (['g','kg','ml','l','cl','dl'].includes(ru)) {
        mismatchProducts.set(p.id, p)
      }
    }
  }
  console.log(`  products causing UNIT-MISMATCH on a recipe row: ${mismatchProducts.size}`)
  const mismatchList = [...mismatchProducts.values()]
  const mismatchRegexSolvable = mismatchList.filter(p => parsePack(p.name) != null)
  const mismatchResidue       = mismatchList.filter(p => parsePack(p.name) == null)
  console.log(`    ↳ regex would solve:    ${mismatchRegexSolvable.length}`)
  console.log(`    ↳ LLM residue:          ${mismatchResidue.length}`)
  console.log(`\n  Mismatch RESIDUE sample (the ACTUAL pain — owner sees these red):`)
  for (const p of mismatchResidue.slice(0, 20)) {
    console.log(`    • "${p.name}" — invoice unit: ${p.invoice_unit ?? '—'}`)
  }
}

console.log(`\n──────────────────────────────────────────────────────────────────`)
console.log(`done`)
