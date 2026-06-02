// Step 2 — stranded-cost re-measure POST auto-repointer.
//
// For each incomplete-cost recipe ingredient, check if the no_price or
// unit_mismatch product has a DUPLICATE-name sibling product that DOES
// have a recent supplier line. If yes → cost is stranded; consolidation
// would unlock it. If no → genuinely missing data.
//
// Today's auto-repointer already swept the safe-duplicate cases at
// recipe ingredients. This re-measure should show the residue.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

function normalisedRoot(name) {
  if (!name) return ''
  let s = String(name).toLowerCase().normalize('NFKD')
  s = s.replace(/\([^)]*\)/g, ' ')
  s = s.replace(/\b(sc|rb|se|kl1|st|stk)\b/g, ' ')
  s = s.replace(/\b\d+(?:[.,]\d+)?\s*x\s*\d+(?:[.,]\d+)?\s*(?:kg|g|gr|gram|ml|cl|dl|l|liter|litre|eg|st|stk)?\b/g, ' ')
  s = s.replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|hg|g|gr|gram|ml|cl|dl|l|liter|litre|lt|lf|eg|st|stk|burk|flaska|paket|pkt|frp|fp|pack)\b/g, ' ')
  s = s.replace(/[^\p{Letter}\s]/gu, ' ')
  const tokens = s.split(/\s+/).filter(t => t.length >= 3)
  const distinguishing = new Set()
  for (const t of tokens) {
    if (t === 'frys' || t === 'fryst') distinguishing.add('@frozen')
    if (t === 'eko' || t === 'ekologisk') distinguishing.add('@organic')
    if (t === 'pet') distinguishing.add('@pet')
  }
  const core = tokens
    .filter(t => !['frys','fryst','eko','ekologisk','pet','varav','pant','per','enhet','sek','och','med','utan'].includes(t))
    .sort()
  return [...core, ...[...distinguishing].sort()].join(' ')
}

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)

  // 1. recipe ids
  const recipeIds = []
  let from = 0
  while (true) {
    const { data, error } = await db.from('recipes').select('id, name').eq('business_id', biz.id).order('id').range(from, from + 999)
    if (error) { console.error(error.message); break }
    if (!data || data.length === 0) break
    for (const r of data) recipeIds.push({ id: r.id, name: r.name })
    if (data.length < 1000) break
    from += 1000
  }
  const recipeById = new Map(recipeIds.map(r => [r.id, r.name]))

  // 2. recipe_ingredients
  const ingredients = []
  for (let i = 0; i < recipeIds.length; i += 100) {
    const slice = recipeIds.slice(i, i + 100).map(r => r.id)
    const { data } = await db.from('recipe_ingredients').select('product_id, unit, recipe_id').in('recipe_id', slice).not('product_id', 'is', null)
    ingredients.push(...(data ?? []))
  }
  const productIds = [...new Set(ingredients.map(i => i.product_id))]

  // 3. products + aliases + recent prices map
  const products = new Map()
  for (let i = 0; i < productIds.length; i += 100) {
    const slice = productIds.slice(i, i + 100)
    const { data } = await db.from('products').select('id, name, pack_size, base_unit, price_override').in('id', slice)
    for (const p of data ?? []) products.set(p.id, p)
  }
  // ALL active products in biz so we can find sibling fragments
  const allProds = []
  let pf = 0
  while (true) {
    const { data } = await db.from('products').select('id, name, pack_size, base_unit').eq('business_id', biz.id).is('archived_at', null).order('id').range(pf, pf + 999)
    if (!data || data.length === 0) break
    allProds.push(...data)
    if (data.length < 1000) break
    pf += 1000
  }
  // root → list of product ids
  const rootIndex = new Map()
  for (const p of allProds) {
    const root = normalisedRoot(p.name)
    if (!root) continue
    const arr = rootIndex.get(root) ?? []
    arr.push(p); rootIndex.set(root, arr)
  }

  // Per-product: does it have ANY supplier line history?
  const aliasesByProduct = new Map()
  for (let i = 0; i < allProds.length; i += 100) {
    const slice = allProds.slice(i, i + 100).map(p => p.id)
    const { data } = await db.from('product_aliases').select('id, product_id').in('product_id', slice)
    for (const a of data ?? []) {
      const arr = aliasesByProduct.get(a.product_id) ?? []
      arr.push(a.id); aliasesByProduct.set(a.product_id, arr)
    }
  }
  const aliasIds = [...new Set([...aliasesByProduct.values()].flat())]
  const aliasHasLine = new Set()
  for (let i = 0; i < aliasIds.length; i += 200) {
    const slice = aliasIds.slice(i, i + 200)
    const { data } = await db.from('supplier_invoice_lines').select('product_alias_id').eq('business_id', biz.id).eq('match_status', 'matched').in('product_alias_id', slice).limit(2000)
    for (const l of data ?? []) aliasHasLine.add(l.product_alias_id)
  }
  function productHasPrice(p) {
    if (p.price_override != null) return true
    const aliases = aliasesByProduct.get(p.id) ?? []
    return aliases.some(aid => aliasHasLine.has(aid))
  }

  // 4. For each recipe ingredient, classify
  let strandedCost = 0       // ingredient no_price AND a sibling fragment HAS a price
  let genuinelyMissing = 0   // ingredient no_price AND no sibling fragment with price
  let healthy = 0            // ingredient has price
  const strandedExamples = []
  const recipeStatus = new Map() // recipe_id → { stranded, missing }

  for (const ing of ingredients) {
    const p = products.get(ing.product_id)
    if (!p) continue
    if (productHasPrice(p)) { healthy++; continue }
    // no_price — look for siblings
    const root = normalisedRoot(p.name)
    const siblings = (rootIndex.get(root) ?? []).filter(s => s.id !== p.id)
    const siblingWithPrice = siblings.find(s => productHasPrice(s))
    if (siblingWithPrice) {
      strandedCost++
      strandedExamples.push({
        recipe:   recipeById.get(ing.recipe_id) ?? '?',
        product:  p.name,
        sibling:  siblingWithPrice.name,
      })
      const cur = recipeStatus.get(ing.recipe_id) ?? { stranded: 0, missing: 0 }
      cur.stranded++; recipeStatus.set(ing.recipe_id, cur)
    } else {
      genuinelyMissing++
      const cur = recipeStatus.get(ing.recipe_id) ?? { stranded: 0, missing: 0 }
      cur.missing++; recipeStatus.set(ing.recipe_id, cur)
    }
  }

  console.log(`  recipe ingredients (product-linked): ${ingredients.length}`)
  console.log(`    healthy (has price):       ${healthy}`)
  console.log(`    STRANDED on a duplicate:   ${strandedCost}`)
  console.log(`    GENUINELY MISSING price:   ${genuinelyMissing}`)

  // Recipe-level: how many recipes have at least one stranded ingredient
  // that would complete if consolidated?
  let recipesAllHealthy = 0, recipesStranded = 0, recipesMissingOnly = 0
  for (const [, status] of recipeStatus) {
    if (status.stranded === 0 && status.missing === 0) recipesAllHealthy++
    else if (status.stranded > 0 && status.missing === 0) recipesStranded++
    else if (status.stranded > 0 && status.missing > 0) recipesStranded++   // would partially complete
    else recipesMissingOnly++
  }
  // The TRUE recipesAllHealthy = recipes where every ingredient is priced.
  // We tracked only recipes that have ≥1 issue in recipeStatus, so recipes
  // with no issues never entered it. Recompute.
  const recipesWithIssues = recipeStatus.size
  const recipesTotal = new Set(ingredients.map(i => i.recipe_id)).size
  recipesAllHealthy = recipesTotal - recipesWithIssues
  console.log(`\n  recipe-level:`)
  console.log(`    recipes with ≥1 product-ingredient: ${recipesTotal}`)
  console.log(`    all-healthy:                        ${recipesAllHealthy}`)
  console.log(`    have stranded ingredients (cost recoverable via consolidation): ${recipesStranded}`)
  console.log(`    only genuinely-missing prices:      ${recipesMissingOnly}`)

  if (strandedExamples.length > 0) {
    console.log(`\n  Stranded-cost examples (first 15):`)
    for (const e of strandedExamples.slice(0, 15)) {
      console.log(`    • Recipe "${e.recipe}" → ingredient "${e.product}" (no price)`)
      console.log(`        sibling with price: "${e.sibling}"`)
    }
  }
}

console.log('\ndone')
