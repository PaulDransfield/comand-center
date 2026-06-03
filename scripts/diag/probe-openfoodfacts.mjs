// Probe OpenFoodFacts hit rate on a sample of our GTINs.
// Reports: % found, what fields are populated.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const SAMPLE = 30
const UA = 'CommandCenter/1.0 (paul@laweka.com)'

const { data: rows } = await db.from('supplier_articles')
  .select('article_number, gtin, official_name')
  .not('gtin','is',null)
  .limit(SAMPLE * 3)   // overfetch to allow for duplicates
const seen = new Set()
const sample = []
for (const r of rows ?? []) {
  if (seen.has(r.gtin)) continue
  seen.add(r.gtin)
  sample.push(r)
  if (sample.length >= SAMPLE) break
}
console.log(`Probing ${sample.length} distinct GTINs...\n`)

const buckets = { found: 0, not_found: 0, error: 0 }
const fieldHits = {
  product_name: 0, brands: 0, image_url: 0,
  ingredients_text: 0, allergens_tags: 0, categories: 0,
  nutriments: 0, nutriscore: 0, ecoscore: 0,
  quantity: 0,
}

for (const r of sample) {
  // OpenFoodFacts stores barcodes WITHOUT leading zeros normalised away —
  // try the GTIN as-is first.
  const gtin = String(r.gtin)
  // Strip leading zeros only if the GTIN is 14-digit (GS1 padded).
  const candidate = gtin.length === 14 && gtin.startsWith('0') ? gtin.slice(1) : gtin

  try {
    const r2 = await fetch(`https://world.openfoodfacts.org/api/v2/product/${candidate}.json`, {
      headers: { 'User-Agent': UA },
    })
    if (!r2.ok) { buckets.error++; console.log(`  ${candidate}  HTTP ${r2.status}  "${r.official_name?.slice(0,40)}"`); continue }
    const j = await r2.json()
    if (j.status !== 1) { buckets.not_found++; console.log(`  ${candidate}  not_found  "${r.official_name?.slice(0,40)}"`); continue }
    buckets.found++
    const p = j.product
    if (p.product_name) fieldHits.product_name++
    if (p.brands) fieldHits.brands++
    if (p.image_url || p.image_front_url) fieldHits.image_url++
    if (p.ingredients_text) fieldHits.ingredients_text++
    if (Array.isArray(p.allergens_tags) && p.allergens_tags.length) fieldHits.allergens_tags++
    if (p.categories) fieldHits.categories++
    if (p.nutriments && Object.keys(p.nutriments).length > 5) fieldHits.nutriments++
    if (p.nutriscore_grade) fieldHits.nutriscore++
    if (p.ecoscore_grade && p.ecoscore_grade !== 'unknown') fieldHits.ecoscore++
    if (p.quantity) fieldHits.quantity++
    console.log(`  ${candidate}  FOUND  "${p.product_name?.slice(0,40) ?? '?'}" ${p.brands ? `[${p.brands.slice(0,25)}]` : ''}`)
  } catch (e) {
    buckets.error++
    console.log(`  ${candidate}  ERROR  ${e.message}`)
  }
  // Polite rate limit
  await new Promise(r => setTimeout(r, 100))
}

console.log(`\n=== Summary ===`)
console.log(`  Found:      ${buckets.found} / ${sample.length}  (${(buckets.found/sample.length*100).toFixed(0)}%)`)
console.log(`  Not found:  ${buckets.not_found}`)
console.log(`  Errored:    ${buckets.error}`)

if (buckets.found > 0) {
  console.log(`\nField coverage among ${buckets.found} found products:`)
  for (const [k, v] of Object.entries(fieldHits)) {
    console.log(`  ${k.padEnd(20)} ${v} / ${buckets.found}  (${(v/buckets.found*100).toFixed(0)}%)`)
  }
}
