#!/usr/bin/env node
// READ-ONLY characterisation of products that have NO product_aliases
// rows. Aliases are how the cost engine reaches supplier_invoice_lines,
// so a product without aliases is effectively cost-orphaned: it can be
// linked to recipes but the engine has no price path.
//
// Surfaced by the Vero Pinsa Magherita Phase 0 trace (Salt Fint M Jod
// 12,5kg — product 832e3aeb at Vero). Question: is this a class bug
// (many products affected) or an accident (just this one)?

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
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY

const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }
async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: h })
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

const BIZES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

for (const biz of BIZES) {
  console.log(`\n========== ${biz.name} ==========`)

  // Pull product count + aliased-product count.
  const totalProducts = (await q(`products?business_id=eq.${biz.id}&select=count`))[0]?.count ?? 0

  // Aliased = at least 1 product_alias row that points to it
  // (joining via product_aliases.product_id).
  const aliasedRows = await q(`product_aliases?business_id=eq.${biz.id}&select=product_id&product_id=not.is.null`)
  const aliasedSet  = new Set(aliasedRows.map(r => r.product_id))
  console.log(`  products total      : ${totalProducts}`)
  console.log(`  products w/ aliases : ${aliasedSet.size}`)
  console.log(`  products w/o aliases: ${totalProducts - aliasedSet.size}`)

  // List the orphaned products (paginate gently — 200 max).
  // PostgREST not.in.(...) needs IDs comma-joined; cap at first 200
  // products to avoid URL length issues.
  const all = await q(`products?business_id=eq.${biz.id}&select=id,name,category,base_unit,pack_size,created_at&order=created_at.desc&limit=500`)
  const orphans = all.filter(p => !aliasedSet.has(p.id))
  console.log(`  orphan sample (showing up to 20):`)
  for (const p of orphans.slice(0, 20)) {
    console.log(`    ${p.id.slice(0, 8)}  ${p.name?.slice(0, 60).padEnd(60)} ${p.category?.padEnd(10)} ${p.base_unit ?? '?'}  pack=${p.pack_size ?? '?'}  created=${p.created_at?.slice(0, 10)}`)
  }
  if (orphans.length > 20) console.log(`    ... ${orphans.length - 20} more orphans`)

  // Are they referenced from recipes?
  if (orphans.length > 0) {
    const ids = orphans.slice(0, 100).map(p => p.id).join(',')
    const ingsUsing = await q(`recipe_ingredients?product_id=in.(${ids})&select=product_id,recipe:recipe_id(name,business_id)`)
    const reffedSet = new Set(ingsUsing.map(i => i.product_id))
    console.log(`  orphans referenced in recipes: ${reffedSet.size} of ${orphans.length}`)
    for (const ing of ingsUsing.slice(0, 10)) {
      const p = orphans.find(o => o.id === ing.product_id)
      console.log(`    ${p?.name?.slice(0, 50)} ← ${ing.recipe?.name ?? '?'} (biz ${ing.recipe?.business_id?.slice(0, 8)})`)
    }
  }

  // For comparison: how many products have at least one supplier_invoice_line
  // matching their name? If lots of orphans have a name-matching invoice
  // line, this is a matcher backlog issue — the line exists but the alias
  // pointing the product to it was never created.
  console.log('')
}
