// run-llm-density-suggest.mjs
//
// Driver — finds products with mass↔volume density gap, sends to Haiku,
// applies confident classifications (>= 0.85) to products.density_g_per_ml.
//
// Usage:
//   node scripts/diag/run-llm-density-suggest.mjs           # DRY
//   node scripts/diag/run-llm-density-suggest.mjs --apply   # write
//
// Requires M120 SQL applied (products.density_g_per_ml column exists).
// Otherwise the UPDATE fails with 42703 and the script reports.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY
if (!ANTHROPIC_KEY) { console.error('ANTHROPIC_API_KEY missing'); process.exit(1) }

const APPLY = process.argv.includes('--apply')
const MODEL = 'claude-haiku-4-5-20251001'

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

function unitFamily(unit) {
  if (!unit) return null
  const u = String(unit).trim().toLowerCase()
  if (['g','kg','hg','gram','grams','gr','kilo','kilogram','kilograms','hekto','hektogram'].includes(u)) return 'mass'
  if (['ml','cl','dl','l','eg','milliliter','centiliter','deciliter','liter','litre','lt','lf'].includes(u)) return 'volume'
  return null
}

const SYSTEM_PROMPT = `You classify cooking/food products and pick a density in g/ml so a recipe asking "30 g of olive oil" can be costed by a supplier line priced per ml.

CLASSES + CONVENTION DENSITIES:
  - oil         (olive, rapeseed, sunflower, sesame, ...)          → 0.91
  - vinegar     (wine, balsamic, apple cider, rice, ...)            → 1.01
  - syrup       (sugar syrup, agave, maple, simple syrup, ...)      → 1.30
  - honey                                                           → 1.42
  - milk        (whole, skimmed, oat, soy, almond, ...)             → 1.03
  - cream       (heavy, light, sour, crème fraîche, double, ...)    → 1.00
  - water_based (stock, broth, juice, water, lemonade, ...)         → 1.00
  - butter      (always melted in volumetric cooking)               → 0.86
  - alcohol     (wine, spirits, beer used as ingredient)            → 0.95
  - sauce       (tomato, gravy, soy, fish, ...)                     → 1.05
  - other       (anything that doesn't fit above)                   → 1.00

NAME RECOGNITION — Swedish + Italian common:
  - "olja", "olio", "oil", "EVO", "rapsolja", "olivolja"            → oil
  - "vinäger", "aceto", "vinegar", "balsamico"                      → vinegar
  - "honung", "miele", "honey"                                      → honey
  - "sirap", "syrup", "agave", "lönnsirap"                          → syrup
  - "mjölk", "latte", "milk", "havremjölk"                          → milk
  - "grädde", "panna", "cream", "fraiche"                           → cream
  - "buljong", "fond", "stock", "broth", "juice", "saft"            → water_based
  - "smör", "butter"                                                → butter
  - "vin", "wine", "brännvin", "öl", "beer", "sprit"                → alcohol
  - "sås", "salsa", "ketchup", "soja", "fisksås"                    → sauce

HONEST-INCOMPLETE — set confidence < 0.85 when:
  - Product class is ambiguous (e.g. "Castorino Cream" — dairy or skincare?)
  - Not actually a cooking ingredient
  - You'd need to guess between two very different densities

OUTPUT: Return ONLY valid JSON (no markdown, no commentary):

{
  "items": [
    { "product_id": "<uuid>", "density_g_per_ml": <number>, "classification": "oil|vinegar|syrup|honey|milk|cream|water_based|butter|alcohol|sauce|other", "confidence": <0.0-1.0>, "reasoning": "<1 short sentence>" }
  ]
}

Include every product_id from the input.`

