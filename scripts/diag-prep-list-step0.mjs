// Prep list Step 0 — investigate the existing recipes:
//   1. cost/unit health (per recipe: missing_prices + unit_mismatches)
//   2. sub-recipe nesting + shared-component map
//   3. confirm quantity-rollup is net-new (engine only does cost)
//   4. POS→recipe link presence
//
// READ-ONLY. Runs against prod with service role.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

// .env.local has mock values for dev — the real connection lives in
// .env.production.local. Use that for diagnostic scripts that read prod.
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('=')
      return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

async function recipesForBiz(businessId) {
  const { data, error } = await db
    .from('recipes')
    .select('id, name, type, portions, yield_amount, yield_unit, selling_price_ex_vat, menu_price')
    .eq('business_id', businessId)
    .is('archived_at', null)
    .order('name')
  if (error) throw error
  return data || []
}

async function ingredientsForBiz(businessId, recipeIds) {
  if (recipeIds.length === 0) return []
  const { data, error } = await db
    .from('recipe_ingredients')
    .select('id, recipe_id, product_id, subrecipe_id, quantity, unit, position, products(name), subrecipe:subrecipe_id(name)')
    .in('recipe_id', recipeIds)
    .order('position')
  if (error) throw error
  return data || []
}

function isDish(r) {
  // Mirrors /inventory/recipes isDish: price>0 OR a dish-shaped type
  if (Number(r.selling_price_ex_vat) > 0 || Number(r.menu_price) > 0) return true
  const dishTypes = ['starter','main','pasta','pizza','dessert','drink','cocktail','side']
  return dishTypes.includes(String(r.type ?? '').toLowerCase())
}

