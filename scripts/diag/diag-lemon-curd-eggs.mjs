// What is the actual product for ÄGG LV FRIGÅENDE M 30P, and would the
// MS-driven pack resolution fix the Lemon Curd cost mismatch?
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

const { data: prods } = await db.from('products')
  .select('id, name, pack_size, base_unit, pack_source, invoice_unit, default_supplier_name')
  .eq('business_id', CHICCE)
  .ilike('name', '%ägg%frig%')
  .is('archived_at', null)
console.log('Products matching "ägg frig" at Chicce:')
for (const p of prods ?? []) {
  console.log(`  ${p.id.slice(0,8)} "${p.name}" pack=${p.pack_size ?? '∅'} ${p.base_unit ?? '∅'} (${p.pack_source ?? '∅'}) invoice_unit=${p.invoice_unit ?? '∅'}`)
}

console.log('\nLemon Curd recipe ingredients:')
const { data: recipe } = await db.from('recipes')
  .select('id, name')
  .eq('business_id', CHICCE)
  .ilike('name', '%lemon%curd%')
  .maybeSingle()
if (recipe) {
  console.log(`  ${recipe.id.slice(0,8)} "${recipe.name}"`)
  const { data: ings } = await db.from('recipe_ingredients')
    .select('product_id, qty, unit, products!inner(name, pack_size, base_unit, pack_source, invoice_unit)')
    .eq('recipe_id', recipe.id)
  for (const i of ings ?? []) {
    const p = i.products
    console.log(`    qty=${i.qty} ${i.unit} of "${p.name}" pack=${p.pack_size ?? '∅'} ${p.base_unit ?? '∅'} (${p.pack_source})`)
  }
}

console.log('\nMS supplier_articles for egg products:')
const { data: arts } = await db.from('supplier_articles')
  .select('article_number, official_name, unit, net_weight_g, units_per_pack, units_per_pack_label, fetch_status')
  .eq('supplier_fortnox_number', '58264631')
  .or('article_number.in.(435602,589473,144433,573618,216655,101002,124480)')
for (const a of arts ?? []) {
  console.log(`  art=${a.article_number} "${a.official_name}" unit=${a.unit} net=${a.net_weight_g}g label="${a.units_per_pack_label}"`)
}