async function callHaiku(products) {
  const lines = products.map(p => {
    const parts = [`id=${p.product_id}`, `name="${p.name}"`]
    if (p.category) parts.push(`category=${p.category}`)
    if (p.invoice_unit) parts.push(`invoice_unit=${p.invoice_unit}`)
    if (p.base_unit) parts.push(`base_unit=${p.base_unit}`)
    if (p.pack_size != null) parts.push(`pack_size=${p.pack_size}`)
    return parts.join(' | ')
  }).join('\n')
  const userMsg = `Classify these cooking products and return density_g_per_ml for each:\n\n${lines}`
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userMsg }] }),
  })
  if (!r.ok) return { ok: false, error: `Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}` }
  const j = await r.json()
  const text = (j.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('').trim()
  const start = text.indexOf('{'); const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, error: 'no JSON', raw: text.slice(0, 500) }
  let parsed
  try { parsed = JSON.parse(text.slice(start, end + 1)) }
  catch (e) { return { ok: false, error: `JSON: ${e.message}`, raw: text.slice(0, 500) } }
  return { ok: true, items: parsed.items ?? [], tokensIn: j.usage?.input_tokens ?? 0, tokensOut: j.usage?.output_tokens ?? 0 }
}

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)

  // 1. recipes in business
  const recipeIds = []
  let from = 0
  while (true) {
    const { data, error } = await db.from('recipes')
      .select('id').eq('business_id', biz.id).order('id').range(from, from + 999)
    if (error) { console.error(error.message); break }
    if (!data || data.length === 0) break
    for (const r of data) recipeIds.push(r.id)
    if (data.length < 1000) break
    from += 1000
  }

  // 2. recipe_ingredients
  const ingredients = []
  for (let i = 0; i < recipeIds.length; i += 100) {
    const slice = recipeIds.slice(i, i + 100)
    const { data, error } = await db.from('recipe_ingredients')
      .select('product_id, unit')
      .in('recipe_id', slice)
      .not('product_id', 'is', null)
    if (error) { console.error(error.message); continue }
    ingredients.push(...(data ?? []))
  }

  // 3. fetch products
  const productIds = [...new Set(ingredients.map(i => i.product_id))]
  const products = new Map()
  for (let i = 0; i < productIds.length; i += 100) {
    const slice = productIds.slice(i, i + 100)
    const { data, error } = await db.from('products')
      .select('id, name, category, invoice_unit, pack_size, base_unit, density_g_per_ml')
      .in('id', slice)
    if (error) {
      if (/density_g_per_ml.*does not exist/i.test(error.message)) {
        console.error(`\n  M120 SQL not applied yet — products.density_g_per_ml column missing.`)
        console.error(`  Run sql/M120-PRODUCTS-DENSITY.sql in the Supabase SQL editor first.\n`)
        process.exit(2)
      }
      console.error(error.message); continue
    }
    for (const p of data ?? []) products.set(p.id, p)
  }

  // 4. find density gap (excludes products that already have density set)
  const seen = new Set()
  const candidates = []
  for (const ing of ingredients) {
    const p = products.get(ing.product_id)
    if (!p) continue
    if (seen.has(p.id)) continue
    if (p.pack_size == null || p.base_unit == null) continue
    if (p.density_g_per_ml != null) continue   // already set
    const rFam = unitFamily(ing.unit)
    const bFam = unitFamily(p.base_unit)
    if (!rFam || !bFam || rFam === bFam) continue
    if (!((rFam === 'mass' && bFam === 'volume') || (rFam === 'volume' && bFam === 'mass'))) continue
    seen.add(p.id)
    candidates.push({
      product_id:   p.id,
      name:         p.name,
      category:     p.category,
      invoice_unit: p.invoice_unit,
      base_unit:    p.base_unit,
      pack_size:    p.pack_size,
    })
  }

  console.log(`  density gap candidates: ${candidates.length}`)
  if (candidates.length === 0) continue

  console.log(`  → calling Haiku (1 batch, ${candidates.length} products)`)
  const r = await callHaiku(candidates)
  if (!r.ok) { console.error(`    FAILED: ${r.error}`); if (r.raw) console.error(`    raw: ${r.raw}`); continue }
  console.log(`  Tokens: in=${r.tokensIn} out=${r.tokensOut} (~$${(r.tokensIn * 0.000001 + r.tokensOut * 0.000005).toFixed(4)})`)

  const sugs = []
  const skipped = []
  for (const it of r.items) {
    const pid  = String(it.product_id ?? '')
    const dens = Number(it.density_g_per_ml)
    const conf = Number(it.confidence)
    const cls  = String(it.classification ?? '')
    const rsn  = String(it.reasoning ?? '').slice(0, 200)
    if (!pid || !Number.isFinite(dens) || dens < 0.5 || dens > 1.5) {
      skipped.push({ pid, reason: `bad density ${it.density_g_per_ml}`, conf }); continue
    }
    if (!Number.isFinite(conf) || conf < 0.85) {
      skipped.push({ pid, reason: `conf ${conf} (${rsn})`, conf }); continue
    }
    sugs.push({ product_id: pid, density: Math.round(dens * 100) / 100, classification: cls, confidence: conf, reasoning: rsn })
  }

  console.log(`\n  Confident: ${sugs.length}    Skipped: ${skipped.length}`)
  if (sugs.length > 0) {
    console.log(`  Suggestions:`)
    const byId = new Map(candidates.map(c => [c.product_id, c]))
    for (const s of sugs) {
      const p = byId.get(s.product_id)
      console.log(`    • "${p?.name ?? '?'}" — ${s.classification}, density=${s.density} g/ml (conf ${s.confidence.toFixed(2)})`)
      console.log(`      ${s.reasoning}`)
    }
  }
  if (skipped.length > 0) {
    console.log(`  Skipped:`)
    const byId = new Map(candidates.map(c => [c.product_id, c]))
    for (const s of skipped) {
      const p = byId.get(s.pid)
      console.log(`    • "${p?.name ?? '?'}" — ${s.reason}`)
    }
  }

  if (APPLY && sugs.length > 0) {
    console.log(`\n  APPLYING ${sugs.length} updates…`)
    let applied = 0
    for (const s of sugs) {
      const { error } = await db.from('products')
        .update({
          density_g_per_ml: s.density,
          density_source:   'ai_inferred',
        })
        .eq('id', s.product_id)
      if (error) { console.error(`    ${s.product_id} update failed: ${error.message}`); continue }
      applied++
    }
    console.log(`  Applied: ${applied}`)
  } else if (sugs.length > 0) {
    console.log(`\n  (DRY mode — re-run with --apply to write)`)
  }
}

console.log('\ndone')
