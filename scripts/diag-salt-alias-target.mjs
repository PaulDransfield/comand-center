#!/usr/bin/env node
// Find what product the salt invoice-line's alias points to. If a
// different product exists for the same physical salt, that's a
// duplicate-product class bug.

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

const ALIAS_ID = '3a974bfe-38f1-49bc-b896-0b4583e59ffb'
const VERO     = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

console.log('Alias 3a974bfe:')
const alias = await q(`product_aliases?id=eq.${ALIAS_ID}&select=*`)
console.log(JSON.stringify(alias, null, 2))

if (alias[0]?.product_id) {
  console.log(`\nProduct it points to (${alias[0].product_id.slice(0, 8)}):`)
  const product = await q(`products?id=eq.${alias[0].product_id}&select=*`)
  console.log(JSON.stringify(product, null, 2))
} else {
  console.log('\n(alias has no product_id — needs matcher review or owner action)')
}

// Search for ALL salt products at Vero — see how many parallel entities exist.
console.log('\n\nAll Vero products with "salt" in name:')
const allSalt = await q(`products?business_id=eq.${VERO}&name=ilike.*salt*&select=id,name,base_unit,pack_size,created_at`)
for (const p of allSalt) console.log(`  ${p.id.slice(0, 8)}  ${p.name.padEnd(50)} created=${p.created_at?.slice(0, 10)}  pack=${p.pack_size} ${p.base_unit ?? '?'}`)

// Same for the actual normalised description that the matcher saw on the invoice line.
const normalised = alias[0]?.normalised_description
if (normalised) {
  console.log(`\nProducts matching normalised "${normalised}":`)
  const sameNorm = await q(`products?business_id=eq.${VERO}&name=ilike.*${encodeURIComponent(normalised.replace(/\s+/g, '%'))}*&select=id,name`)
  for (const p of sameNorm) console.log(`  ${p.id.slice(0, 8)}  ${p.name}`)
}
