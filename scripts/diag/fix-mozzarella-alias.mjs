// Repoint the alias that maps line "Mozzarella per pizza Julienne"
// (raw_description, NOT FRYST) from the FRYST product to the non-FRYST
// product at Chicce.
//
// Investigation context:
//   - Alias 00b80bd8-1ea3-474b-abe2-72ddb775870f currently → product
//     18745958-3846-4a97-8b71-4705bef76ff6 ("...FRYST")
//   - Should → product 5bc4a519... ("Mozzarella per pizza Julienne", no FRYST)
//
// This script:
//   1. Reads BOTH product names to confirm they're still as expected.
//   2. Verifies the alias is currently bound to the FRYST one.
//   3. Confirms the new target has the same business (cross-tenant guard).
//   4. Writes the repoint.
//   5. Optionally backfills any other lines linked via THIS alias so they
//      all flow to the correct product without invalidating the alias.
//
// Default DRY. --apply to write.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const APPLY = process.argv.includes('--apply')

const ALIAS_ID    = '00b80bd8-1ea3-474b-abe2-72ddb775870f'
const FROM_PROD   = '18745958-3846-4a97-8b71-4705bef76ff6'   // "...FRYST"
const TO_PROD     = '5bc4a519'                                // resolve full id below

// 1. Pull the alias + verify state
const { data: alias } = await db.from('product_aliases')
  .select('id, product_id, business_id, normalized_description, supplier_name_snapshot, match_method')
  .eq('id', ALIAS_ID).maybeSingle()
if (!alias) { console.error('Alias not found'); process.exit(1) }
console.log(`Alias:                ${alias.id}`)
console.log(`Current product_id:   ${alias.product_id}`)
console.log(`Supplier:             ${alias.supplier_name_snapshot}`)
console.log(`Match method:         ${alias.match_method}`)

if (alias.product_id !== FROM_PROD) {
  console.log(`\nAlias is NOT pointing at the FRYST product right now — already fixed? Aborting.`)
  process.exit(0)
}

// 2. Resolve full TO_PROD id by prefix + name match
const { data: candidates } = await db.from('products')
  .select('id, name, business_id, archived_at')
  .ilike('id', `${TO_PROD}%`)
const toProd = (candidates ?? []).find(p => p.archived_at == null && /^Mozzarella per pizza Julienne$/i.test(p.name))
if (!toProd) {
  console.error(`Cannot find a non-FRYST "Mozzarella per pizza Julienne" with id starting ${TO_PROD}`)
  process.exit(1)
}
console.log(`\nTarget product:       ${toProd.id}  "${toProd.name}"`)

const { data: fromProd } = await db.from('products').select('id, name, business_id').eq('id', FROM_PROD).maybeSingle()
console.log(`Current product:      ${fromProd?.id}  "${fromProd?.name}"`)

// 3. Cross-tenant guard
if (alias.business_id !== toProd.business_id) {
  console.error(`Business mismatch — alias=${alias.business_id} target=${toProd.business_id}`)
  process.exit(1)
}

// 4. How many lines flow through this alias?
const { count: lineCount } = await db.from('supplier_invoice_lines')
  .select('*', { count: 'exact', head: true })
  .eq('product_alias_id', alias.id)
console.log(`\nLines linked via this alias: ${lineCount}`)

if (!APPLY) {
  console.log(`\n(DRY — re-run with --apply to repoint)`)
  process.exit(0)
}

// 5. Apply
console.log(`\nRepointing alias → product ${toProd.id}…`)
const { error } = await db.from('product_aliases')
  .update({ product_id: toProd.id })
  .eq('id', alias.id)
if (error) {
  console.error(`Update failed: ${error.message}`)
  process.exit(1)
}
console.log('Done.')
