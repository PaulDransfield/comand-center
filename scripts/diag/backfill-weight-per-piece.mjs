// Backfill products.weight_per_piece_g from supplier_articles.
//
// Rule: for every active product with base_unit='st' AND pack_size>0,
// look up the latest matched supplier_article via aliases→lines. If
// the article has net_weight_g set, derive:
//
//   weight_per_piece_g = net_weight_g / pack_size
//
// Examples:
//   ÄGG LV M FRIG 30P 1.785KG     pack=120 st, net=7140g → 59.5 g/piece
//   Mini Brioche Roll 150x27g     pack=150 st, net=4050g → 27 g/piece
//   Stracciatella Burrata 250g    pack=40 st, net=10000g → 250 g/piece
//
// SAFETY GATES:
//   • Skip if weight_per_piece_source='manual' (owner-set wins).
//   • Skip if derived value <= 0 or > 100000 (CHECK constraint).
//   • Skip if pack_size is null/0 or base_unit ≠ 'st'.
//   • Always source='supplier_article' so the audit trail is clear.
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

// Both businesses
const { data: bizes } = await db.from('businesses').select('id, name')
console.log(`Businesses: ${bizes?.length}`)

let totalCandidates = 0
let totalApplied = 0
const skipReasons = { manual_existing: 0, no_alias: 0, no_article_weight: 0, bad_derived: 0, already_set: 0 }

for (const biz of bizes ?? []) {
  console.log(`\n=== ${biz.name} ===`)

  // 1. Active count-based products
  const products = []
  let from = 0
  while (true) {
    const { data } = await db.from('products')
      .select('id, name, pack_size, base_unit, weight_per_piece_g, weight_per_piece_source')
      .eq('business_id', biz.id).is('archived_at', null)
      .eq('base_unit', 'st')
      .not('pack_size','is',null)
      .gt('pack_size', 0)
      .order('id').range(from, from + 999)
    if (!data?.length) break
    products.push(...data)
    if (data.length < 1000) break; from += 1000
  }
  console.log(`Eligible products (base_unit=st, pack_size>0): ${products.length}`)

  // 2. Latest matched supplier_article per product via aliases
  const productCombos = new Map()  // product_id → "supplier|article"
  const productIds = products.map(p => p.id)
  for (let i = 0; i < productIds.length; i += 200) {
    const slice = productIds.slice(i, i + 200)
    const { data: aliases } = await db.from('product_aliases').select('id, product_id').in('product_id', slice).eq('is_active', true)
    if (!aliases?.length) continue
    const aliasToProduct = new Map(aliases.map(a => [a.id, a.product_id]))
    const aliasIds = aliases.map(a => a.id)
    for (let j = 0; j < aliasIds.length; j += 200) {
      const aSlice = aliasIds.slice(j, j + 200)
      const { data: lines } = await db.from('supplier_invoice_lines')
        .select('product_alias_id, supplier_fortnox_number, article_number, invoice_date')
        .in('product_alias_id', aSlice)
        .not('article_number','is',null).not('supplier_fortnox_number','is',null)
        .order('invoice_date', { ascending: false }).limit(2000)
      for (const l of lines ?? []) {
        const pid = aliasToProduct.get(l.product_alias_id); if (!pid) continue
        if (productCombos.has(pid)) continue
        productCombos.set(pid, `${l.supplier_fortnox_number}|${l.article_number}`)
      }
    }
  }

  // 3. Pull supplier_articles for those combos
  const articleByCombo = new Map()
  const combos = [...new Set(productCombos.values())]
  for (let i = 0; i < combos.length; i += 60) {
    const slice = combos.slice(i, i + 60)
    const orParts = slice.map(k => { const [s,a] = k.split('|'); return `and(supplier_fortnox_number.eq.${s},article_number.eq.${a})` })
    const { data } = await db.from('supplier_articles')
      .select('supplier_fortnox_number, article_number, net_weight_g, official_name')
      .or(orParts.join(','))
      .not('net_weight_g','is',null)
    for (const r of data ?? []) articleByCombo.set(`${r.supplier_fortnox_number}|${r.article_number}`, r)
  }

  // 4. Compute proposals
  const proposals = []
  for (const p of products) {
    if (p.weight_per_piece_source === 'manual') { skipReasons.manual_existing++; continue }
    const combo = productCombos.get(p.id)
    if (!combo) { skipReasons.no_alias++; continue }
    const art = articleByCombo.get(combo)
    if (!art || !art.net_weight_g) { skipReasons.no_article_weight++; continue }
    const derived = Number(art.net_weight_g) / Number(p.pack_size)
    if (!Number.isFinite(derived) || derived <= 0 || derived > 100000) { skipReasons.bad_derived++; continue }
    const rounded = Math.round(derived * 1000) / 1000  // NUMERIC(8,3)
    if (p.weight_per_piece_g != null && Math.abs(Number(p.weight_per_piece_g) - rounded) < 0.01) { skipReasons.already_set++; continue }
    proposals.push({ product: p, derived: rounded, article: art })
  }
  totalCandidates += proposals.length
  console.log(`Proposals: ${proposals.length}`)
  for (const pr of proposals.slice(0, 10)) {
    console.log(`  • "${pr.product.name}"  pack=${pr.product.pack_size} st  net=${pr.article.net_weight_g}g  →  ${pr.derived} g/piece`)
  }
  if (proposals.length > 10) console.log(`  …+${proposals.length - 10} more`)

  if (APPLY) {
    let ok = 0
    for (const pr of proposals) {
      const { error } = await db.from('products').update({
        weight_per_piece_g:      pr.derived,
        weight_per_piece_source: 'supplier_article',
      }).eq('id', pr.product.id)
      if (error) { console.error(`  "${pr.product.name}": ${error.message}`); continue }
      ok++
    }
    totalApplied += ok
    console.log(`Updated: ${ok} / ${proposals.length}`)
  }
}

console.log(`\n=== TOTAL ===`)
console.log(`Candidates: ${totalCandidates}`)
console.log(`Skipped:`)
for (const [k, v] of Object.entries(skipReasons)) console.log(`  ${k}: ${v}`)
if (APPLY) console.log(`Applied: ${totalApplied}`)
else console.log(`(DRY — re-run with --apply to write)`)
