#!/usr/bin/env node
// READ-ONLY — characterise the current Chicce recipe state for the
// recipe-cost-surfaces Phase 0 re-evaluation.
//
// Questions:
//   - How many recipes exist at Chicce?
//   - How many have selling_price_ex_vat populated?
//   - How many have ≥1 ingredient linked?
//   - Of those, how many ingredients are product-linked vs unmapped?
//   - Sample 5 recipes that look "real" (price + ≥3 ingredients) for
//     the Phase 0 cost trace.

import { readFileSync } from 'node:fs'
function parseEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter(l => l.includes('=') && !l.trim().startsWith('#'))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
    )
  } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY

async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`)
  return r.json()
}

const BIZ_LIST = [
  { name: 'Chicce',  id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',    id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
  { name: 'Rosali',  id: '97187ef3-b816-4c41-9230-7551430784a7' },
]

for (const biz of BIZ_LIST) {
  const BIZ = biz.id
  console.log(`\n\n========== ${biz.name} ==========\n`)
  await check(BIZ, biz.name)
}

async function check(BIZ, NAME) {
  console.log(`=== Recipe state at ${NAME} ===\n`)

const allRecipes = await q(`recipes?business_id=eq.${BIZ}&select=*&order=created_at.desc`)
console.log(`Total recipes: ${allRecipes.length}`)
if (allRecipes[0]) console.log(`  columns: ${Object.keys(allRecipes[0]).join(', ')}\n`)

const active = allRecipes.filter(r => r.archived_at == null && r.deleted_at == null)
console.log(`  not archived/deleted: ${active.length}`)

const withPrice = active.filter(r => r.selling_price_ex_vat != null && Number(r.selling_price_ex_vat) > 0)
console.log(`  with selling_price_ex_vat > 0: ${withPrice.length}`)

const withoutPrice = active.filter(r => r.selling_price_ex_vat == null || Number(r.selling_price_ex_vat) === 0)
console.log(`  without price: ${withoutPrice.length}`)

console.log('\n--- recipes with price (top 15 by recent updated_at) ---')
const recent = withPrice.slice().sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '')).slice(0, 15)
for (const r of recent) console.log(`  ${r.id}  ${r.name}  price=${r.selling_price_ex_vat}  vat=${r.vat_rate}  ch=${r.channel}  updated=${r.updated_at}`)

console.log('\n--- ingredient coverage for priced recipes ---')
const ingByRecipe = new Map()
const idsForIn = active.map(r => r.id).join(',')
const allIngs = idsForIn ? await q(`recipe_ingredients?recipe_id=in.(${idsForIn})&select=*`) : []
if (allIngs[0]) console.log(`  ing columns: ${Object.keys(allIngs[0]).join(', ')}\n`)
for (const ing of allIngs) {
  if (!ingByRecipe.has(ing.recipe_id)) ingByRecipe.set(ing.recipe_id, [])
  ingByRecipe.get(ing.recipe_id).push(ing)
}
const recipesWithIngs = active.filter(r => (ingByRecipe.get(r.id)?.length ?? 0) > 0)
console.log(`  active recipes with >=1 ingredient: ${recipesWithIngs.length}`)
const richRecipes = active.filter(r => (ingByRecipe.get(r.id)?.length ?? 0) >= 3 && r.selling_price_ex_vat > 0)
console.log(`  active + priced + >=3 ingredients: ${richRecipes.length}`)

const mappedIngs = allIngs.filter(i => i.product_id || i.subrecipe_id).length
const unmappedIngs = allIngs.length - mappedIngs
console.log(`  total ingredient rows: ${allIngs.length}  (mapped=${mappedIngs}, unmapped/text-only=${unmappedIngs})`)

console.log('\n--- sample 5 richest priced recipes (candidates for Phase 0 cost trace) ---')
const candidates = active
  .filter(r => r.selling_price_ex_vat > 0 && (ingByRecipe.get(r.id)?.length ?? 0) >= 3)
  .sort((a, b) => (ingByRecipe.get(b.id)?.length ?? 0) - (ingByRecipe.get(a.id)?.length ?? 0))
  .slice(0, 5)
for (const r of candidates) {
  const ings = ingByRecipe.get(r.id) ?? []
  console.log(`\n  ${r.name}  (price=${r.selling_price_ex_vat} ${r.channel} @ ${r.vat_rate}% VAT, ${ings.length} ingredients)`)
  for (const i of ings.slice(0, 8)) {
    const mapKind = i.product_id ? `product:${i.product_id.slice(0, 8)}` : i.subrecipe_id ? `sub:${i.subrecipe_id.slice(0, 8)}` : 'TEXT-ONLY'
    const text = i.name ?? i.description ?? i.raw_text ?? i.ingredient_text ?? '(no text)'
    console.log(`     - ${text}  ${i.quantity ?? '?'} ${i.unit ?? '?'}  waste=${i.waste_pct ?? 0}%  [${mapKind}]`)
  }
}
}  // end check()
