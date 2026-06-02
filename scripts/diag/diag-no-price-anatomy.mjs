// no_price root-cause anatomy.
//
// For each business: of the products my Needs-attention check flags as
// no_price, look at the LATEST matched supplier_invoice_line per product
// and bucket by which price-relevant fields are populated:
//   D1: total + quantity present, price_per_unit missing → derivable
//   D2: price_per_unit present (somehow)                  → plumbing gap
//   D3: ppu + total + qty all present + inconsistent      → misread (Marini/Rima class)
//   N:  none present                                       → genuinely missing
//
// Plus: count "total ≈ price_per_unit" signature (the misread) across the
// no-price population to size the Marini/Rima-class broadening.
//
// READ-ONLY against prod.

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

  // 1. All products (paginated)
  const allProducts = []
  let pfrom = 0
  while (true) {
    const { data } = await db
      .from('products')
      .select('id, name, price_override, source_recipe_id, default_supplier_name')
      .eq('business_id', biz.id)
      .is('archived_at', null)
      .order('name')
      .range(pfrom, pfrom + 499)
    if (!data || data.length === 0) break
    allProducts.push(...data)
    if (data.length < 500) break
    pfrom += 500
  }

  // 2. Latest matched line per product
  const allLines = []
  let lfrom = 0
  while (true) {
    const { data } = await db
      .from('supplier_invoice_lines')
      .select('product_alias_id, supplier_name_snapshot, fortnox_invoice_number, invoice_date, price_per_unit, total_excl_vat, quantity')
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
  // alias→product
  const aliasIds = [...new Set(allLines.map(l => l.product_alias_id).filter(Boolean))]
  const aliasToProduct = new Map()
  for (let i = 0; i < aliasIds.length; i += 200) {
    const slice = aliasIds.slice(i, i + 200)
    const { data: aliases } = await db.from('product_aliases').select('id, product_id').in('id', slice)
    for (const a of aliases ?? []) aliasToProduct.set(a.id, a.product_id)
  }
  const latestLineByProduct = new Map()
  for (const l of allLines) {
    const pid = aliasToProduct.get(l.product_alias_id)
    if (!pid) continue
    if (latestLineByProduct.has(pid)) continue
    latestLineByProduct.set(pid, l)
  }

  // 3. Bucket no-price population
  let total = 0, withLatest = 0, noLatest = 0
  const buckets = { D1: 0, D2: 0, D3: 0, N: 0, noLatest: 0 }
  // Sub-tallies of N: which fields are populated when "none usable"?
  // (Total may be 0, qty may be 0, etc.)
  const nFieldsTally = { only_qty: 0, only_total: 0, only_ppu_null: 0, all_null: 0, qty_zero: 0, total_zero: 0, other: 0 }
  // Misread signature (D3)
  let misreadCount = 0
  const misreadSuppliers = new Map()  // supplier → count of misread lines
  for (const p of allProducts) {
    // Reproduce my no_price logic
    const latest = latestLineByProduct.get(p.id)
    const hasUsablePrice =
      p.price_override != null
      || (latest && latest.price_per_unit != null)
      || (latest && latest.total_excl_vat != null && latest.quantity != null && Number(latest.quantity) > 0)
    if (hasUsablePrice) continue
    total++

    if (!latest) {
      // No matched lines at all — recipe-promoted / manual / never-matched.
      // These are flaggable but irrelevant to "extraction recovery".
      noLatest++
      buckets.noLatest++
      continue
    }
    withLatest++

    const ppu  = latest.price_per_unit
    const tot  = latest.total_excl_vat
    const qty  = latest.quantity
    const hasPpu = ppu != null
    const hasTot = tot != null
    const hasQty = qty != null
    const qtyNum = Number(qty ?? 0)
    const totNum = Number(tot ?? 0)
    const ppuNum = Number(ppu ?? 0)

    // D1: total + quantity present, price_per_unit missing → derivable
    if (!hasPpu && hasTot && hasQty && qtyNum > 0 && totNum !== 0) {
      buckets.D1++
      continue
    }
    // D2: ppu present but somehow not derived? Shouldn't happen given my
    // hasUsablePrice gate already returned true if ppu != null. Keep
    // counter for sanity.
    if (hasPpu) {
      buckets.D2++
      continue
    }
    // D3: all three present + total ≠ ppu × qty (within tol)
    if (hasPpu && hasTot && hasQty && qtyNum > 0) {
      const expected = ppuNum * qtyNum
      const delta = Math.abs(expected - totNum) / Math.max(1, Math.abs(totNum))
      if (delta > 0.05) {
        buckets.D3++
        misreadCount++
        const s = latest.supplier_name_snapshot ?? '?'
        misreadSuppliers.set(s, (misreadSuppliers.get(s) ?? 0) + 1)
        continue
      }
    }
    // N: none usable
    buckets.N++
    // Sub-classify
    if (qtyNum === 0 && hasQty) nFieldsTally.qty_zero++
    else if (totNum === 0 && hasTot) nFieldsTally.total_zero++
    else if (hasQty && !hasTot && !hasPpu) nFieldsTally.only_qty++
    else if (hasTot && !hasQty && !hasPpu) nFieldsTally.only_total++
    else if (!hasPpu && !hasTot && !hasQty) nFieldsTally.all_null++
    else nFieldsTally.other++
  }

  console.log(`\n  Total no-price products: ${total}`)
  console.log(`  ├─ with no matched line at all (recipe-promoted / manual): ${noLatest}`)
  console.log(`  └─ with at least one matched line:                       ${withLatest}`)
  console.log(`\n  Buckets (among the ${withLatest} with a latest line):`)
  console.log(`    D1  (total + qty present, no ppu)      — derivable: ${buckets.D1.toString().padStart(5)}`)
  console.log(`    D2  (ppu present, plumbing?)           — sanity:    ${buckets.D2.toString().padStart(5)}`)
  console.log(`    D3  (all 3 present, total ≠ ppu × qty) — misread:   ${buckets.D3.toString().padStart(5)}`)
  console.log(`    N   (none usable)                      — missing:   ${buckets.N.toString().padStart(5)}`)
  console.log(`\n  N sub-breakdown (which fields are blocking):`)
  console.log(`    qty present but = 0  : ${nFieldsTally.qty_zero}`)
  console.log(`    total present but = 0: ${nFieldsTally.total_zero}`)
  console.log(`    only qty present     : ${nFieldsTally.only_qty}`)
  console.log(`    only total present   : ${nFieldsTally.only_total}`)
  console.log(`    all null             : ${nFieldsTally.all_null}`)
  console.log(`    other                : ${nFieldsTally.other}`)

  // Misread broader-than-Marini? Across the WHOLE no-price withLatest
  // population, count lines where total ≈ ppu (the per-line column
  // misread: total looks like it's missing × qty).
  let totEqPpu = 0
  const totEqPpuSuppliers = new Map()
  for (const p of allProducts) {
    const latest = latestLineByProduct.get(p.id)
    if (!latest) continue
    const hasUsablePrice =
      p.price_override != null
      || latest.price_per_unit != null
      || (latest.total_excl_vat != null && latest.quantity != null && Number(latest.quantity) > 0)
    if (hasUsablePrice) continue
    const ppu  = Number(latest.price_per_unit ?? NaN)
    const tot  = Number(latest.total_excl_vat ?? NaN)
    const qty  = Number(latest.quantity ?? NaN)
    if (Number.isFinite(ppu) && Number.isFinite(tot) && Math.abs(ppu - tot) / Math.max(1, Math.abs(tot)) < 0.01) {
      totEqPpu++
      const s = latest.supplier_name_snapshot ?? '?'
      totEqPpuSuppliers.set(s, (totEqPpuSuppliers.get(s) ?? 0) + 1)
    }
  }
  console.log(`\n  "total ≈ price_per_unit" signature in no-price latest lines: ${totEqPpu}`)
  if (totEqPpu > 0) {
    console.log(`    Top suppliers in that signature:`)
    const sorted = [...totEqPpuSuppliers.entries()].sort(([,a],[,b]) => b - a).slice(0, 8)
    for (const [s, n] of sorted) console.log(`      ${n.toString().padStart(4)}  ${s}`)
  }

  // Cross-check: which suppliers dominate the N (genuinely missing) bucket?
  // If a supplier shows up heavily in N, it's a candidate extractor pattern.
  const nSuppliers = new Map()
  for (const p of allProducts) {
    const latest = latestLineByProduct.get(p.id)
    if (!latest) continue
    const hasUsablePrice =
      p.price_override != null
      || latest.price_per_unit != null
      || (latest.total_excl_vat != null && latest.quantity != null && Number(latest.quantity) > 0)
    if (hasUsablePrice) continue
    // Same N-bucket check as above
    const ppu  = latest.price_per_unit
    const tot  = latest.total_excl_vat
    const qty  = latest.quantity
    const qtyNum = Number(qty ?? 0)
    const totNum = Number(tot ?? 0)
    if (ppu == null && (tot == null || qty == null || qtyNum <= 0 || totNum === 0)) {
      const s = latest.supplier_name_snapshot ?? '?'
      nSuppliers.set(s, (nSuppliers.get(s) ?? 0) + 1)
    }
  }
  console.log(`\n  N-bucket supplier breakdown (top 10):`)
  for (const [s, n] of [...nSuppliers.entries()].sort(([,a],[,b]) => b - a).slice(0, 10)) {
    console.log(`    ${n.toString().padStart(4)}  ${s}`)
  }
}
