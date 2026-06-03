// Fix Laweka invoice lines where price_per_unit was extracted in EUR but
// tagged as SEK. The invoice's total_excl_vat IS in SEK (matches Fortnox
// header), so the per-line correction is:
//
//   correct_ppu_sek = total_excl_vat / quantity
//
// We DON'T globally multiply by a fixed EUR/SEK rate — we use the line's
// own (total / qty) which is the ground truth and matches what the cost
// engine already computes. After this backfill, qty × ppu ≈ total within
// rounding, and getProductReliabilitySignal stops false-alarming.
//
// SAFETY GATES:
//   1. Only touch lines where (qty × ppu) / total is in [10.5, 12.5] —
//      EUR-as-SEK signature. Skip already-consistent lines AND skip
//      anything outside the EUR/SEK band (unknown problem class).
//   2. Only touch lines where qty > 0 AND ppu > 0 AND total > 0 (zero
//      values can't be diagnosed, leave them alone).
//   3. Limit to supplier_name_snapshot ILIKE '%laweka%' for now.
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

const all = []
let from = 0
while (true) {
  const { data } = await db.from('supplier_invoice_lines')
    .select('id, fortnox_invoice_number, invoice_date, quantity, price_per_unit, total_excl_vat, currency, raw_description, business_id')
    .ilike('supplier_name_snapshot', '%laweka%')
    .range(from, from + 999)
  if (!data?.length) break
  all.push(...data)
  if (data.length < 1000) break
  from += 1000
}
console.log(`Total Laweka lines: ${all.length}`)

const candidates = []
for (const l of all) {
  const q = Number(l.quantity ?? 0)
  const p = Number(l.price_per_unit ?? 0)
  const t = Number(l.total_excl_vat ?? 0)
  if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(p) || p <= 0 || !Number.isFinite(t) || t === 0) continue
  const ratio = t / (q * p)
  if (ratio < 10.5 || ratio > 12.5) continue   // not EUR-as-SEK signature
  candidates.push({ ...l, _ratio: ratio, _new_ppu: Math.round((t / q) * 1000) / 1000 })
}
console.log(`Candidates (EUR-as-SEK signature): ${candidates.length}`)
console.log(`\nSample:`)
for (const c of candidates.slice(0, 8)) {
  console.log(`  inv=${c.fortnox_invoice_number} ${c.invoice_date}  qty=${c.quantity}  ppu ${c.price_per_unit} → ${c._new_ppu}  total=${c.total_excl_vat}  "${c.raw_description?.slice(0,45)}"`)
}

if (!APPLY) { console.log('\n(DRY — re-run with --apply to write)'); process.exit(0) }

let ok = 0, fail = 0
for (const c of candidates) {
  const { error } = await db.from('supplier_invoice_lines')
    .update({ price_per_unit: c._new_ppu })
    .eq('id', c.id)
  if (error) { console.error(`  ${c.id}: ${error.message}`); fail++ }
  else ok++
}
console.log(`\nUpdated: ${ok} / ${candidates.length}  (failed: ${fail})`)
