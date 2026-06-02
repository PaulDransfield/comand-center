// One-shot — back-fill pack_source for products updated by the Phase A
// run before the M119 column existed. Re-runs the parser per product
// and tags the source.
//
// SAFE: only writes pack_source where it's currently NULL AND pack_size
// IS NOT NULL. Doesn't touch pack_size/base_unit themselves.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

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

function inferSource(name, invoice_unit) {
  // Mirror parseProductPackSize — name first, invoice_unit fallback.
  if (name) {
    const matches = Array.from(String(name).matchAll(PACK_RE))
    for (const m of matches) {
      const u = canonicalUnit(m[2])
      if (u && FAMILY[u]) return 'name_parsed'
    }
  }
  if (invoice_unit) {
    const inv = canonicalUnit(invoice_unit)
    if (inv && FAMILY[inv]) return 'invoice_unit_inferred'
  }
  return null  // shouldn't happen for products that already have pack_size
}

const APPLY = process.argv.includes('--apply')
const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══`)

  const products = []
  let from = 0
  while (true) {
    const { data, error } = await db.from('products')
      .select('id, name, invoice_unit, pack_size, pack_source')
      .eq('business_id', biz.id)
      .is('archived_at', null)
      .not('pack_size', 'is', null)
      .is('pack_source', null)
      .order('id').range(from, from + 999)
    if (error) { console.error(error.message); break }
    if (!data || data.length === 0) break
    products.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  console.log(`  pack_size set but pack_source NULL: ${products.length}`)

  let nameCount = 0, invCount = 0, llmCount = 0, unknownCount = 0
  for (const p of products) {
    const src = inferSource(p.name, p.invoice_unit)
    let tag = src
    // If neither name nor invoice_unit explains it, it likely came from
    // either an explicit owner edit OR the LLM Phase B writes. Without
    // tracking we can't tell — mark as 'ai_inferred' if the product is
    // in the alcohol category (Phase B was alcohol-only), else 'unknown'.
    if (!tag) {
      // Need to look up category — quick fetch.
      const { data: catRow } = await db.from('products').select('category').eq('id', p.id).maybeSingle()
      if (catRow?.category === 'alcohol') { tag = 'ai_inferred'; llmCount++ }
      else { tag = null; unknownCount++ }
    } else if (tag === 'name_parsed') nameCount++
    else if (tag === 'invoice_unit_inferred') invCount++

    if (APPLY && tag) {
      const { error } = await db.from('products')
        .update({ pack_source: tag })
        .eq('id', p.id)
      if (error) console.error(`    ${p.id} update failed: ${error.message}`)
    }
  }
  console.log(`  ${APPLY ? 'wrote' : 'would write'} pack_source:`)
  console.log(`    name_parsed:            ${nameCount}`)
  console.log(`    invoice_unit_inferred:  ${invCount}`)
  console.log(`    ai_inferred (alcohol):  ${llmCount}`)
  console.log(`    unknown (left NULL):    ${unknownCount}`)
}

console.log('\ndone')
