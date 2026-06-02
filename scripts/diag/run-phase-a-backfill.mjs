// run-phase-a-backfill.mjs
//
// Runs the Phase A pack-size backfill directly against prod via the
// service role — mirrors the logic of
// /api/inventory/items/backfill-pack-size but bypasses HTTP auth so we
// can drive it from the local dev box.
//
// Walks every product where pack_size IS NULL at each of Chicce + Vero,
// calls parseProductPackSize(name, invoice_unit), saves any non-null
// suggestion. Reports per-bucket counts.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Inlined parser (mirrors lib/inventory/unit-conversion.ts). Keep in
// sync — name-first regex pass, invoice_unit fallback when the name
// discloses nothing.
const PACK_RE = /(\d+(?:[.,]\d+)?)\s*(kg|hg|g|l|dl|cl|ml|st|frp|fp|pack|paket)\b/gi
function canonicalUnit(raw) {
  if (!raw) return null
  const u = String(raw).trim().toLowerCase()
  if (!u) return null
  if (['g','gram','gr','grams'].includes(u)) return 'g'
  if (['kg','kilo','kilogram','kilograms'].includes(u)) return 'kg'
  if (['hg','hekto','hektogram'].includes(u)) return 'hg'
  if (['ml','milliliter','millilitre'].includes(u)) return 'ml'
  if (['cl','centiliter','centilitre'].includes(u)) return 'cl'
  if (['dl','deciliter','decilitre'].includes(u)) return 'dl'
  if (['l','liter','litre','lt'].includes(u)) return 'l'
  if (['st','styck','stk','pcs','piece','pieces','each','ea'].includes(u)) return 'st'
  if (['frp','fp','pack','paket'].includes(u)) return 'st'
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
        if (u && FAMILY[u]) {
          return { pack_size: num * TO_BASE[u], base_unit: baseFor(FAMILY[u]), source: 'name', raw: m[0] }
        }
      }
    }
  }
  if (invoice_unit) {
    const inv = canonicalUnit(invoice_unit)
    if (inv && FAMILY[inv]) {
      return { pack_size: TO_BASE[inv], base_unit: baseFor(FAMILY[inv]), source: 'invoice_unit', raw: `invoice unit ${invoice_unit}` }
    }
  }
  return null
}

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)

  // Pull every product without pack_size or base_unit.
  const candidates = []
  let from = 0
  while (true) {
    const { data, error } = await db.from('products')
      .select('id, name, invoice_unit, pack_size, base_unit, category')
      .eq('business_id', biz.id)
      .is('archived_at', null)
      .or('pack_size.is.null,base_unit.is.null')
      .order('id').range(from, from + 999)
    if (error) { console.error('SELECT failed:', error.message); break }
    if (!data || data.length === 0) break
    candidates.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  console.log(`  Candidates (missing pack_size OR base_unit): ${candidates.length}`)

  let appliedFromName    = 0
  let appliedFromInvoice = 0
  let stillMissing       = 0
  const stillMissingSamples = []
  const updates = []

  for (const p of candidates) {
    const sug = parsePack(p.name, p.invoice_unit)
    if (!sug) {
      stillMissing++
      if (stillMissingSamples.length < 30) {
        stillMissingSamples.push({ name: p.name, invoice_unit: p.invoice_unit, category: p.category })
      }
      continue
    }
    updates.push({ id: p.id, pack_size: sug.pack_size, base_unit: sug.base_unit, source: sug.source, name: p.name })
    if (sug.source === 'name') appliedFromName++
    else appliedFromInvoice++
  }

  console.log(`  Would apply: ${updates.length}`)
  console.log(`    from name: ${appliedFromName}`)
  console.log(`    from invoice_unit: ${appliedFromInvoice}`)
  console.log(`  Still missing (no name pack, no canonical invoice unit): ${stillMissing}`)
  if (stillMissingSamples.length > 0) {
    console.log(`\n  Sample of still-missing (need manual touch):`)
    for (const s of stillMissingSamples.slice(0, 20)) {
      console.log(`    • "${s.name}" — invoice_unit: ${s.invoice_unit ?? '∅'} — category: ${s.category ?? '∅'}`)
    }
  }

  // APPLY: do the updates if we have any (batch 50 at a time).
  if (process.argv.includes('--apply') && updates.length > 0) {
    console.log(`\n  APPLYING ${updates.length} updates…`)
    let applied = 0
    for (const u of updates) {
      const { error } = await db.from('products')
        .update({ pack_size: u.pack_size, base_unit: u.base_unit })
        .eq('id', u.id)
      if (error) {
        console.error(`    update ${u.id} failed: ${error.message}`)
        continue
      }
      applied++
    }
    console.log(`  Applied: ${applied}`)
  } else if (updates.length > 0) {
    console.log(`\n  (DRY mode — re-run with --apply to write)`)
    console.log(`\n  Sample of intended updates (first 15):`)
    for (const u of updates.slice(0, 15)) {
      console.log(`    • "${u.name}" → pack=${u.pack_size} base=${u.base_unit} (source: ${u.source})`)
    }
  }
}

console.log('\ndone')
