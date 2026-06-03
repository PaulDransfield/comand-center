// promote-supplier-weights.mjs
//
// Walk supplier_articles (scraped MS data) → product_aliases → products.
// Where the supplier_articles row has authoritative weight info AND the
// product's pack_source is auto-set (NOT owner-edited), update the
// product's pack_size + base_unit to match the supplier, tagged
// pack_source='supplier_official'.
//
// Conservative gates:
//   - Skip when supplier_articles.net_weight_g is null (no data)
//   - Skip when product.pack_source = 'owner_set' (never overwrite owner)
//   - Skip when new value would equal current (no-op)
//
// Cross-customer: same supplier_articles row updates every customer's
// product with a matching alias. One source of truth, many readers.
//
// Usage:
//   node scripts/diag/promote-supplier-weights.mjs           # DRY
//   node scripts/diag/promote-supplier-weights.mjs --apply

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const APPLY = process.argv.includes('--apply')

// 1. Pull every scraped supplier_articles row with weight data.
const articles = []
let from = 0
while (true) {
  const { data, error } = await db.from('supplier_articles')
    .select('supplier_fortnox_number, article_number, official_name, net_weight_g, unit, units_per_pack, units_per_pack_label')
    .eq('fetch_status', 'ok')
    .not('net_weight_g', 'is', null)
    .order('article_number').range(from, from + 999)
  if (error) { console.error(error.message); break }
  if (!data || data.length === 0) break
  articles.push(...data)
  if (data.length < 1000) break
  from += 1000
}
console.log(`Scraped articles with net_weight data: ${articles.length}`)

// 2. For each article, find every supplier_invoice_line at any
// business with this (supplier, article) and grab the product_alias_id.
// Then resolve the alias → product.
// Cheap: bulk-load aliases keyed on alias_id, then per-business lines.
// Actually simpler — get all aliases for the (supplier, article) via the
// lines table. Use one bulk query per chunk.
const articleByKey = new Map()
for (const a of articles) articleByKey.set(`${a.supplier_fortnox_number}|${a.article_number}`, a)

// Pull every distinct (product_alias_id, supplier, article) from lines
// matching one of our scraped articles. We can use the OR group.
const aliasToArticle = new Map()   // alias_id → article-key
{
  // Pull lines in chunks by supplier+article pairs. To avoid a huge OR,
  // chunk the articles 100 at a time and use compound .in().
  const CHUNK = 100
  for (let i = 0; i < articles.length; i += CHUNK) {
    const slice = articles.slice(i, i + CHUNK)
    // Use a single article_number .in(...) — same article_number could
    // theoretically appear at a different supplier (rare but possible).
    // We filter on the supplier_fortnox_number after via a Map check.
    const artNums = slice.map(a => a.article_number)
    const { data, error } = await db.from('supplier_invoice_lines')
      .select('product_alias_id, supplier_fortnox_number, article_number')
      .in('article_number', artNums)
      .not('product_alias_id', 'is', null)
    if (error) { console.error(error.message); continue }
    for (const l of data ?? []) {
      const k = `${l.supplier_fortnox_number}|${l.article_number}`
      if (!articleByKey.has(k)) continue   // a different supplier shares the number; skip
      if (!aliasToArticle.has(l.product_alias_id)) aliasToArticle.set(l.product_alias_id, k)
    }
  }
}
console.log(`Aliases pointing at scraped articles: ${aliasToArticle.size}`)

// 3. Resolve aliases → products.
const aliasIds = [...aliasToArticle.keys()]
const productToArticle = new Map()   // product_id → article-key (we keep the most-recent if alias points to multiple)
for (let i = 0; i < aliasIds.length; i += 100) {
  const slice = aliasIds.slice(i, i + 100)
  const { data } = await db.from('product_aliases').select('id, product_id').in('id', slice)
  for (const a of data ?? []) {
    if (!productToArticle.has(a.product_id)) productToArticle.set(a.product_id, aliasToArticle.get(a.id))
  }
}
console.log(`Products to consider: ${productToArticle.size}`)

// 4. Pull products for each product_id; check pack_source eligibility.
const productIds = [...productToArticle.keys()]
const proposals = []   // { id, name, old_pack, old_base, old_source, new_pack, new_base, article }
const skipped   = { owner_set: 0, no_change: 0, ms_pack_not_g_compatible: 0 }
for (let i = 0; i < productIds.length; i += 100) {
  const slice = productIds.slice(i, i + 100)
  const { data } = await db.from('products')
    .select('id, name, pack_size, base_unit, pack_source')
    .in('id', slice)
  for (const p of data ?? []) {
    const k = productToArticle.get(p.id)
    const a = articleByKey.get(k)
    if (!a || a.net_weight_g == null) continue
    // Never overwrite an owner-set value.
    if (p.pack_source === 'owner_set') { skipped.owner_set++; continue }
    // MS net_weight is always in grams (from the scraper); we store as
    // pack_size = net_weight_g, base_unit = 'g'. This works for solid/
    // weight-sold products. For liquids the MS data is also stated in g
    // (e.g. Frityrolja Long Life 10L shows 9170g net) but recipes ask
    // in ml — handled at cost-engine via the existing density bridge.
    const newPack = Number(a.net_weight_g)
    const newBase = 'g'
    if (!Number.isFinite(newPack) || newPack <= 0) continue
    if (p.pack_size != null && Number(p.pack_size) === newPack && p.base_unit === newBase) {
      skipped.no_change++; continue
    }
    proposals.push({
      id:         p.id,
      name:       p.name,
      old_pack:   p.pack_size,
      old_base:   p.base_unit,
      old_source: p.pack_source,
      new_pack:   newPack,
      new_base:   newBase,
      article:    a,
    })
  }
}

console.log(`\nProposals: ${proposals.length}`)
console.log(`Skipped: owner_set=${skipped.owner_set}, no_change=${skipped.no_change}`)
if (proposals.length === 0) process.exit(0)

console.log(`\nSample (first 20):`)
for (const p of proposals.slice(0, 20)) {
  console.log(`  • "${p.name}"`)
  console.log(`      ${p.old_pack ?? '∅'} ${p.old_base ?? '∅'} (${p.old_source ?? '∅'}) → ${p.new_pack} ${p.new_base}  (MS art ${p.article.article_number} "${p.article.official_name}")`)
}

if (APPLY) {
  console.log(`\nAPPLYING ${proposals.length} updates…`)
  let ok = 0
  for (const p of proposals) {
    const { error } = await db.from('products')
      .update({ pack_size: p.new_pack, base_unit: p.new_base, pack_source: 'supplier_official' })
      .eq('id', p.id)
    if (error) { console.error(`  "${p.name}" failed: ${error.message}`); continue }
    ok++
  }
  console.log(`Updated: ${ok} / ${proposals.length}`)
} else {
  console.log(`\n(DRY mode — re-run with --apply to write)`)
}
