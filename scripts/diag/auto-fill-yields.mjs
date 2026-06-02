// auto-fill-yields.mjs
//
// Find sub-recipes that ARE consumed in non-portion units (g/ml/kg/l)
// by another recipe AND have yield_amount/unit null. Auto-compute the
// yield by summing their own ingredients' mass (in g, treating ml as g
// per cooking convention) and dividing by portions.
//
// Same math as suggestYieldFromIngredients in components/RecipeEditor.tsx.
// Deterministic — no LLM needed.
//
// Honest-incomplete:
//   - Skip when the sub has no summable ingredients (all sub-sub-recipes
//     with no yield) — math would be wrong
//   - Skip when ingredient unit_mismatches on the sub itself
//   - Skip when the sub's pack-info products can't convert to g/ml
//
// Usage:
//   node scripts/diag/auto-fill-yields.mjs           # DRY
//   node scripts/diag/auto-fill-yields.mjs --apply

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const APPLY        = process.argv.includes('--apply')
const REEVAL_ALL   = process.argv.includes('--reeval')   // include subs that already have a yield, propose replacement
const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

// Family conversion → grams (treating ml ≈ g cooking density).
// Returns null when unit is unknown / cross-family without density.
const TO_G = {
  g:  1,   kg: 1000, hg: 100, gram: 1, gr: 1, grams: 1,
  ml: 1,   cl: 10,   dl: 100, l: 1000, eg: 10, lt: 1000, lf: 1000, liter: 1000, litre: 1000,
}
function toGrams(qty, unit) {
  if (!unit) return null
  const u = String(unit).trim().toLowerCase()
  const factor = TO_G[u]
  if (factor == null) return null
  return Number(qty) * factor
}

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)

  // 1. ALL recipes in business
  const recipes = new Map()
  let from = 0
  while (true) {
    const { data, error } = await db.from('recipes')
      .select('id, name, portions, yield_amount, yield_unit, archived_at')
      .eq('business_id', biz.id)
      .is('archived_at', null)
      .order('id').range(from, from + 999)
    if (error) { console.error(error.message); break }
    if (!data || data.length === 0) break
    for (const r of data) recipes.set(r.id, r)
    if (data.length < 1000) break
    from += 1000
  }
  console.log(`  recipes: ${recipes.size}`)

  // 2. ALL recipe_ingredients in business (paginated via recipe_id .in)
  const recipeIds = [...recipes.keys()]
  const ingredients = []
  for (let i = 0; i < recipeIds.length; i += 100) {
    const slice = recipeIds.slice(i, i + 100)
    const { data } = await db.from('recipe_ingredients')
      .select('id, recipe_id, product_id, subrecipe_id, quantity, unit')
      .in('recipe_id', slice)
    ingredients.push(...(data ?? []))
  }
  console.log(`  recipe_ingredients: ${ingredients.length}`)

  // 3. ALL products in business — for ingredient → grams conversion
  const products = new Map()
  let pf = 0
  while (true) {
    const { data } = await db.from('products')
      .select('id, name, pack_size, base_unit, density_g_per_ml')
      .eq('business_id', biz.id).is('archived_at', null).order('id').range(pf, pf + 999)
    if (!data || data.length === 0) break
    for (const p of data) products.set(p.id, p)
    if (data.length < 1000) break
    pf += 1000
  }

  // 4. Identify sub-recipes consumed by non-portion units AND yieldless.
  const yieldlessSubsConsumed = new Map()  // sub_id → [consuming recipes]
  for (const ing of ingredients) {
    if (!ing.subrecipe_id) continue
    if (ing.unit === 'portion' || !ing.unit) continue
    const sub = recipes.get(ing.subrecipe_id)
    if (!sub) continue
    if (sub.yield_amount && sub.yield_unit && !REEVAL_ALL) continue   // already has yield
    const arr = yieldlessSubsConsumed.get(ing.subrecipe_id) ?? []
    arr.push({ recipe_id: ing.recipe_id, recipe_name: recipes.get(ing.recipe_id)?.name ?? '?', unit: ing.unit, quantity: ing.quantity })
    yieldlessSubsConsumed.set(ing.subrecipe_id, arr)
  }
  console.log(`  sub-recipes consumed by weight/volume but yieldless: ${yieldlessSubsConsumed.size}`)
  if (yieldlessSubsConsumed.size === 0) continue

  // 5. For each yieldless sub, compute its yield from own ingredients.
  // Conservative: sum_grams of leaf-ingredient masses.
  const ingredientsByRecipe = new Map()
  for (const ing of ingredients) {
    const arr = ingredientsByRecipe.get(ing.recipe_id) ?? []
    arr.push(ing); ingredientsByRecipe.set(ing.recipe_id, arr)
  }

  const suggestions = []
  const skipped = []
  for (const [subId, consumers] of yieldlessSubsConsumed) {
    const sub = recipes.get(subId)
    const subIngs = ingredientsByRecipe.get(subId) ?? []
    if (subIngs.length === 0) { skipped.push({ sub_id: subId, sub_name: sub.name, why: 'no ingredients in sub' }); continue }

    let totalG = 0
    let summed = 0
    let skippedI = 0
    let skipReason = null
    for (const subIng of subIngs) {
      const qty = Number(subIng.quantity)
      if (!Number.isFinite(qty) || qty <= 0) { skippedI++; continue }

      // Path 1 — direct unit → grams (g/kg/ml/cl/dl/l/etc.).
      let g = toGrams(qty, subIng.unit)

      // Path 2 — recipe asks in 'st' for a product with pack_size+base_unit set.
      // E.g. "2 st of Catergula Äggula 1kg" (pack=1000 g) = 2000 g contribution.
      // This catches the chef-shorthand-pattern where a bulk product is
      // consumed by the pack-count rather than the gram-weight.
      if (g == null && subIng.product_id) {
        const p = products.get(subIng.product_id)
        if (p && p.pack_size && p.base_unit) {
          const unitLc = String(subIng.unit ?? '').toLowerCase()
          // If recipe asks 'st'/'styck' and product base is g/ml, multiply
          // qty by pack_size (qty st × pack g per st).
          if (['st','styck','stk','pcs'].includes(unitLc) && ['g','ml'].includes(p.base_unit)) {
            g = qty * Number(p.pack_size)
          }
        }
      }

      // Path 3 — sub-sub-recipe with known yield contributes the qty
      // (already in g/ml).
      if (g == null && subIng.subrecipe_id) {
        const subSub = recipes.get(subIng.subrecipe_id)
        if (subSub?.yield_amount && subSub?.yield_unit) {
          const qtyAsYield = toGrams(qty, subIng.unit)
          if (qtyAsYield != null) g = qtyAsYield
        }
      }

      if (g == null) { skippedI++; skipReason = `couldn't convert ${qty} ${subIng.unit}`; continue }
      totalG += g
      summed++
    }

    if (summed === 0 || totalG <= 0) {
      skipped.push({ sub_id: subId, sub_name: sub.name, why: `no summable ingredients (${skippedI} skipped; ${skipReason ?? 'no data'})` })
      continue
    }

    const yieldAmount = Math.round((totalG / sub.portions) * 10) / 10

    // In --reeval mode, only propose an UPDATE when the new yield is
    // meaningfully higher than stored (within 1% considered no-op).
    // Lower-yield revisions are skipped — they'd downgrade an
    // owner-set value the script can't see.
    if (sub.yield_amount && REEVAL_ALL) {
      const stored = Number(sub.yield_amount)
      const drift  = (yieldAmount - stored) / Math.max(1, stored)
      if (drift <= 0.01) {
        skipped.push({ sub_id: subId, sub_name: sub.name, why: `stored ${stored} g >= new ${yieldAmount} g (no improvement)` })
        continue
      }
    }

    suggestions.push({
      sub_id:        subId,
      sub_name:      sub.name,
      portions:      sub.portions,
      yield_amount:  yieldAmount,
      yield_unit:    'g',
      previous_yield: sub.yield_amount,
      summed,
      skipped:       skippedI,
      sample_consumer: consumers[0],
    })
  }

  console.log(`  Suggestions: ${suggestions.length}`)
  console.log(`  Skipped:     ${skipped.length}`)

  if (suggestions.length > 0) {
    console.log(`\n  Sample suggestions (first 15):`)
    for (const s of suggestions.slice(0, 15)) {
      const prevStr = s.previous_yield ? ` (was ${s.previous_yield} g)` : ''
      console.log(`    • "${s.sub_name}" → yield ${s.yield_amount} g / portion${prevStr}  (summed ${s.summed} ing, skipped ${s.skipped})`)
      console.log(`        consumed e.g. by "${s.sample_consumer.recipe_name}" as ${s.sample_consumer.quantity} ${s.sample_consumer.unit}`)
    }
  }
  if (skipped.length > 0) {
    console.log(`\n  Sample SKIPPED (first 5):`)
    for (const s of skipped.slice(0, 5)) console.log(`    • "${s.sub_name}" — ${s.why}`)
  }

  if (APPLY && suggestions.length > 0) {
    console.log(`\n  APPLYING ${suggestions.length} yield writes…`)
    let ok = 0
    for (const s of suggestions) {
      const { error } = await db.from('recipes')
        .update({ yield_amount: s.yield_amount, yield_unit: s.yield_unit })
        .eq('id', s.sub_id)
      if (error) { console.error(`    "${s.sub_name}" failed: ${error.message}`); continue }
      ok++
    }
    console.log(`  Wrote: ${ok}`)
  } else if (suggestions.length > 0) {
    console.log(`\n  (DRY mode — re-run with --apply to write)`)
  }
}

console.log('\ndone')
