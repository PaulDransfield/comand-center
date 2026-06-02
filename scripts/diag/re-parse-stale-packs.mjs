// re-parse-stale-packs.mjs
//
// Re-run the current parseProductPackSize on every product. Compare
// with stored pack_size/base_unit. Where the parser now gives a result
// that's:
//   - DIFFERENT from stored AND
//   - the source is 'name' (stronger than invoice_unit fallback) AND
//   - the stored pack_source is auto-set ('name_parsed' /
//     'invoice_unit_inferred') — never overwrite owner-edited values
//   - the new result isn't pack=1 base=st (that's the "we couldn't
//     parse anything meaningful, gave up" fallback)
// → update.
//
// Catches products created before Phase A regex extensions (long-form
// 'gram'/'gr'/'liter'/'eg'/'lf' alternations). Schiacciata "1200 gr"
// is the canonical example — original regex matched nothing, invoice_unit
// fallback set pack=1 st; current regex matches "1200 gr" → pack=1200 g.
//
// Usage:
//   node scripts/diag/re-parse-stale-packs.mjs           # DRY
//   node scripts/diag/re-parse-stale-packs.mjs --apply

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
const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

// Mirror lib/inventory/unit-conversion.ts EXACTLY.
const PACK_RE = /(\d+(?:[.,]\d+)?)\s*(kilogram|kilograms|kilo|kg|hg|gram|grams|gr|g|liter|litre|lt|lf|l|deciliter|decilitre|dl|centiliter|centilitre|cl|eg|milliliter|millilitre|ml|styck|stk|st|pcs|burk|flaska|paket|pkt|frp|fp|pack)\b/gi
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
  if (['st','styck','stk','pcs'].includes(u)) return 'st'
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
    if (inv && FAMILY[inv]) return { pack_size: TO_BASE[inv], base_unit: baseFor(FAMILY[inv]), source: 'invoice_unit', raw: `invoice unit ${invoice_unit}` }
  }
  return null
}

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)

  const products = []
  let from = 0
  while (true) {
    const { data, error } = await db.from('products')
      .select('id, name, invoice_unit, pack_size, base_unit, pack_source')
      .eq('business_id', biz.id)
      .is('archived_at', null)
      .order('id').range(from, from + 999)
    if (error) { console.error(error.message); break }
    if (!data || data.length === 0) break
    products.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  console.log(`  active products: ${products.length}`)

  const corrections = []
  let nameOverInvoice = 0   // current name-parse beats stored invoice_unit-inference
  let nameDiffersFromName = 0   // current name-parse gives different result than stored name-parse
  let identical = 0
  let noChange = 0

  for (const p of products) {
    const parsed = parsePack(p.name, p.invoice_unit)
    if (!parsed) { noChange++; continue }

    const same = (p.pack_size != null && Number(p.pack_size) === parsed.pack_size && p.base_unit === parsed.base_unit)
    if (same) { identical++; continue }

    // Only update where stored is auto-set (matcher / backfill / LLM).
    // Don't touch manually-edited products.
    if (p.pack_source && !['name_parsed', 'invoice_unit_inferred', 'ai_inferred', null].includes(p.pack_source)) {
      noChange++; continue
    }

    // Promote rules:
    //   - new source='name' AND stored was invoice_unit_inferred → promote (name beats fallback)
    //   - new source='name' AND stored was name_parsed → only if NEW result differs (regex extended)
    //   - new source='invoice_unit' → already would be the stored result if relevant; no value
    if (parsed.source !== 'name') { noChange++; continue }

    // RESTRICT to "we gave up" fallback only: old pack=1 base=st (the
    // matcher's last-resort when name parsing returned null + invoice_unit
    // wasn't a canonical mass/volume). This catches Schiacciata "1200 gr",
    // wine 70eg St, jarred goods etc. without regressing cases where the
    // OLD parser gave a meaningful value (e.g. "Torskfilé 100/300 gr"
    // stored as 1000g — name parses "300 gr" but that's a fish-grade
    // range, NOT a pack size; we should NOT downgrade 1000→300).
    const wasGiveUpFallback = p.pack_size != null && Number(p.pack_size) === 1 && p.base_unit === 'st'
    const wasNullPack       = p.pack_size == null
    if (!wasGiveUpFallback && !wasNullPack) { noChange++; continue }

    if (p.pack_source === 'invoice_unit_inferred' || p.pack_source == null) {
      nameOverInvoice++
    } else if (p.pack_source === 'name_parsed') {
      nameDiffersFromName++
    }

    corrections.push({
      id:         p.id,
      name:       p.name,
      old_pack:   p.pack_size,
      old_base:   p.base_unit,
      old_source: p.pack_source,
      new_pack:   parsed.pack_size,
      new_base:   parsed.base_unit,
      match:      parsed.raw,
    })
  }

  console.log(`  identical (no change needed):                    ${identical}`)
  console.log(`  no name-parse / not in safe-update bucket:       ${noChange}`)
  console.log(`  CORRECTIONS: ${corrections.length}`)
  console.log(`    name promoted over invoice_unit fallback:      ${nameOverInvoice}`)
  console.log(`    name-parse differs (regex extended since):     ${nameDiffersFromName}`)

  if (corrections.length > 0) {
    console.log(`\n  Sample corrections (first 20):`)
    for (const c of corrections.slice(0, 20)) {
      console.log(`    • "${c.name}"`)
      console.log(`        ${c.old_pack ?? '∅'} ${c.old_base ?? '∅'} (${c.old_source ?? '∅'}) → ${c.new_pack} ${c.new_base}  (matched "${c.match}")`)
    }
  }

  if (APPLY && corrections.length > 0) {
    console.log(`\n  APPLYING ${corrections.length} corrections…`)
    let ok = 0
    for (const c of corrections) {
      const { error } = await db.from('products')
        .update({ pack_size: c.new_pack, base_unit: c.new_base, pack_source: 'name_parsed' })
        .eq('id', c.id)
      if (error) { console.error(`    "${c.name}" failed: ${error.message}`); continue }
      ok++
    }
    console.log(`  Updated: ${ok}`)
  } else if (corrections.length > 0) {
    console.log(`\n  (DRY mode — re-run with --apply to write)`)
  }
}

console.log('\ndone')
