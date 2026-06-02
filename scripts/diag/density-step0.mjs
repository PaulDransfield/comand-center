// Density resolver — Step 0.
//
// Find recipe-referenced products where:
//   recipe ingredient unit family != product base_unit family
//   AND both ∈ {mass, volume}
//   AND product has pack_size/base_unit set (otherwise it's a Phase A
//   problem, not a density problem)
//
// These are the products that need density to convert g↔ml.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

function unitFamily(unit) {
  if (!unit) return null
  const u = String(unit).trim().toLowerCase()
  if (['g','kg','hg','gram','grams','gr','kilo','kilogram','kilograms','hekto','hektogram'].includes(u)) return 'mass'
  if (['ml','cl','dl','l','eg','milliliter','centiliter','deciliter','liter','litre','lt','lf'].includes(u)) return 'volume'
  if (['st','styck','stk','pcs','frp','fp','pack','paket','burk','flaska'].includes(u)) return 'count'
  return null
}

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)

  // 1. Every recipe id in business.
  const recipeIds = []
  let from = 0
  while (true) {
    const { data, error } = await db.from('recipes')
      .select('id').eq('business_id', biz.id).order('id').range(from, from + 999)
    if (error) { console.error(error.message); break }
    if (!data || data.length === 0) break
    for (const r of data) recipeIds.push(r.id)
    if (data.length < 1000) break
    from += 1000
  }

  // 2. Recipe_ingredients for those recipes.
  const ingredients = []
  for (let i = 0; i < recipeIds.length; i += 100) {
    const slice = recipeIds.slice(i, i + 100)
    const { data, error } = await db.from('recipe_ingredients')
      .select('product_id, unit, recipe_id, quantity')
      .in('recipe_id', slice)
      .not('product_id', 'is', null)
    if (error) { console.error(error.message); continue }
    ingredients.push(...(data ?? []))
  }
  console.log(`  recipe ingredients linked to a product: ${ingredients.length}`)

  // 3. Fetch products for those product_ids.
  const productIds = [...new Set(ingredients.map(i => i.product_id))]
  const products = new Map()
  for (let i = 0; i < productIds.length; i += 100) {
    const slice = productIds.slice(i, i + 100)
    const { data, error } = await db.from('products')
      .select('id, name, category, invoice_unit, pack_size, base_unit')
      .in('id', slice)
    if (error) { console.error(error.message); continue }
    for (const p of data ?? []) products.set(p.id, p)
  }

  // 4. Find density gap.
  const densityGap = []
  for (const ing of ingredients) {
    const p = products.get(ing.product_id)
    if (!p) continue
    if (p.pack_size == null || p.base_unit == null) continue   // Phase A territory
    const recipeFamily = unitFamily(ing.unit)
    const baseFamily   = unitFamily(p.base_unit)
    if (!recipeFamily || !baseFamily) continue
    if (recipeFamily === baseFamily) continue   // no conversion needed
    if (!(recipeFamily === 'mass' && baseFamily === 'volume') &&
        !(recipeFamily === 'volume' && baseFamily === 'mass')) continue
    densityGap.push({
      product_id:    p.id,
      name:          p.name,
      category:      p.category,
      base_unit:     p.base_unit,
      pack_size:     p.pack_size,
      recipe_unit:   ing.unit,
      recipe_qty:    ing.quantity,
    })
  }

  // Dedupe by product (one product may appear in multiple recipes).
  const byProduct = new Map()
  for (const g of densityGap) {
    if (!byProduct.has(g.product_id)) byProduct.set(g.product_id, g)
  }

  console.log(`  products with mass↔volume density gap: ${byProduct.size}`)
  console.log(`\n  Sample (the LLM job):`)
  for (const g of [...byProduct.values()].slice(0, 20)) {
    console.log(`    • "${g.name}"`)
    console.log(`        category=${g.category} · product is ${g.pack_size} ${g.base_unit} · recipe asks for ${g.recipe_qty} ${g.recipe_unit}`)
  }
}

console.log('\ndone')
