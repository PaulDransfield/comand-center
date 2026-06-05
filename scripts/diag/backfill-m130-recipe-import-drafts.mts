// scripts/diag/backfill-m130-recipe-import-drafts.mts
//
// One-shot cleanup of "ghost" products — products with created_via=
// 'owner_review' but no active product_aliases (the matcher's intent was
// "this came from an invoice" but the alias either was never created or
// got moved away via dedup). Two outcomes:
//
//   (1) Ghost has 0 recipe_ingredients references → ARCHIVE. Safe to
//       drop because no recipe cost is computed against it. If a future
//       invoice arrives with a matching description the matcher will
//       create a fresh product.
//
//   (2) Ghost IS referenced by recipe_ingredients → FLIP to created_via
//       ='recipe_import_draft'. The product stays alive so recipe cost
//       doesn't break; the items API stops flagging it as no_article
//       (per M130 items-API change) so it doesn't pollute Needs-attention.
//
// Run after sql/M130 is applied.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
    const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')]
  })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const APPLY = process.argv.includes('--apply')

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)
  const { data: prods } = await db.from('products')
    .select('id, name, created_via, created_at, source_recipe_id')
    .eq('business_id', biz.id).is('archived_at', null).is('source_recipe_id', null)
    .range(0, 9999)
  if (!prods) continue
  const { data: aliases } = await db.from('product_aliases')
    .select('product_id').eq('business_id', biz.id).eq('is_active', true).range(0, 9999)
  const aliased = new Set((aliases ?? []).map(a => a.product_id))
  const ghostIds = prods.filter(p => !aliased.has(p.id) && p.created_via === 'owner_review').map(p => p.id)
  console.log(`Ghosts (owner_review, 0 aliases, no source_recipe_id): ${ghostIds.length}`)
  if (ghostIds.length === 0) continue

  // Recipe-referenced subset (cannot archive — would break recipe costs)
  const referenced = new Set<string>()
  for (let i = 0; i < ghostIds.length; i += 100) {
    const slice = ghostIds.slice(i, i + 100)
    const { data: refs } = await db.from('recipe_ingredients').select('product_id').in('product_id', slice)
    for (const r of refs ?? []) referenced.add((r as any).product_id)
  }
  const recipeUsed = ghostIds.filter(id => referenced.has(id))
  const safeToArchive = ghostIds.filter(id => !referenced.has(id))
  console.log(`  Recipe-referenced (re-tag): ${recipeUsed.length}`)
  console.log(`  Safe to archive:            ${safeToArchive.length}`)

  if (!APPLY) {
    console.log('  (DRY — re-run with --apply to write)')
    continue
  }

  // (1) Archive the dead ones
  let archived = 0
  for (let i = 0; i < safeToArchive.length; i += 100) {
    const slice = safeToArchive.slice(i, i + 100)
    const { data, error } = await db.from('products')
      .update({ archived_at: new Date().toISOString() })
      .in('id', slice).select('id')
    if (error) { console.error('  archive batch:', error.message); continue }
    archived += data?.length ?? 0
  }
  console.log(`  Archived: ${archived}`)

  // (2) Re-tag recipe-referenced ghosts
  let retagged = 0
  for (let i = 0; i < recipeUsed.length; i += 100) {
    const slice = recipeUsed.slice(i, i + 100)
    const { data, error } = await db.from('products')
      .update({ created_via: 'recipe_import_draft' })
      .in('id', slice).select('id')
    if (error) { console.error('  retag batch:', error.message); continue }
    retagged += data?.length ?? 0
  }
  console.log(`  Re-tagged to recipe_import_draft: ${retagged}`)
}
console.log(APPLY ? '\nDone (--apply).' : '\n(DRY — re-run with --apply to write)')
