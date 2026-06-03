// Recovery: 5 supplier_invoice_lines reference dangling product_alias_ids
// because today's dedup archived BOTH Mozzarella per pizza Julienne
// variants (FRYST + non-FRYST) at Chicce without merging into a
// canonical. There's no active target, so the cost engine can't price
// these lines and any recipe using "Mozzarella per pizza Julienne"
// shows "Incomplete cost."
//
// Plan:
//   1. Unarchive the non-FRYST product (5bc4a519...) — it already had
//      pack_size=2500g, base_unit=g which is correct.
//   2. Recreate the two aliases (00b80bd8 + f82dcde6) pointing at it,
//      with match_method='owner_linked' so the matcher never overwrites.
//   3. Re-attach the 5 orphaned lines to the recreated aliases by id.
//      Since the lines already carry the alias id (just dangling), we
//      can recreate aliases with the SAME ids — the FK will validate
//      again.
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

const BIZ        = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const PRODUCT_ID = '5bc4a519-208d-47e5-a414-f73f667843f2'   // non-FRYST canonical

// 1. Confirm product is still archived and has the right shape
const { data: prod } = await db.from('products')
  .select('id, name, business_id, archived_at, pack_size, base_unit, category')
  .eq('id', PRODUCT_ID).maybeSingle()
if (!prod) { console.error('Canonical product not found'); process.exit(1) }
console.log(`Canonical product:    ${prod.id}  "${prod.name}"`)
console.log(`  pack=${prod.pack_size} ${prod.base_unit}  category=${prod.category}  archived=${prod.archived_at}`)
if (prod.business_id !== BIZ) { console.error('Cross-tenant'); process.exit(1) }

// 2. Gather the orphaned lines (and pull supplier metadata for each)
const ALIAS_IDS = ['00b80bd8-1ea3-474b-abe2-72ddb775870f', 'f82dcde6-5544-41f1-a79b-320a7e91d4d9']
const { data: lines } = await db.from('supplier_invoice_lines')
  .select('id, business_id, product_alias_id, supplier_fortnox_number, supplier_name_snapshot, raw_description, invoice_date')
  .in('product_alias_id', ALIAS_IDS)
console.log(`\nOrphaned lines: ${lines?.length}`)

// 3. For each alias id, pick a representative (latest) line to use as the alias seed
const aliasSeed = new Map()
for (const l of (lines ?? []).sort((a,b) => b.invoice_date.localeCompare(a.invoice_date))) {
  if (aliasSeed.has(l.product_alias_id)) continue
  aliasSeed.set(l.product_alias_id, l)
}
for (const [id, l] of aliasSeed) {
  console.log(`  alias ${id}  seed line: ${l.invoice_date}  supplier=${l.supplier_name_snapshot}  desc="${l.raw_description?.slice(0,55)}"`)
}

if (!APPLY) { console.log('\n(DRY — re-run with --apply to write)'); process.exit(0) }

// 4. Unarchive the product
{
  const { error } = await db.from('products').update({ archived_at: null }).eq('id', PRODUCT_ID)
  if (error) { console.error(`Unarchive failed: ${error.message}`); process.exit(1) }
  console.log('\nProduct unarchived.')
}

// 5. Recreate aliases. Use the same ids so the existing lines' product_alias_id
//    becomes valid again — no need to UPDATE the lines.
// Need a key for normalised description. Use lib/inventory/normalise.ts pattern.
function normaliseDescription(raw) {
  return String(raw ?? '').toLowerCase().trim()
    .replace(/[^\w\såäöéàèêíîóòôúûñç\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

for (const [aliasId, seed] of aliasSeed) {
  const row = {
    id:                       aliasId,
    business_id:              BIZ,
    product_id:               PRODUCT_ID,
    supplier_fortnox_number:  seed.supplier_fortnox_number,
    supplier_name_snapshot:   seed.supplier_name_snapshot,
    raw_description:          seed.raw_description,
    normalised_description:   normaliseDescription(seed.raw_description),
    match_method:             'owner_confirmed',
    is_active:                true,
  }
  const { error } = await db.from('product_aliases').insert(row)
  if (error) {
    console.error(`Insert alias ${aliasId} failed: ${error.message}`)
    process.exit(1)
  }
  console.log(`Alias ${aliasId} recreated.`)
}

console.log('\nDone. 5 lines should now flow to the unarchived Mozzarella per pizza Julienne product.')
