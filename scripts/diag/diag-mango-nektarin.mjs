// Check why Mango Vinaigrette's ingredients and Nektarin's uses are empty
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

// 1. Mango Vinaigrette recipe
console.log('── MANGO VINAIGRETTE recipe lookup:')
const { data: mango } = await db
  .from('recipes')
  .select('id, name, business_id, archived_at, yield_amount, yield_unit, method, notes')
  .eq('business_id', CHICCE)
  .ilike('name', '%mango%vinaigrette%')
for (const r of mango ?? []) {
  console.log(`   ${r.id} · ${r.name} · archived=${r.archived_at} · yield=${r.yield_amount}${r.yield_unit}`)
  console.log(`   method: ${JSON.stringify(r.method)?.slice(0,100)}`)
  console.log(`   notes:  ${JSON.stringify(r.notes)?.slice(0,100)}`)
}

if (mango && mango.length > 0) {
  console.log(`\n── recipe_ingredients for Mango Vinaigrette:`)
  const { data: ings } = await db
    .from('recipe_ingredients')
    .select('id, recipe_id, product_id, subrecipe_id, quantity, unit, notes, position, products(name), subrecipe:subrecipe_id(name)')
    .eq('recipe_id', mango[0].id)
    .order('position')
  console.log(`   count: ${(ings ?? []).length}`)
  for (const i of ings ?? []) {
    const ref = i.product_id ? `product ${(i.products?.name) ?? i.product_id.slice(0,8)}` : `sub ${(i.subrecipe?.name) ?? i.subrecipe_id?.slice(0,8)}`
    console.log(`   #${i.position} ${i.quantity}${i.unit ?? ''} ${ref} · notes=${JSON.stringify(i.notes)}`)
  }
}

// 2. Nektarin product
console.log('\n\n── NEKTARIN product lookup:')
const { data: nek } = await db
  .from('products')
  .select('id, name, business_id')
  .eq('business_id', CHICCE)
  .ilike('name', '%nektarin%')
for (const p of nek ?? []) console.log(`   ${p.id} · ${p.name}`)

for (const p of nek ?? []) {
  console.log(`\n── recipe_ingredients for ${p.name}:`)
  const { data: ris } = await db
    .from('recipe_ingredients')
    .select('id, recipe_id, product_id, quantity, unit, notes')
    .eq('product_id', p.id)
  console.log(`   count: ${(ris ?? []).length}`)
  for (const r of ris ?? []) {
    const { data: rec } = await db
      .from('recipes')
      .select('id, name, business_id, archived_at')
      .eq('id', r.recipe_id)
      .maybeSingle()
    console.log(`   recipe ${rec?.name ?? '?'} (biz=${rec?.business_id?.slice(0,8)}, archived=${rec?.archived_at})  qty=${r.quantity}${r.unit ?? ''} notes=${JSON.stringify(r.notes)}`)
  }
}

// 3. Confirm what the prep-list endpoint's two-step query returns
if (nek && nek.length > 0) {
  console.log(`\n── Simulating two-step query for Nektarin:`)
  const { data: bizRecipes } = await db
    .from('recipes')
    .select('id, name')
    .eq('business_id', CHICCE)
    .is('archived_at', null)
  const bizRecipeIds = (bizRecipes ?? []).map(r => r.id)
  console.log(`   bizRecipeIds count: ${bizRecipeIds.length}`)
  const productIds = nek.map(p => p.id)
  const { data: ris } = await db
    .from('recipe_ingredients')
    .select('id, recipe_id, product_id, quantity, unit, notes')
    .in('product_id', productIds)
    .in('recipe_id', bizRecipeIds)
  console.log(`   ris rows: ${(ris ?? []).length}`)
  for (const r of ris ?? []) {
    const rec = (bizRecipes ?? []).find(b => b.id === r.recipe_id)
    console.log(`     ${rec?.name ?? '?'}: ${r.quantity}${r.unit ?? ''} · notes=${JSON.stringify(r.notes)}`)
  }
}
