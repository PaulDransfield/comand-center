// Surface piece-unit products (base_unit='st') that are referenced by
// recipes in grams/ml but have no weight_per_piece_g set. That's the
// Sallad Roman 10st class: chef wants 60 g of lettuce but the catalogue
// only knows "10 heads in a carton" — no per-head gram weight means
// the cost engine can't convert, and the recipe row shows "0 kr" or
// "no price observed".
//
// Read-only. Output ranked by recipe-impact (how many recipes are
// affected by each gap).

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)

  // 1. Piece-unit products with no weight_per_piece_g
  let from = 0
  const products = []
  while (true) {
    const { data, error } = await db.from('products')
      .select('id, name, pack_size, base_unit, invoice_unit, weight_per_piece_g')
      .eq('business_id', biz.id).is('archived_at', null)
      .eq('base_unit', 'st').is('weight_per_piece_g', null)
      .order('id').range(from, from + 999)
    if (error) {
      if (/weight_per_piece_g/.test(error.message)) {
        console.log(`  M122 not applied? ${error.message}`)
        break
      }
      console.error(error.message); break
    }
    if (!data?.length) break
    products.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  console.log(`  Piece-unit products without weight_per_piece_g: ${products.length}`)

  if (products.length === 0) continue

  const productIds = products.map(p => p.id)
  const productById = new Map(products.map(p => [p.id, p]))

  // 2. Recipe ingredients referencing these products with a non-st unit
  //    (the conversion-needed cases).
  const recipesByProduct = new Map() // pid -> Set of recipe_id
  for (let i = 0; i < productIds.length; i += 100) {
    const slice = productIds.slice(i, i + 100)
    const { data } = await db.from('recipe_ingredients')
      .select('recipe_id, product_id, unit, quantity')
      .in('product_id', slice)
    for (const ri of data ?? []) {
      const u = (ri.unit ?? '').toLowerCase()
      const needsConversion = u && u !== 'st' && u !== 'styck'
      if (!needsConversion) continue
      const s = recipesByProduct.get(ri.product_id) ?? new Set()
      s.add(ri.recipe_id)
      recipesByProduct.set(ri.product_id, s)
    }
  }

  // 3. Filter to products that are actually mis-used (referenced by weight).
  const flagged = products
    .map(p => ({ ...p, recipeCount: (recipesByProduct.get(p.id) ?? new Set()).size }))
    .filter(p => p.recipeCount > 0)
    .sort((a, b) => b.recipeCount - a.recipeCount)

  console.log(`  Referenced by recipes in non-st units: ${flagged.length}`)
  console.log(`\n  Top 30 by recipe-impact:`)
  for (const p of flagged.slice(0, 30)) {
    console.log(`    [${String(p.recipeCount).padStart(2)} recipes]  pack=${String(p.pack_size).padEnd(4)} inv=${String(p.invoice_unit ?? '∅').padEnd(8)}  "${p.name?.slice(0,55)}"`)
  }
  if (flagged.length > 30) console.log(`    …+${flagged.length - 30} more`)
}
