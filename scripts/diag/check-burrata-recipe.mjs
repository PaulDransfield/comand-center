import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local', 'utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const BIZ = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Find the Burrata recipe
const { data: recs } = await db.from('recipes').select('id, name, portions, archived_at').eq('business_id', BIZ).ilike('name', '%Burrata with Grilled%')
console.log('Recipes:')
for (const r of recs ?? []) console.log(`  ${r.id}  "${r.name}"  portions=${r.portions}  archived=${r.archived_at ? 'Y' : 'N'}`)

if (recs && recs.length > 0) {
  const recipeId = recs[0].id
  console.log('\nIngredients for', recipeId)
  const { data: ings } = await db.from('recipe_ingredients')
    .select('id, product_id, subrecipe_id, quantity, quantity_stated, unit, waste_pct, position')
    .eq('recipe_id', recipeId).order('position')
  for (const i of ings ?? []) {
    console.log(`  ing ${i.id}  qty=${i.quantity}  qty_stated=${i.quantity_stated}  unit="${i.unit}"  waste=${i.waste_pct}  product=${i.product_id}  subrecipe=${i.subrecipe_id}`)
  }

  // Look up sub-recipes specifically
  const subIds = (ings ?? []).map(i => i.subrecipe_id).filter(Boolean)
  if (subIds.length > 0) {
    console.log('\nSub-recipe details:')
    const { data: subs } = await db.from('recipes').select('id, name, portions, yield_amount, yield_unit, archived_at').in('id', subIds)
    for (const s of subs ?? []) console.log(`  ${s.id}  "${s.name}"  portions=${s.portions}  yield=${s.yield_amount} ${s.yield_unit}  archived=${s.archived_at ? 'Y' : 'N'}`)
  }
}
