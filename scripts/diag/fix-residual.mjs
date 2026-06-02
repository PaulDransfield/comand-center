// Final mop-up: re-scan every still-null product and apply pack info.
// Single-tactic — `.is('pack_size', null)` rather than the .or(...) shape
// since the previous .or() syntax may not have fired correctly.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Mirrors lib/inventory/unit-conversion.ts — 'eg' → cl (Swedish wine
// bottle shorthand "75eg" = 75 cl); 'lf' → l (liter fat / keg).
const PACK_RE = /(\d+(?:[.,]\d+)?)\s*(kg|hg|g|l|liter|litre|lf|dl|cl|eg|ml|st|stk|styck|pcs|frp|fp|pack|paket|burk|flaska)\b/gi
function canonicalUnit(raw) {
  if (!raw) return null
  const u = String(raw).trim().toLowerCase()
  if (['g','gram','gr','grams'].includes(u)) return 'g'
  if (['kg','kilo','kilogram','kilograms'].includes(u)) return 'kg'
  if (['hg','hekto','hektogram'].includes(u)) return 'hg'
  if (['ml','milliliter','millilitre'].includes(u)) return 'ml'
  if (['cl','centiliter','centilitre','eg'].includes(u)) return 'cl'
  if (['dl','deciliter','decilitre'].includes(u)) return 'dl'
  if (['l','liter','litre','lt','lf'].includes(u)) return 'l'
  if (['st','styck','stk','pcs','piece','pieces','each','ea'].includes(u)) return 'st'
  if (['frp','fp','pack','paket','burk','flaska'].includes(u)) return 'st'
  return u
}
const FAMILY = { g:'mass', kg:'mass', hg:'mass', ml:'volume', cl:'volume', dl:'volume', l:'volume', st:'count' }
const TO_BASE = { g:1, kg:1000, hg:100, ml:1, cl:10, dl:100, l:1000, st:1 }
const baseFor = f => f === 'mass' ? 'g' : f === 'volume' ? 'ml' : 'st'

function parsePack(name, invoice_unit) {
  if (name) {
    const matches = Array.from(String(name).matchAll(PACK_RE))
    if (matches.length > 0) {
      const m = matches[matches.length - 1]
      const num = Number(m[1].replace(',', '.'))
      if (Number.isFinite(num) && num > 0) {
        const u = canonicalUnit(m[2])
        if (u && FAMILY[u]) return { pack_size: num * TO_BASE[u], base_unit: baseFor(FAMILY[u]), source: 'name', raw: m[0] }
      }
    }
  }
  if (invoice_unit) {
    const inv = canonicalUnit(invoice_unit)
    if (inv && FAMILY[inv]) return { pack_size: TO_BASE[inv], base_unit: baseFor(FAMILY[inv]), source: 'invoice_unit', raw: 'invoice unit ' + invoice_unit }
  }
  return null
}

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

const APPLY = process.argv.includes('--apply')

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══`)

  // Pull EVERY product where pack_size IS NULL — simplest predicate.
  const candidates = []
  let from = 0
  while (true) {
    const { data, error } = await db.from('products')
      .select('id, name, invoice_unit, pack_size, base_unit')
      .eq('business_id', biz.id)
      .is('archived_at', null)
      .is('pack_size', null)
      .order('id').range(from, from + 999)
    if (error) { console.error('SELECT:', error.message); break }
    if (!data || data.length === 0) break
    candidates.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  console.log(`  candidates with pack_size IS NULL: ${candidates.length}`)

  let appliedName = 0, appliedInvoice = 0, stillMissing = 0
  for (const p of candidates) {
    const sug = parsePack(p.name, p.invoice_unit)
    if (!sug) { stillMissing++; continue }
    if (APPLY) {
      const { error } = await db.from('products')
        .update({ pack_size: sug.pack_size, base_unit: sug.base_unit })
        .eq('id', p.id)
      if (error) {
        console.error(`    UPDATE FAILED ${p.id} "${p.name}": ${error.message}`)
        continue
      }
    }
    if (sug.source === 'name') appliedName++
    else appliedInvoice++
  }
  console.log(`  ${APPLY ? 'applied' : 'would apply'}: ${appliedName + appliedInvoice}  (from name: ${appliedName}, from invoice_unit: ${appliedInvoice})`)
  console.log(`  still missing: ${stillMissing}`)
}

console.log('\ndone')
