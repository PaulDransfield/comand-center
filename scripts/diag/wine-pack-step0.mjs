// Wine pack investigation — Step 0.
//
// Goal: characterise the residue products in the alcohol category so we
// know exactly what the LLM has to solve vs what a deterministic suffix
// extension could pre-solve. Also verify the case-vs-bottle invoice
// shape — does the supplier invoice per BOTTLE (quantity=12 of 75cl
// Riesling, each priced at X kr) or per CASE (quantity=1 of "KLI"
// containing 6 bottles)?
//
// Sample 30 alcohol residue products at Chicce + Vero with one
// representative supplier_invoice_line each, so we can eyeball the
// shape.

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

// Suffix patterns owners commonly write. If most of the residue matches
// these we can solve deterministically before any LLM.
const EG_SUFFIX = /(\d+(?:[.,]\d+)?)\s*eg\b/i          // "75eg" / "70eg" / "27,5eg" = cl
const LF_SUFFIX = /(\d+(?:[.,]\d+)?)\s*lf\b/i          // "30lf" / "20lf" = liter (keg)
const CLX_PAT   = /(\d+)\s*cl\s*x\s*(\d+)/i             // "75clx6" → 75cl × 6 bottles
const XCL_PAT   = /(\d+)\s*x\s*(\d+(?:[.,]\d+)?)\s*cl/i // "6x75cl" → reverse

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)

  // Pull every alcohol product still missing pack info.
  const { data: prods, error } = await db.from('products')
    .select('id, name, category, invoice_unit, default_supplier_name')
    .eq('business_id', biz.id)
    .is('archived_at', null)
    .is('pack_size', null)
    .eq('category', 'alcohol')
    .order('name')
    .limit(500)
  if (error) { console.error(error.message); continue }
  console.log(`  alcohol products still missing pack: ${prods?.length ?? 0}`)

  // Bucket by deterministic-solvability + invoice_unit shape.
  let egCount = 0, lfCount = 0, clxCount = 0, xclCount = 0
  const llmCandidates = []
  const buckets = new Map()
  for (const p of prods ?? []) {
    const eg  = EG_SUFFIX.exec(p.name ?? '')
    const lf  = LF_SUFFIX.exec(p.name ?? '')
    const clx = CLX_PAT.exec(p.name ?? '')
    const xcl = XCL_PAT.exec(p.name ?? '')
    if (eg) egCount++
    else if (lf) lfCount++
    else if (clx || xcl) clxCount++
    else {
      llmCandidates.push(p)
      const k = p.invoice_unit ?? '∅'
      buckets.set(k, (buckets.get(k) ?? 0) + 1)
    }
  }
  console.log(`  Deterministic-extension solvable:`)
  console.log(`    \\d+eg suffix  (e.g. "75eg" = 75 cl bottle): ${egCount}`)
  console.log(`    \\d+lf suffix  (e.g. "30lf" = 30 L keg):    ${lfCount}`)
  console.log(`    \\d+clx\\d+    (e.g. "75clx6"):             ${clxCount}`)
  console.log(`  → would clear deterministically: ${egCount + lfCount + clxCount}`)
  console.log(`  → LLM residue: ${llmCandidates.length}`)
  console.log(`  Invoice-unit shape of LLM residue:`)
  const bucketArr = [...buckets.entries()].sort((a, b) => b[1] - a[1])
  for (const [u, n] of bucketArr) console.log(`    ${u}: ${n}`)
  console.log(`\n  Sample LLM residue (first 12):`)
  for (const p of llmCandidates.slice(0, 12)) {
    console.log(`    • "${p.name}" — invoice_unit: ${p.invoice_unit ?? '∅'} — supplier: ${p.default_supplier_name ?? '?'}`)
  }

  // Pull one representative supplier_invoice_line for the FIRST 5 LLM
  // candidates so we can eyeball the case-vs-bottle question.
  console.log(`\n  Invoice-line shape for first 5 LLM candidates:`)
  for (const p of llmCandidates.slice(0, 5)) {
    const { data: lines } = await db.from('supplier_invoice_lines')
      .select('raw_description, quantity, unit, total_excl_vat, supplier_name_snapshot')
      .eq('business_id', biz.id)
      .ilike('raw_description', `%${(p.name ?? '').slice(0, 25)}%`)
      .order('invoice_date', { ascending: false })
      .limit(1)
    const l = lines?.[0]
    if (!l) { console.log(`    • "${p.name}" — no line found`); continue }
    const ppu = l.total_excl_vat && l.quantity ? (l.total_excl_vat / l.quantity).toFixed(2) : '?'
    console.log(`    • "${p.name}"`)
    console.log(`        invoice line: "${l.raw_description}"`)
    console.log(`        qty=${l.quantity} unit=${l.unit} total_excl_vat=${l.total_excl_vat}  → per-unit=${ppu}`)
  }
}

console.log('\ndone')
