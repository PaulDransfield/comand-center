// scripts/recategorise-other-products.mjs
// Sweeps every product currently in category='other' for the given
// business and asks Claude Haiku 4.5 to re-classify by name alone.
// Updates products.category + sets category_overridden=true.
//
// The catalogue's auto-classifier uses BAS account number → category
// routing; when the bookkeeper booked a generic 4000 account (no
// subcategory split) the product fell into 'other'. This script
// fixes that retroactively now that we have all the product names.
//
// Run: node --env-file=.env.production.local scripts/recategorise-other-products.mjs <business_id>

import { createClient } from '@supabase/supabase-js'

const BIZ_ID = process.argv[2] ?? '63ada0ac-18af-406a-8ad3-4acfd0379f2c'   // Chicce by default
const HAIKU  = 'claude-haiku-4-5-20251001'
const BATCH  = 100

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// 1. Load all products currently 'other'
const { data: products, error } = await db.from('products')
  .select('id, name')
  .eq('business_id', BIZ_ID)
  .eq('category', 'other')
  .is('archived_at', null)
  .order('name')
if (error) { console.error('product load failed:', error.message); process.exit(1) }
console.log('Products in "other":', products?.length ?? 0)
if (!products?.length) process.exit(0)

const SYSTEM = `You are an expert at categorising Swedish restaurant supplier products. Given a list of product names (mostly in Swedish, some abbreviations), classify each into ONE of these categories:

  food              — raw food ingredients (meat, fish, dairy, produce, dry goods, spices, sauces, oils)
  beverage          — non-alcoholic drinks (soda, juice, sparkling water, energy drinks, oat milk, tonic mixers)
  alcohol           — wine, beer, spirits, liqueurs, cider
  cleaning          — cleaning chemicals, soaps, detergents, sanitisers
  takeaway_material — takeaway containers, bags, cutlery used for serving to customers
  disposables       — kitchen disposables (gloves, foil, parchment, food bags, candles, batteries, paper goods that aren't customer-facing)
  other             — genuinely doesn't fit any of the above (services, fees, mystery items)

CALIBRATION:
- Swedish food words: kött, fisk, lax, kyckling, fläsk, kalv, ägg, ost, mjölk, gräddi, grönsak, frukt, bär, mjöl, ris, pasta, krydda, sallad, etc.
- Wine producers and grape varieties (Barolo, Chianti, Brunello, Nebbiolo, Pinot, Chardonnay, etc.) → alcohol
- Spirits brand names (Tanqueray, Jameson, Ketel One, Aperol, Campari, Fernet, Galliano, etc.) → alcohol
- Soft drink brands (Coca Cola, Fanta, Sprite, Pommac, Festis, Ramlösa, San Pellegrino, Aranciata, Limonata) → beverage
- Tonic / mixer brands (Three Cents, Botanical Tonic, Hammars, Thomas H) → beverage
- Glassware, plastic containers, paper bags, packaging → disposables
- Aluminium foil, food film, freezer bags → disposables
- Servietter (napkins), customer-facing → takeaway_material
- Rengöringsmedel, diskmedel, klor, avkalkning → cleaning

Return JSON only — one entry per product in input order:
[{"id":"abc...","category":"food"},{"id":"def...","category":"alcohol"},...]

When uncertain, return "other" (don't guess wildly).`

const PRICING_IN  = 1 / 1_000_000   // Haiku 4.5
const PRICING_OUT = 5 / 1_000_000

let totalRecategorised = 0
let totalCost = 0
const newCounts = {}

for (let i = 0; i < products.length; i += BATCH) {
  const slice = products.slice(i, i + BATCH)
  const listing = slice.map(p => JSON.stringify({ id: p.id.slice(0, 16), name: p.name })).join('\n')

  const t0 = Date.now()
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: HAIKU, max_tokens: 8192,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Classify these ${slice.length} products:\n\n${listing}\n\nReturn JSON array only.` }],
    }),
  })
  if (!r.ok) { console.error(`batch ${i/BATCH + 1} HTTP ${r.status}:`, await r.text()); break }
  const json = await r.json()
  const tIn = json.usage?.input_tokens ?? 0, tOut = json.usage?.output_tokens ?? 0
  const cost = tIn * PRICING_IN + tOut * PRICING_OUT
  totalCost += cost

  const raw = json.content?.[0]?.text ?? ''
  const start = raw.indexOf('['), end = raw.lastIndexOf(']') + 1
  let parsed
  try { parsed = JSON.parse(raw.slice(start, end)) }
  catch (e) { console.error('parse failed:', e.message, 'preview:', raw.slice(0, 200)); break }

  // Map 16-char prefix back to full id
  const idByPrefix = new Map(slice.map(p => [p.id.slice(0, 16), p.id]))
  const updates = []
  for (const e of parsed) {
    const fullId = idByPrefix.get(e.id)
    if (!fullId) continue
    const cat = String(e.category ?? '').toLowerCase()
    if (!['food','beverage','alcohol','cleaning','takeaway_material','disposables','other'].includes(cat)) continue
    if (cat === 'other') continue   // skip — leave as-is
    updates.push({ id: fullId, category: cat })
    newCounts[cat] = (newCounts[cat] ?? 0) + 1
  }

  // Apply updates one-by-one (small number, simpler than building a CASE)
  let appliedThisBatch = 0
  for (const u of updates) {
    const { error: uErr } = await db.from('products')
      .update({ category: u.category, category_overridden: true })
      .eq('id', u.id)
    if (uErr) { console.error('update err:', uErr.message); break }
    appliedThisBatch++
  }
  totalRecategorised += appliedThisBatch
  console.log(`  batch ${i / BATCH + 1}: ${slice.length} products → ${updates.length} recategorised (${Date.now() - t0}ms, $${cost.toFixed(4)})`)
}

console.log('\n=== SUMMARY ===')
console.log('Total recategorised:', totalRecategorised, '/', products.length)
console.log('Cost: $' + totalCost.toFixed(4))
console.log('By category:')
for (const [c, n] of Object.entries(newCounts).sort((a, b) => b[1] - a[1])) console.log(' ', n.toString().padStart(4), c)

// Final tally — what's still in 'other'
const { count: stillOther } = await db.from('products')
  .select('*', { count: 'exact', head: true })
  .eq('business_id', BIZ_ID).eq('category', 'other').is('archived_at', null)
console.log('Still in "other" after sweep:', stillOther)
