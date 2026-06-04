// Repoint mis-attributed aliases onto the correct product instead of
// deactivating them. Lines stay matched (keyed on alias.id); only
// product_aliases.product_id flips. Owner doesn't have to re-confirm
// 100 lines at /inventory/review.
//
// Targets are computed at runtime by searching the business's catalogue
// for a name containing a meaningful keyword from the alias's raw_description.
// Each candidate is logged; --apply only writes the unambiguous ones.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const APPLY = process.argv.includes('--apply')

// (business_id, alias-raw-description hint → target keyword for product search).
// Hint and target keyword are deliberately separate so we can hand-tune
// without re-parsing the raw description.
const TARGETS = [
  // Chicce
  { biz: '63ada0ac-18af-406a-8ad3-4acfd0379f2c', aliasRawMatch: 'COCA COLA BRK 33CL',     keyword: 'Coca Cola' },
  { biz: '63ada0ac-18af-406a-8ad3-4acfd0379f2c', aliasRawMatch: 'COCA COLA ZERO EG 33CL', keyword: 'Coca Cola Zero' },
  { biz: '63ada0ac-18af-406a-8ad3-4acfd0379f2c', aliasRawMatch: 'Buste di carta 32x22/24', keyword: 'carta' },
  // Vero
  { biz: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99', aliasRawMatch: 'CLEMENTINER 1,49 KG',     keyword: 'Clementin' },
]

for (const t of TARGETS) {
  console.log(`\n── ${t.aliasRawMatch}  (biz ${t.biz.slice(0,8)}, target keyword "${t.keyword}")`)

  // Find the alias (any state — re-activates if previously deactivated).
  const { data: aliases } = await db.from('product_aliases')
    .select('id, product_id, raw_description, is_active, deactivated_reason')
    .eq('business_id', t.biz)
    .eq('raw_description', t.aliasRawMatch)
  if (!aliases?.length) { console.log(`  alias not found`); continue }
  const alias = aliases[0]
  console.log(`  alias ${alias.id.slice(0,8)}  active=${alias.is_active}  currently pointing at product=${alias.product_id.slice(0,8)}`)

  // Find candidate target products.
  const { data: candidates } = await db.from('products')
    .select('id, name, pack_size, base_unit')
    .eq('business_id', t.biz).is('archived_at', null)
    .ilike('name', `%${t.keyword}%`)
    .limit(10)
  console.log(`  candidates matching "${t.keyword}": ${candidates?.length}`)
  for (const c of candidates ?? []) {
    console.log(`    ${c.id.slice(0,8)}  "${c.name}"  pack=${c.pack_size} ${c.base_unit}`)
  }
  if (!candidates?.length) { console.log(`  no candidates — owner must create the target product first`); continue }
  if (candidates.length > 1) {
    console.log(`  AMBIGUOUS — ${candidates.length} candidates. Tighten keyword.`)
    continue
  }
  const target = candidates[0]
  if (target.id === alias.product_id) { console.log(`  already pointing at the right target.`); continue }

  if (!APPLY) { console.log(`  (DRY — would repoint to ${target.id.slice(0,8)} "${target.name}")`); continue }

  // Repoint + reactivate + (if it was needs_review'd) re-confirm matched lines.
  const { error: aErr } = await db.from('product_aliases').update({
    product_id: target.id,
    is_active: true,
    deactivated_reason: null,
    deactivated_at: null,
  }).eq('id', alias.id)
  if (aErr) { console.error(`  alias update: ${aErr.message}`); continue }
  console.log(`  alias repointed to ${target.id.slice(0,8)} "${target.name}"`)

  // Lines that this fix concerns: those previously matched to this alias
  // (still product_alias_id=alias.id) AND those flipped to needs_review
  // with product_alias_id cleared during my earlier deactivation. Recover
  // the cleared ones by raw_description + supplier matching.
  const { error: l1Err, count: stillMatched } = await db.from('supplier_invoice_lines')
    .update({ match_status: 'matched' }, { count: 'exact' })
    .eq('product_alias_id', alias.id).neq('match_status', 'matched')
  if (l1Err) console.error(`  lines#1: ${l1Err.message}`)
  else console.log(`  reverted ${stillMatched ?? 0} lines that still pointed at this alias`)

  // Recover lines cleared earlier (where alias_id became null on the
  // same raw description + supplier).
  const { data: orphans } = await db.from('supplier_invoice_lines')
    .select('id')
    .eq('business_id', t.biz)
    .eq('description', alias.raw_description)
    .is('product_alias_id', null)
    .eq('match_status', 'needs_review')
    .limit(500)
  if (orphans?.length) {
    const ids = orphans.map(o => o.id)
    for (let i = 0; i < ids.length; i += 100) {
      const slice = ids.slice(i, i + 100)
      const { error: l2Err } = await db.from('supplier_invoice_lines')
        .update({ product_alias_id: alias.id, match_status: 'matched' })
        .in('id', slice)
      if (l2Err) console.error(`  lines#2: ${l2Err.message}`)
    }
    console.log(`  re-matched ${ids.length} orphaned lines back to alias`)
  }
}
