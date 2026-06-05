import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>{const[k,...v]=l.split('=');return[k.trim(),v.join('=').trim().replace(/^['"]|['"]$/g,'')]}))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const { computeRecipeCost, loadRecipeIndex, getProductLatestPrices } = await import('../../lib/inventory/recipe-cost.ts')
const { loadFxIndex } = await import('../../lib/inventory/fx.ts')

const C = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const targets = ['Salmon Tartar', 'Stracciatella', 'Chevre Pasta']

const fx = await loadFxIndex(db, ['EUR','USD','NOK','DKK','GBP'])
const idx = await loadRecipeIndex(db, C)
console.log('index size:', idx.size)

// Look up names
const recipeIds = Array.from(idx.keys())
const nameById = new Map()
for (let i = 0; i < recipeIds.length; i += 200) {
  const { data } = await db.from('recipes').select('id, name').in('id', recipeIds.slice(i, i+200))
  for (const r of data ?? []) nameById.set(r.id, r.name)
}

const allProductIds = new Set()
for (const [_, entry] of idx) for (const ing of entry.ingredients ?? []) if (ing.product_id) allProductIds.add(ing.product_id)
const priceMap = await getProductLatestPrices(db, C, Array.from(allProductIds), fx)
console.log('priceMap size:', priceMap.size)

for (const q of targets) {
  let found = false
  for (const [rid, entry] of idx) {
    const name = nameById.get(rid) ?? ''
    if (name.toLowerCase().includes(q.toLowerCase())) {
      const cost = computeRecipeCost(entry.ingredients, priceMap, null, { recipeIndex: idx, recipeId: rid })
      console.log(`\n${name}: food_cost=${cost.food_cost.toFixed(2)} kr · missing=${cost.missing_prices} · unit_mm=${cost.unit_mismatches}`)
      for (const ing of cost.ingredients) {
        const flag = ing.no_price ? 'NO_PRICE' : ing.unit_mismatch ? 'UNIT_MM' : ing.cycle ? 'CYCLE' : null
        if (flag) {
          const subName = ing.subrecipe_id ? nameById.get(ing.subrecipe_id) : null
          console.log(`  !! ${ing.quantity} ${ing.unit ?? '?'} | ${subName ?? ing.product_id?.slice(0,8) ?? '?'} | ${flag} | line=${ing.line_cost}`)
        }
      }
      found = true
      break
    }
  }
  if (!found) console.log('  NOT FOUND:', q)
}
