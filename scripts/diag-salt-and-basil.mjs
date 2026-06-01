#!/usr/bin/env node
// Targeted check: BASILIKA 100G (Chicce) and Salt Fint M Jod 12,5kg
// (Vero) — both flagged as no-alias orphans by the broad scan, but
// BASILIKA shows clean cost in the Margherita trace. Reconcile.

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

console.log('=== BASILIKA 100G (Chicce) ===\n')
const basilika = await q(`products?name=eq.BASILIKA%20100G&business_id=eq.63ada0ac-18af-406a-8ad3-4acfd0379f2c&select=id,name,business_id,category,base_unit,pack_size,created_at`)
console.log('product:', JSON.stringify(basilika, null, 2))

if (basilika[0]) {
  // Aliases pointing at this product, regardless of business
  const allAliases = await q(`product_aliases?product_id=eq.${basilika[0].id}&select=*`)
  console.log(`\nAliases for product ${basilika[0].id.slice(0, 8)}: ${allAliases.length}`)
  for (const a of allAliases) console.log(' ', JSON.stringify(a))

  // Invoice lines referenced via those aliases
  if (allAliases.length > 0) {
    const aliasIds = allAliases.map(a => a.id).join(',')
    const lines = await q(`supplier_invoice_lines?product_alias_id=in.(${aliasIds})&select=id,business_id,raw_description,quantity,unit,total_excl_vat,invoice_date&order=invoice_date.desc&limit=3`)
    console.log(`\nRecent supplier_invoice_lines: ${lines.length}`)
    for (const l of lines) console.log(' ', JSON.stringify(l))
  }
}

console.log('\n\n=== Salt Fint M Jod 12,5kg (Vero) ===\n')
const salt = await q(`products?name=ilike.*Salt%20Fint%20M%20Jod*&business_id=eq.0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99&select=id,name,business_id,category,base_unit,pack_size,created_at`)
console.log('product(s):', JSON.stringify(salt, null, 2))

if (salt[0]) {
  const allAliases = await q(`product_aliases?product_id=eq.${salt[0].id}&select=*`)
  console.log(`\nAliases for product ${salt[0].id.slice(0, 8)}: ${allAliases.length}`)
  for (const a of allAliases) console.log(' ', JSON.stringify(a))
}

// Does Vero have any supplier_invoice_lines with "salt" in description?
console.log('\nSearch supplier_invoice_lines at Vero for "salt":')
const saltLines = await q(`supplier_invoice_lines?business_id=eq.0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99&raw_description=ilike.*salt%20fint*&select=id,raw_description,quantity,unit,total_excl_vat,product_alias_id,invoice_date&order=invoice_date.desc&limit=10`)
console.log(`  ${saltLines.length} lines match`)
for (const l of saltLines.slice(0, 5)) console.log(' ', JSON.stringify(l))

// And just "salt" broadly
const saltAny = await q(`supplier_invoice_lines?business_id=eq.0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99&raw_description=ilike.*salt*&select=id,raw_description&limit=5`)
console.log(`\n"salt" anywhere: ${saltAny.length}`)
for (const l of saltAny) console.log(' ', l.raw_description?.slice(0, 80))