async function analyseBusiness(label, businessId) {
  console.log(`\n══════════════════════════════════════════════════════════════════`)
  console.log(`  ${label}`)
  console.log(`══════════════════════════════════════════════════════════════════`)
  const recipes = await recipesForBiz(businessId)
  if (recipes.length === 0) {
    console.log(`  no recipes`)
    return
  }
  const ings = await ingredientsForBiz(businessId, recipes.map(r => r.id))

  // Build a recipeId → ingredients map
  const ingsByRecipe = new Map()
  for (const r of recipes) ingsByRecipe.set(r.id, [])
  for (const i of ings) {
    if (ingsByRecipe.has(i.recipe_id)) ingsByRecipe.get(i.recipe_id).push(i)
  }

  // Classify dish vs sub-recipe
  const dishes  = recipes.filter(isDish)
  const subs    = recipes.filter(r => !isDish(r))

  console.log(`\n  ── Recipe counts ─────────────────────────────────────────`)
  console.log(`  total:      ${recipes.length}`)
  console.log(`  dishes:     ${dishes.length}   (priced OR dish-shaped type)`)
  console.log(`  sub-recipes:${subs.length}   (no price + not a dish type)`)

  // Nesting depth: walk each recipe, compute max sub-recipe depth
  function depth(recipeId, seen = new Set()) {
    if (seen.has(recipeId)) return 0  // cycle guard
    seen.add(recipeId)
    const ing = ingsByRecipe.get(recipeId) || []
    let max = 0
    for (const i of ing) {
      if (i.subrecipe_id) {
        const d = 1 + depth(i.subrecipe_id, new Set(seen))
        if (d > max) max = d
      }
    }
    return max
  }
  const depths = recipes.map(r => ({ name: r.name, depth: depth(r.id) }))
  const maxDepth = Math.max(0, ...depths.map(d => d.depth))
  console.log(`\n  ── Sub-recipe nesting depth ──────────────────────────────`)
  console.log(`  max depth across all recipes: ${maxDepth}`)
  for (const d of depths.filter(d => d.depth > 0).sort((a,b) => b.depth - a.depth)) {
    console.log(`     depth ${d.depth}  ${d.name}`)
  }

  // Shared sub-recipe map: which sub-recipe is referenced by how many parents
  const subUsage = new Map()  // subrecipe_id → Set(parent_recipe_id)
  for (const i of ings) {
    if (i.subrecipe_id) {
      if (!subUsage.has(i.subrecipe_id)) subUsage.set(i.subrecipe_id, new Set())
      subUsage.get(i.subrecipe_id).add(i.recipe_id)
    }
  }
  const subById = Object.fromEntries(recipes.map(r => [r.id, r]))
  const sharedSubs = [...subUsage.entries()]
    .filter(([, parents]) => parents.size >= 2)
    .map(([sid, parents]) => ({
      sub: subById[sid]?.name ?? sid.slice(0,8),
      parents: [...parents].map(pid => subById[pid]?.name ?? pid.slice(0,8)),
      portions: subById[sid]?.portions,
      yield_amount: subById[sid]?.yield_amount,
      yield_unit: subById[sid]?.yield_unit,
    }))
  console.log(`\n  ── Shared sub-recipes (aggregation payoff) ───────────────`)
  console.log(`  total sub-recipes referenced: ${subUsage.size}`)
  console.log(`  shared (used by ≥2 dishes):   ${sharedSubs.length}`)
  for (const s of sharedSubs.sort((a,b) => b.parents.length - a.parents.length)) {
    const yieldStr = s.yield_amount && s.yield_unit
      ? `${s.yield_amount}${s.yield_unit}/portion`
      : `portions=${s.portions} (NO YIELD)`
    console.log(`     ${s.sub.padEnd(40)} used by ${s.parents.length} dishes · ${yieldStr}`)
    console.log(`        → ${s.parents.join(', ')}`)
  }

  // Unit health: per ingredient, does the unit reconcile?
  // - product ingredient with unit X needs a product whose pack/invoice unit
  //   canonicalises into the same family as X (mass/volume/count).
  // - sub-recipe ingredient: if unit != 'portion', the sub MUST have a yield
  //   set in a family-compatible unit, else it'll surface as unit_mismatch.
  // We don't fully reimplement the engine; flag the structural cases.
  const unitFamily = (u) => {
    if (!u) return 'unknown'
    const x = u.toLowerCase().trim()
    if (['g','gr','gram','grams','kg','kilo','kilogram'].includes(x)) return 'mass'
    if (['ml','cl','dl','l','liter','litre','ltr','lit'].includes(x)) return 'volume'
    if (['st','styck','stk','ea','each','portion','port'].includes(x)) return 'count'
    return 'unknown'
  }
  const recipeFlags = []
  for (const r of recipes) {
    const ing = ingsByRecipe.get(r.id) || []
    const flags = []
    for (const i of ing) {
      if (i.subrecipe_id) {
        // Sub-recipe ref — check yield compatibility
        const sub = subById[i.subrecipe_id]
        const reqFamily = unitFamily(i.unit)
        if (reqFamily === 'count') {
          // requesting portions — always OK if sub has portions
          continue
        }
        // requesting mass/volume — sub must have yield + same family
        if (!sub?.yield_amount || !sub?.yield_unit) {
          flags.push(`sub-recipe "${sub?.name}" consumed in ${i.unit} but has no yield set`)
          continue
        }
        const yieldFamily = unitFamily(sub.yield_unit)
        if (reqFamily !== yieldFamily && reqFamily !== 'unknown' && yieldFamily !== 'unknown') {
          flags.push(`sub-recipe "${sub?.name}" yield is ${sub.yield_unit} but recipe asks for ${i.unit}`)
        }
      }
      // We don't check product-level unit-mismatch here — that needs price
      // data which the prep list doesn't care about. We only flag the
      // structural issues that WOULD produce a wrong prep quantity.
    }
    if (flags.length > 0) recipeFlags.push({ recipe: r.name, flags })
  }
  console.log(`\n  ── Unit-health flags (would affect prep quantities) ──────`)
  if (recipeFlags.length === 0) {
    console.log(`  no flagged recipes — all sub-recipe units reconcile (or use portions)`)
  } else {
    for (const r of recipeFlags) {
      console.log(`     ${r.recipe}`)
      for (const f of r.flags) console.log(`        ! ${f}`)
    }
  }

  // POS link
  const recipeIds = recipes.map(r => r.id)
  const { data: linked } = await db
    .from('pos_menu_items')
    .select('id, name, recipe_id, pos_provider')
    .eq('business_id', businessId)
    .in('recipe_id', recipeIds)
  console.log(`\n  ── POS→recipe link (demand upgrade reservoir) ────────────`)
  if (!linked || linked.length === 0) {
    console.log(`  zero pos_menu_items pointing at these recipes — demand-prediction would need owner mapping`)
  } else {
    console.log(`  ${linked.length} pos_menu_items linked to recipes:`)
    for (const l of linked.slice(0, 20)) {
      console.log(`     ${l.pos_provider.padEnd(10)} ${l.name}`)
    }
  }
}

await analyseBusiness('CHICCE', CHICCE)
await analyseBusiness('VERO',   VERO)

console.log('\n══════════════════════════════════════════════════════════════════')
console.log('  Engine: quantity-rollup vs cost-rollup')
console.log('══════════════════════════════════════════════════════════════════')
console.log(`
  Looked at lib/inventory/recipe-cost.ts:
    - loadRecipeIndex builds the graph (recipes → ingredients → sub-recipes)
    - computeRecipeCost walks it recursively with ancestor cycle-guard
    - BUT the walker returns RecipeCostSummary {food_cost, ingredients, ...}
      — it accumulates money, never quantity. The sub-recipe branch
      converts qty → per-portion cost via yield, then discards the qty.
    - wouldCreateCycle is a pure topology walker (no cost, no qty) — can
      be reused for the prep walker's cycle guard.

  Verdict: quantity-rollup IS net-new. Build an aggregatePrepRequirements
  walker that mirrors computeRecipeCost's recursion + cycle guard but
  accumulates a Map<product_id|subrecipe_id, {qty_in_base_unit, unit}>.
  Same yield-conversion math as the cost engine; same honest-incomplete
  rule on unit-mismatch.
`)
