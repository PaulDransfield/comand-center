#!/usr/bin/env node
// READ-ONLY — trace the cost chain for Vero's "Pinsa Magherita"
// recipe, the only priced recipe with ingredients in the entire system
// right now. Tests whether the costing engine produces a believable
// margin on real data, even though the breadth is too low (1 dish) to
// pass the Phase 0 gate at scale.

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

const VERO_BIZ = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const RECIPE_ID = '58de4c09-4c52-4dfa-8119-160646836b8f'

console.log('=== Pinsa Magherita — cost-trace (Vero) ===\n')

const recipes = await q(`recipes?id=eq.${RECIPE_ID}&select=*`)
const recipe = recipes[0]
console.log(`Recipe: ${recipe.name}`)
console.log(`  selling_price_ex_vat: ${recipe.selling_price_ex_vat} SEK`)
console.log(`  channel:              ${recipe.channel}`)
console.log(`  vat_rate:             ${recipe.vat_rate}%`)
console.log(`  portions:             ${recipe.portions}`)
console.log(`  menu_price (legacy):  ${recipe.menu_price}`)

const ings = await q(`recipe_ingredients?recipe_id=eq.${RECIPE_ID}&select=*&order=position.asc`)
console.log(`\nIngredients: ${ings.length}\n`)

let totalCost = 0
const flags = []

for (const ing of ings) {
  if (!ing.product_id) {
    console.log(`  ?? ingredient has no product_id (subrecipe? text-only?). Skipping.`)
    flags.push('unmapped ingredient')
    continue
  }
  const products = await q(`products?id=eq.${ing.product_id}&select=*`)
  const product = products[0]
  if (!product) {
    console.log(`  !! ingredient ${ing.id} → product_id ${ing.product_id} NOT FOUND`)
    flags.push(`missing product ${ing.product_id}`)
    continue
  }

  console.log(`Ingredient ${ing.position ?? '?'}:`)
  console.log(`  product_id:        ${ing.product_id.slice(0, 8)}`)
  console.log(`  product name:      ${product.name}`)
  console.log(`  recipe call qty:   ${ing.quantity} ${ing.unit}`)
  console.log(`  waste_pct:         ${ing.waste_pct ?? 0}%`)
  console.log(`  product.category:  ${product.category}`)
  console.log(`  product.base_unit: ${product.base_unit}`)
  console.log(`  product.pack_size: ${product.pack_size}`)
  console.log(`  product.default_waste_pct: ${product.default_waste_pct}`)

  // Cost reads use product_aliases. Get aliases for this product, then look up
  // supplier_invoice_lines via product_alias_id.
  const aliases = await q(`product_aliases?product_id=eq.${ing.product_id}&select=id`)
  const aliasIds = aliases.map(a => a.id)
  if (aliasIds.length === 0) {
    console.log(`  ⚠ no product_aliases — no cost path possible`)
    flags.push(`no aliases for ${product.name}`)
    console.log()
    continue
  }
  const lines = await q(`supplier_invoice_lines?product_alias_id=in.(${aliasIds.join(',')})&business_id=eq.${VERO_BIZ}&select=raw_description,quantity,unit,price_per_unit,total_excl_vat,invoice_date,currency,fortnox_invoice_number,supplier_name_snapshot&order=invoice_date.desc&limit=3`)
  if (lines.length === 0) {
    console.log(`  ⚠ no supplier_invoice_lines at Vero for this product`)
    flags.push(`no Vero cost data for ${product.name}`)
    console.log()
    continue
  }
  const latest = lines[0]
  console.log(`  latest invoice:    ${latest.invoice_date}  ${latest.supplier_name_snapshot}  (${lines.length} recent lines)`)
  console.log(`    raw:             "${latest.raw_description?.slice(0, 50)}"`)
  console.log(`    qty/unit:        ${latest.quantity} ${latest.unit}  total=${latest.total_excl_vat} ${latest.currency ?? 'SEK'}`)
  const derivedUnitPrice = latest.total_excl_vat != null && latest.quantity ? latest.total_excl_vat / latest.quantity : null
  console.log(`    derived/unit:    ${derivedUnitPrice?.toFixed(4) ?? 'n/a'} SEK per ${latest.unit ?? '?'}`)

  // Naive: assume recipe unit matches latest invoice unit (1:1 conversion fallback).
  // Real engine has pack-size + unit-family handling — this script is a quick sanity check.
  const recipeQty = Number(ing.quantity ?? 0)
  const wasteFactor = 1 - (Number(ing.waste_pct ?? 0) / 100)
  const adjustedQty = wasteFactor > 0 ? recipeQty / wasteFactor : recipeQty
  let lineCost = null
  if (derivedUnitPrice != null) {
    // crude: if units match exactly, 1:1; otherwise flag.
    if (ing.unit === latest.unit) {
      lineCost = derivedUnitPrice * adjustedQty
    } else {
      // Try common conversions (kg→g, l→ml)
      const map = { kg: ['g', 1000], l: ['ml', 1000], dl: ['ml', 100] }
      const m = map[String(latest.unit ?? '').toLowerCase()]
      if (m && m[0] === String(ing.unit ?? '').toLowerCase()) {
        lineCost = (derivedUnitPrice / m[1]) * adjustedQty
        console.log(`    converted:       ${m[1]}x to get ${ing.unit} from ${latest.unit}`)
      } else {
        console.log(`    ⚠ unit mismatch: recipe ${ing.unit} vs invoice ${latest.unit} — engine handles via pack_size; this script can't`)
        flags.push(`unit mismatch ${product.name}`)
      }
    }
  }
  if (lineCost != null) {
    console.log(`    line cost:       ${lineCost.toFixed(4)} SEK (qty ${recipeQty} ${ing.unit} ÷ (1−${ing.waste_pct ?? 0}%) × derived)`)
    totalCost += lineCost
  }
  console.log()
}

console.log(`\n=== Totals ===`)
console.log(`  total cost (this script's rough computation): ${totalCost.toFixed(4)} SEK`)
console.log(`  selling price ex VAT: ${recipe.selling_price_ex_vat} SEK`)
const margin = recipe.selling_price_ex_vat - totalCost
const marginPct = recipe.selling_price_ex_vat > 0 ? (margin / recipe.selling_price_ex_vat) * 100 : 0
console.log(`  margin kr:            ${margin.toFixed(2)} SEK`)
console.log(`  margin %:             ${marginPct.toFixed(1)}%`)
if (flags.length) {
  console.log(`\n  flags:`)
  for (const f of flags) console.log(`    - ${f}`)
}

console.log(`\nNOTE: this is a script-side rough trace. The real engine in lib/inventory/recipe-cost.ts handles pack_size, base_unit, fx, sub-recipes, etc. — use that for the canonical number. This is here just to sanity-check whether the inputs look right.`)
