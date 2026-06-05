// scripts/diag/find-duplicate-products.mts
//
// Find duplicate products at a business — clusters where multiple products
// share the same supplier AND normalised root name (year/vintage stripped).
// Same pattern as the Nebbiolo d'Alba 2023 / 2024 case the owner surfaced.
//
// DRY by default. --apply consolidates each cluster:
//   - Picks the cluster member with the MOST aliases as canonical (preserves
//     cost history). Ties broken by highest pack_size / most recipes.
//   - Repoints every alias from siblings → canonical.
//   - Moves every recipe_ingredients reference from siblings → canonical.
//   - Archives siblings.
//
// Excludes: clusters where every member has 0 aliases AND 0 recipes
// (handled separately by backfill-m130 archive sweep).

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

// Strip vintage / year / common suffixes so "Nebbiolo d'Alba 2023" + "Nebbiolo d'Alba 2024" hash the same.
function rootName(name: string): string {
  if (!name) return ''
  let n = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  // Strip "NV " prefix (non-vintage)
  n = n.replace(/^nv\s+/i, '')
  // Strip leading year "2023 …" or "2023-2024 …"
  n = n.replace(/^\d{4}(-\d{2,4})?\s+/, '')
  // Strip trailing standalone year " 2023" / " 2023/24"
  n = n.replace(/\s+\d{4}(\/\d{2,4})?\s*$/, '')
  // Strip embedded standalone year tokens
  n = n.replace(/\s\d{4}\b/g, '')
  // Strip common pack/vol suffixes that vary by import (75cl vs 750ml, 70cl vs 700ml)
  n = n.replace(/\b(75cl|750ml|70cl|700ml|50cl|500ml|33cl|330ml|25cl|250ml|20cl|200ml|1l|1\s?liter)\b/g, '')
  // Strip punctuation + collapse whitespace
  n = n.replace(/[^\p{Letter}\p{Number}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
  return n
}

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)
  const { data: prods } = await db.from('products')
    .select('id, name, default_supplier_name, default_supplier_fortnox_number, category, invoice_unit, base_unit, pack_size, org_id, source_recipe_id')
    .eq('business_id', biz.id).is('archived_at', null).range(0, 9999)
  if (!prods) continue
  // Alias counts
  const { data: aliases } = await db.from('product_aliases').select('product_id, is_active').eq('business_id', biz.id).range(0, 9999)
  const activeAliasCount = new Map<string, number>()
  for (const a of aliases ?? []) {
    if (!(a as any).is_active) continue
    const k = (a as any).product_id
    activeAliasCount.set(k, (activeAliasCount.get(k) ?? 0) + 1)
  }
  // Recipe references
  const { data: recipeRefs } = await db.from('recipe_ingredients').select('product_id').range(0, 9999)
  const recipeRefCount = new Map<string, number>()
  for (const r of recipeRefs ?? []) {
    const k = (r as any).product_id; if (!k) continue
    recipeRefCount.set(k, (recipeRefCount.get(k) ?? 0) + 1)
  }

  // Cluster by (supplier, root_name)
  const clusters = new Map<string, any[]>()
  for (const p of prods) {
    if (p.source_recipe_id) continue   // skip recipe-promoted in-house products
    const sup = (p.default_supplier_fortnox_number ?? '').trim()
    const root = rootName(p.name)
    if (!root || root.length < 3) continue
    const key = sup + '|' + root
    const arr = clusters.get(key) ?? []
    arr.push(p)
    clusters.set(key, arr)
  }

  const dupClusters = [...clusters.entries()].filter(([_, arr]) => arr.length >= 2)
  console.log(`Duplicate clusters: ${dupClusters.length}`)

  let totalToArchive = 0, totalToMoveAliases = 0, totalToMoveRecipes = 0
  for (const [key, members] of dupClusters) {
    // Skip if every member is empty (no aliases + no recipes) — handled by
    // backfill-m130 archive sweep, no need to consolidate
    const total = members.reduce((s, m) => s + (activeAliasCount.get(m.id) ?? 0) + (recipeRefCount.get(m.id) ?? 0), 0)
    if (total === 0) continue

    // Pick canonical: most aliases → most recipes → highest pack_size → newest (last in array)
    const sorted = [...members].sort((a, b) => {
      const ac = (activeAliasCount.get(a.id) ?? 0), bc = (activeAliasCount.get(b.id) ?? 0)
      if (ac !== bc) return bc - ac
      const ar = (recipeRefCount.get(a.id) ?? 0), br = (recipeRefCount.get(b.id) ?? 0)
      if (ar !== br) return br - ar
      const ap = Number(a.pack_size ?? 0), bp = Number(b.pack_size ?? 0)
      return bp - ap
    })
    const canonical = sorted[0]
    const siblings  = sorted.slice(1)

    console.log(`\n  Cluster [${key.split('|')[1].slice(0, 50)}] @ ${members[0].default_supplier_name?.slice(0, 30) ?? '?'}`)
    console.log(`    CANONICAL → "${canonical.name}" (aliases=${activeAliasCount.get(canonical.id) ?? 0}, recipes=${recipeRefCount.get(canonical.id) ?? 0})`)
    for (const s of siblings) {
      console.log(`    archive    "${s.name}" (aliases=${activeAliasCount.get(s.id) ?? 0}, recipes=${recipeRefCount.get(s.id) ?? 0})`)
    }
    totalToArchive    += siblings.length
    totalToMoveAliases += siblings.reduce((s, m) => s + (activeAliasCount.get(m.id) ?? 0), 0)
    totalToMoveRecipes += siblings.reduce((s, m) => s + (recipeRefCount.get(m.id) ?? 0), 0)

    if (APPLY) {
      const siblingIds = siblings.map(s => s.id)
      // Move aliases
      if (siblings.some(s => (activeAliasCount.get(s.id) ?? 0) > 0)) {
        const { error } = await db.from('product_aliases')
          .update({ product_id: canonical.id })
          .in('product_id', siblingIds).eq('is_active', true)
        if (error) console.error('    alias repoint:', error.message)
      }
      // Move recipe ingredients
      if (siblings.some(s => (recipeRefCount.get(s.id) ?? 0) > 0)) {
        const { error } = await db.from('recipe_ingredients')
          .update({ product_id: canonical.id })
          .in('product_id', siblingIds)
        if (error) console.error('    recipe move:', error.message)
      }
      // Archive
      const { error: aErr } = await db.from('products')
        .update({ archived_at: new Date().toISOString() })
        .in('id', siblingIds)
      if (aErr) console.error('    archive:', aErr.message)
    }
  }
  console.log(`\n  Summary: ${dupClusters.length} clusters | ${totalToArchive} products to archive | ${totalToMoveAliases} aliases to repoint | ${totalToMoveRecipes} recipe-refs to move`)
}
console.log(APPLY ? '\nDone (--apply).' : '\n(DRY — re-run with --apply to consolidate)')
