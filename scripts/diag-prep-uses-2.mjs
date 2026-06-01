// Test variations of the two-step query to find what actually works
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
const CARCIOFI = 'a8760a24-70e5-48ed-8e17-53c9e181630d'

const { data: bizRecipes } = await db
  .from('recipes')
  .select('id')
  .eq('business_id', CHICCE)
  .is('archived_at', null)
const bizRecipeIds = (bizRecipes ?? []).map(r => r.id)
console.log(`bizRecipeIds: ${bizRecipeIds.length} ids`)
console.log(`First 3:`, bizRecipeIds.slice(0, 3))

// Test 1: just .in product_id (single-element array)
let q1 = await db
  .from('recipe_ingredients')
  .select('id, recipe_id, product_id, notes')
  .in('product_id', [CARCIOFI])
console.log(`\nT1: .in product_id only → ${(q1.data ?? []).length} rows`)
for (const r of q1.data ?? []) console.log(`   ${r.recipe_id.slice(0,8)} · notes=${JSON.stringify(r.notes)}`)

// Test 2: .eq product_id + .in recipe_id
let q2 = await db
  .from('recipe_ingredients')
  .select('id, recipe_id, product_id, notes')
  .eq('product_id', CARCIOFI)
  .in('recipe_id', bizRecipeIds)
console.log(`\nT2: .eq product_id + .in recipe_id → ${(q2.data ?? []).length} rows`)
if (q2.error) console.log(`   ERROR: ${q2.error.message}`)

// Test 3: .in product_id + .in recipe_id (the failing case)
let q3 = await db
  .from('recipe_ingredients')
  .select('id, recipe_id, product_id, notes')
  .in('product_id', [CARCIOFI])
  .in('recipe_id', bizRecipeIds)
console.log(`\nT3: .in product_id + .in recipe_id → ${(q3.data ?? []).length} rows`)
if (q3.error) console.log(`   ERROR: ${q3.error.message}`)

// Test 4: same but with just 5 recipe ids
let q4 = await db
  .from('recipe_ingredients')
  .select('id, recipe_id, product_id, notes')
  .in('product_id', [CARCIOFI])
  .in('recipe_id', bizRecipeIds.slice(0, 5))
console.log(`\nT4: .in product_id + .in recipe_id (5 ids) → ${(q4.data ?? []).length} rows`)

// Test 5: what if we put Carciofi's parent recipe id alone
const PARENT = '60495727-fb89-4d3d-9b33-26b08fd0b4f3'
let q5 = await db
  .from('recipe_ingredients')
  .select('id, recipe_id, product_id, notes')
  .in('product_id', [CARCIOFI])
  .in('recipe_id', [PARENT])
console.log(`\nT5: .in product_id + .in [parent_recipe_id] → ${(q5.data ?? []).length} rows`)

// Test 6: what's the actual parent id we should use
const { data: par } = await db
  .from('recipes')
  .select('id, name, business_id, archived_at')
  .eq('id', PARENT)
  .maybeSingle()
console.log(`\nT6: parent recipe lookup:`, par)
