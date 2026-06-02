// Replay the deployed API's needs-attention logic EXACTLY (including
// pagination quirks) to confirm what the live items page would compute.
// This is the truth test — anything that disagrees with this is a diag
// bug, not a product-data issue.
//
// READ-ONLY.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

for (const biz of [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]) {
  console.log(`\n══════ ${biz.name} ══════`)
  // 1. Products WITHOUT pagination — like the API
  const { data: allProducts, error } = await db
    .from('products')
    .select('id, name, category, default_supplier_fortnox_number, default_supplier_name, source_recipe_id, price_override')
    .eq('business_id', biz.id)
    .is('archived_at', null)
    .order('name')
  if (error) { console.error(error); continue }
  console.log(`  products returned without pagination: ${allProducts?.length ?? 0}`)

  // 2. Aliases batched at 500 (like API)
  const productIds = (allProducts ?? []).map(p => p.id)
  const aliasCountByProduct = new Map()
  let aliasRowsFetched = 0
  for (let i = 0; i < productIds.length; i += 500) {
    const slice = productIds.slice(i, i + 500)
    const { data: aliasRows, error: aErr } = await db
      .from('product_aliases')
      .select('product_id')
      .eq('business_id', biz.id)
      .eq('is_active', true)
      .in('product_id', slice)
    if (aErr) { console.error('  alias batch error:', aErr); continue }
    aliasRowsFetched += (aliasRows?.length ?? 0)
    for (const a of aliasRows ?? []) {
      aliasCountByProduct.set(a.product_id, (aliasCountByProduct.get(a.product_id) ?? 0) + 1)
    }
  }
  console.log(`  alias rows fetched (batch=500): ${aliasRowsFetched}`)

  // 2b. Same batched at 100 (safer) for comparison
  const aliasCountByProduct100 = new Map()
  let aliasRowsFetched100 = 0
  for (let i = 0; i < productIds.length; i += 100) {
    const slice = productIds.slice(i, i + 100)
    const { data: aliasRows, error: aErr } = await db
      .from('product_aliases')
      .select('product_id')
      .eq('business_id', biz.id)
      .eq('is_active', true)
      .in('product_id', slice)
    if (aErr) { console.error('  alias batch100 error:', aErr); continue }
    aliasRowsFetched100 += (aliasRows?.length ?? 0)
    for (const a of aliasRows ?? []) {
      aliasCountByProduct100.set(a.product_id, (aliasCountByProduct100.get(a.product_id) ?? 0) + 1)
    }
  }
  console.log(`  alias rows fetched (batch=100): ${aliasRowsFetched100} ← truth check`)
  console.log(`  batch=500 vs batch=100 delta: ${aliasRowsFetched100 - aliasRowsFetched} (negative = batch500 silently lost rows)`)

  // 3. Lines
  const allLines = []
  let lfrom = 0
  while (true) {
    const { data } = await db
      .from('supplier_invoice_lines')
      .select('product_alias_id, price_per_unit, total_excl_vat, quantity, supplier_name_snapshot, fortnox_invoice_number, invoice_date')
      .eq('business_id', biz.id)
      .eq('match_status', 'matched')
      .not('product_alias_id', 'is', null)
      .order('invoice_date', { ascending: false })
      .range(lfrom, lfrom + 999)
    if (!data || data.length === 0) break
    allLines.push(...data)
    if (data.length < 1000) break
    lfrom += 1000
    if (lfrom > 100_000) break
  }
  const aliasIds = [...new Set(allLines.map(l => l.product_alias_id).filter(Boolean))]
  const aliasToProduct = new Map()
  // API batch=500
  for (let i = 0; i < aliasIds.length; i += 500) {
    const slice = aliasIds.slice(i, i + 500)
    const { data: aliases } = await db.from('product_aliases').select('id, product_id').in('id', slice)
    for (const a of aliases ?? []) aliasToProduct.set(a.id, a.product_id)
  }
  console.log(`  alias→product map size (batch=500): ${aliasToProduct.size}`)

  // Latest line per product
  const latestLineByProduct = new Map()
  for (const l of allLines) {
    const pid = aliasToProduct.get(l.product_alias_id)
    if (!pid) continue
    if (latestLineByProduct.has(pid)) continue
    latestLineByProduct.set(pid, l)
  }
  console.log(`  products with a latest matched line: ${latestLineByProduct.size}`)

  // Now apply the API's no_price logic
  let no_price = 0, no_article = 0, any = 0
  for (const p of (allProducts ?? [])) {
    const latest = latestLineByProduct.get(p.id)
    const reasons = []
    if ((aliasCountByProduct.get(p.id) ?? 0) === 0) reasons.push('no_article')
    if (latest == null) {
      if (p.price_override == null && !p.source_recipe_id) reasons.push('no_price')
    } else {
      const hasUsablePrice =
        p.price_override != null
        || latest.price_per_unit != null
        || (latest.total_excl_vat != null && latest.quantity != null && Number(latest.quantity) > 0)
      if (!hasUsablePrice) reasons.push('no_price')
    }
    if (reasons.includes('no_price'))   no_price++
    if (reasons.includes('no_article')) no_article++
    if (reasons.length > 0)             any++
  }
  console.log(`  API-LOGIC tallies (batch=500 alias counts):`)
  console.log(`    no_price:   ${no_price}`)
  console.log(`    no_article: ${no_article}`)
  console.log(`    any:        ${any}`)

  // Now WITH the batch=100 alias counts (truth)
  let no_price_truth = 0, no_article_truth = 0, any_truth = 0
  for (const p of (allProducts ?? [])) {
    const latest = latestLineByProduct.get(p.id)
    const reasons = []
    if ((aliasCountByProduct100.get(p.id) ?? 0) === 0) reasons.push('no_article')
    if (latest == null) {
      if (p.price_override == null && !p.source_recipe_id) reasons.push('no_price')
    } else {
      const hasUsablePrice =
        p.price_override != null
        || latest.price_per_unit != null
        || (latest.total_excl_vat != null && latest.quantity != null && Number(latest.quantity) > 0)
      if (!hasUsablePrice) reasons.push('no_price')
    }
    if (reasons.includes('no_price'))   no_price_truth++
    if (reasons.includes('no_article')) no_article_truth++
    if (reasons.length > 0)             any_truth++
  }
  console.log(`  TRUTH tallies (batch=100 alias counts):`)
  console.log(`    no_price:   ${no_price_truth}`)
  console.log(`    no_article: ${no_article_truth}`)
  console.log(`    any:        ${any_truth}`)
}
