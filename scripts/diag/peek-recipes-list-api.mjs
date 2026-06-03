// Mirror what /api/inventory/recipes returns for the Chicce business
// so we can see exactly what the page filter receives.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const BIZ = '63ada0ac-18af-406a-8ad3-4acfd0379f2c' // Chicce
const { data: recipes, error } = await db.from('recipes')
  .select('id, name, type, menu_price, selling_price_ex_vat, vat_rate, channel, portions, yield_amount, yield_unit, notes, method, portions_per_cover, is_subrecipe, updated_at')
  .eq('business_id', BIZ).is('archived_at', null).order('name')
if (error) { console.error(error.message); process.exit(1) }
console.log(`Total recipes: ${recipes.length}`)

const DISH_TYPES = new Set(['starter','main','pasta','pizza','dessert','drink','cocktail','side'])
const isDish = (r) => r.is_subrecipe === true ? false :
  (r.selling_price_ex_vat != null && Number(r.selling_price_ex_vat) > 0)
  || (r.menu_price != null && Number(r.menu_price) > 0)
  || (r.type && DISH_TYPES.has(String(r.type).toLowerCase()))

const dishes = recipes.filter(isDish)
const subs = recipes.filter(r => !isDish(r))
console.log(`Dishes: ${dishes.length}  Subs: ${subs.length}`)

const tira = recipes.find(r => r.name === 'Classic Tiramisu Whole Tray')
if (tira) {
  console.log(`\nTiramisu Whole Tray row:`)
  console.log(`  is_subrecipe: ${tira.is_subrecipe}`)
  console.log(`  type: ${tira.type}`)
  console.log(`  selling_price_ex_vat: ${tira.selling_price_ex_vat}`)
  console.log(`  menu_price: ${tira.menu_price}`)
  console.log(`  isDish() → ${isDish(tira)}`)
}
