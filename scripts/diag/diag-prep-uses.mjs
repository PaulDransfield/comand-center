// Diagnose why the prep modal shows "Not used in any recipe yet" for
// Carciofi product. Mirrors exactly what /api/inventory/prep-list does.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// 1. Find the Carciofi product
const { data: prods } = await db
  .from('products')
  .select('id, name, business_id')
  .eq('business_id', CHICCE)
  .ilike('name', '%carciofi%alla%romana%')
console.log('── PRODUCTS matching "carciofi alla romana":')
for (const p of prods ?? []) console.log(`   ${p.id} · ${p.name}`)
if (!prods || prods.length === 0) {
  console.log('   none found — try broader pattern')
  const { data: prods2 } = await db
    .from('products')
    .select('id, name')
    .eq('business_id', CHICCE)
    .ilike('name', '%carciofi%')
  for (const p of prods2 ?? []) console.log(`   ${p.id} · ${p.name}`)
}

// 2. For each Carciofi product, find recipe_ingredients
for (const p of prods ?? []) {
  console.log(`\n── recipe_ingredients for ${p.name} (${p.id.slice(0,8)}):`)
  const { data: ris } = await db
    .from('recipe_ingredients')
    .select('id, recipe_id, product_id, quantity, unit, notes')
    .eq('product_id', p.id)
  for (const r of ris ?? []) {
    console.log(`   ri ${r.id.slice(0,8)} → recipe ${r.recipe_id.slice(0,8)} · qty=${r.quantity}${r.unit} · notes=${JSON.stringify(r.notes)}`)
  }
  if (!ris || ris.length === 0) {
    console.log('   NO recipe_ingredients rows at all for this product_id')
  }

  // 3. For each, check if the parent recipe is in Chicce + not archived
  const recipeIds = [...new Set((ris ?? []).map(r => r.recipe_id))]
  if (recipeIds.length > 0) {
    const { data: recipes } = await db
      .from('recipes')
      .select('id, name, business_id, archived_at')
      .in('id', recipeIds)
    console.log(`   parent recipes:`)
    for (const r of recipes ?? []) {
      const inBiz = r.business_id === CHICCE ? 'YES' : `NO (${r.business_id.slice(0,8)})`
      const archived = r.archived_at ? `ARCHIVED ${r.archived_at}` : 'active'
      console.log(`     ${r.id.slice(0,8)} · ${r.name} · biz=${inBiz} · ${archived}`)
    }
  }
}

// 4. Simulate the two-step query the endpoint actually does
const carciofiId = prods?.[0]?.id
if (carciofiId) {
  console.log(`\n── Simulating /api/inventory/prep-list two-step query:`)
  const { data: bizRecipes } = await db
    .from('recipes')
    .select('id, name')
    .eq('business_id', CHICCE)
    .is('archived_at', null)
  const bizRecipeIds = (bizRecipes ?? []).map(r => r.id)
  console.log(`   bizRecipeIds count: ${bizRecipeIds.length}`)

  const { data: ris } = await db
    .from('recipe_ingredients')
    .select('id, recipe_id, product_id, quantity, unit, notes')
    .in('product_id', [carciofiId])
    .in('recipe_id', bizRecipeIds)
  console.log(`   ris rows: ${(ris ?? []).length}`)
  for (const r of ris ?? []) {
    const recipe = (bizRecipes ?? []).find(b => b.id === r.recipe_id)
    console.log(`     ${recipe?.name ?? '?'} · qty=${r.quantity}${r.unit} · notes=${JSON.stringify(r.notes)}`)
  }
}
