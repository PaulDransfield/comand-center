#!/usr/bin/env node
// Phase 0 cost trace using the REAL engine (lib/inventory/recipe-cost.ts)
// rather than the rough hand-math from earlier. For each priced recipe
// at Chicce + Vero: print the costed ingredient list, line costs, total
// food cost, GP %, and call out any unit_mismatch / missing-price flags.

import { readFileSync } from 'node:fs'
function parseEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter(l => l.includes('=') && !l.trim().startsWith('#'))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
    )
  } catch { return {} }
}
const fileEnv = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
for (const [k, v] of Object.entries(fileEnv)) {
  if (!(k in process.env) || /^mock_|^https:\/\/mock-/.test(process.env[k] ?? '')) process.env[k] = v
}

const { createClient } = await import('@supabase/supabase-js')
const {
  computeRecipeCost,
  getProductLatestPrices,
  loadRecipeIndex,
} = await import('../lib/inventory/recipe-cost.ts')
const { loadFxIndex } = await import('../lib/inventory/fx.ts')

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const BIZES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

for (const biz of BIZES) {
  console.log(`\n\n========== ${biz.name} ==========\n`)

  const recipeIndex = await loadRecipeIndex(db, biz.id)
  const allProductIds = new Set()
  for (const e of recipeIndex.values()) {
    for (const ing of e.ingredients) if (ing.product_id) allProductIds.add(ing.product_id)
  }
  const fxIndex = await loadFxIndex(db, ['EUR', 'USD', 'NOK', 'DKK', 'GBP'])
  const priceMap = await getProductLatestPrices(db, biz.id, Array.from(allProductIds), fxIndex)

  // Recipe headers (including sub-recipes)
  const { data: recipes } = await db
    .from('recipes')
    .select('id, name, type, portions, selling_price_ex_vat, vat_rate, channel, yield_amount, yield_unit')
    .eq('business_id', biz.id)
    .is('archived_at', null)

  // Get product names for the trace output
  const { data: products } = await db
    .from('products')
    .select('id, name, base_unit, pack_size, default_waste_pct, category')
    .in('id', Array.from(allProductIds))
  const nameById = new Map((products ?? []).map(p => [p.id, p]))

  for (const r of recipes ?? []) {
    const isSub = r.selling_price_ex_vat == null || Number(r.selling_price_ex_vat) === 0
    const entry = recipeIndex.get(r.id)
    if (!entry) continue
    const summary = computeRecipeCost(entry.ingredients, priceMap, null, {
      recipeIndex,
      recipeId: r.id,
    })

    console.log(`--- ${r.name} ${isSub ? '(SUB-RECIPE)' : ''} ---`)
    console.log(`    portions=${r.portions}  yield=${r.yield_amount ?? '—'} ${r.yield_unit ?? ''}  price_ex_vat=${r.selling_price_ex_vat ?? '—'} ${r.channel ?? ''}@${r.vat_rate ?? '?'}%`)
    console.log(`    food_cost=${summary.food_cost.toFixed(2)} SEK  missing_prices=${summary.missing_prices}  unit_mismatches=${summary.unit_mismatches}`)

    for (const ing of summary.ingredients) {
      const label = ing.is_subrecipe
        ? `↳ sub: ${entry.ingredients.find(i => i.id === ing.id)?.subrecipe_id?.slice(0, 8) ?? '?'}`
        : (nameById.get(ing.product_id)?.name ?? '?').slice(0, 50)
      const flags = []
      if (ing.no_price)      flags.push('NO PRICE')
      if (ing.unit_mismatch) flags.push('UNIT MISMATCH')
      if (ing.cycle)         flags.push('CYCLE')
      const flagStr = flags.length ? `  [${flags.join(', ')}]` : ''
      console.log(`      ${ing.quantity_stated ?? ing.quantity} ${ing.unit ?? '?'}  ${label}  →  ${ing.line_cost != null ? `${ing.line_cost.toFixed(2)} kr` : '—'}${flagStr}`)
    }

    if (!isSub) {
      const sellingExVat = Number(r.selling_price_ex_vat ?? 0)
      const foodPct = sellingExVat > 0 ? (summary.food_cost / sellingExVat) * 100 : null
      const gpKr    = sellingExVat - summary.food_cost
      const gpPct   = sellingExVat > 0 ? (gpKr / sellingExVat) * 100 : null
      console.log(`    >>> selling ex-VAT=${sellingExVat.toFixed(2)} kr | food %=${foodPct?.toFixed(1) ?? '—'}% | GP=${gpKr.toFixed(2)} kr | GP %=${gpPct?.toFixed(1) ?? '—'}%`)
    }
    console.log('')
  }
}
