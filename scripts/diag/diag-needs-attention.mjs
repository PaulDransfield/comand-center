// Predict how many items would flag "Needs attention" per business
// and break down by signal — same computation as /api/inventory/items.
//
// READ-ONLY. Runs against prod via .env.production.local.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

for (const biz of BUSINESSES) {
  console.log(`\n══════════════════════════════════════════════════════════════════`)
  console.log(`  ${biz.name}`)
  console.log(`══════════════════════════════════════════════════════════════════`)

  // PostgREST default LIMIT is 1000 — paginate via range so we get
  // the full catalogue (Chicce has 1248).
  const all = []
  let pfrom = 0
  while (true) {
    const { data, error } = await db
      .from('products')
      .select('id, name, category, default_supplier_name, source_recipe_id, price_override')
      .eq('business_id', biz.id)
      .is('archived_at', null)
      .order('name')
      .range(pfrom, pfrom + 499)
    if (error) { console.error(error); break }
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < 500) break
    pfrom += 500
  }
  console.log(`  ${all.length} active products`)

  // Active alias counts — smaller batches to stay under PostgREST URL limits.
  const aliasCountByProduct = new Map()
  const productIds = all.map(p => p.id)
  for (let i = 0; i < productIds.length; i += 100) {
    const slice = productIds.slice(i, i + 100)
    const { data: aliasRows, error } = await db
      .from('product_aliases')
      .select('product_id')
      .eq('business_id', biz.id)
      .eq('is_active', true)
      .in('product_id', slice)
    if (error) { console.error(error); continue }
    for (const a of aliasRows ?? []) {
      aliasCountByProduct.set(a.product_id, (aliasCountByProduct.get(a.product_id) ?? 0) + 1)
    }
  }

  // Latest matched line per product (for unreliable signal + supplier fallback)
  const allLines = []
  let from = 0
  while (true) {
    const { data } = await db
      .from('supplier_invoice_lines')
      .select('product_alias_id, supplier_name_snapshot, fortnox_invoice_number, invoice_date, price_per_unit, total_excl_vat, quantity')
      .eq('business_id', biz.id)
      .eq('match_status', 'matched')
      .not('product_alias_id', 'is', null)
      .order('invoice_date', { ascending: false })
      .range(from, from + 999)
    if (!data || data.length === 0) break
    allLines.push(...data)
    if (data.length < 1000) break
    from += 1000
    if (from > 50_000) break
  }
  const aliasIds = [...new Set(allLines.map(l => l.product_alias_id).filter(Boolean))]
  const aliasToProduct = new Map()
  for (let i = 0; i < aliasIds.length; i += 500) {
    const slice = aliasIds.slice(i, i + 500)
    const { data: aliases } = await db.from('product_aliases').select('id, product_id').in('id', slice)
    for (const a of aliases ?? []) aliasToProduct.set(a.id, a.product_id)
  }
  const latestLineByProduct = new Map()
  for (const l of allLines) {
    const pid = aliasToProduct.get(l.product_alias_id)
    if (!pid) continue
    if (latestLineByProduct.has(pid)) continue   // already have a newer line
    latestLineByProduct.set(pid, l)
  }

  // Flagged extractions
  const { data: extractions } = await db
    .from('invoice_pdf_extractions')
    .select('fortnox_invoice_number, validation_warnings')
    .eq('business_id', biz.id)
    .not('validation_warnings', 'is', null)
  const flagged = new Set()
  for (const e of extractions ?? []) {
    const warnings = Array.isArray(e.validation_warnings) ? e.validation_warnings : []
    if (warnings.some(w => w?.code === 'over_extraction' || w?.code === 'total_mismatch')) {
      flagged.add(String(e.fortnox_invoice_number))
    }
  }

  // Tally
  const tally = { no_article: 0, no_price: 0, unreliable: 0, no_supplier: 0, any: 0 }
  for (const p of all) {
    const latest = latestLineByProduct.get(p.id)
    const reasons = []
    if ((aliasCountByProduct.get(p.id) ?? 0) === 0) reasons.push('no_article')
    if (latest == null) {
      if (p.price_override == null && !p.source_recipe_id) reasons.push('no_price')
      if (!p.default_supplier_name) reasons.push('no_supplier')
    } else {
      const hasUsablePrice =
        p.price_override != null
        || latest.price_per_unit != null
        || (latest.total_excl_vat != null && latest.quantity != null && Number(latest.quantity) > 0)
      if (!hasUsablePrice) reasons.push('no_price')
      if (latest.fortnox_invoice_number && flagged.has(String(latest.fortnox_invoice_number))) reasons.push('unreliable')
      if (!p.default_supplier_name && !latest.supplier_name_snapshot) reasons.push('no_supplier')
    }
    for (const r of reasons) tally[r]++
    if (reasons.length > 0) tally.any++
  }
  console.log(`\n  ── Needs-attention tally ─────────────────────────────`)
  console.log(`  any:         ${tally.any.toString().padStart(5)} (${((tally.any/all.length)*100).toFixed(1)}%)`)
  console.log(`  no_article:  ${tally.no_article.toString().padStart(5)}`)
  console.log(`  no_price:    ${tally.no_price.toString().padStart(5)}`)
  console.log(`  unreliable:  ${tally.unreliable.toString().padStart(5)}`)
  console.log(`  no_supplier: ${tally.no_supplier.toString().padStart(5)}`)
}
