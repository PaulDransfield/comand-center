// Phase B driver — LLM pack-size mop-up for alcohol products.
//
// Walks each business's alcohol products with pack_size IS NULL, batches
// them into Haiku calls (25 per batch), filters to confidence >= 0.85,
// applies the suggestions (or reports DRY).
//
// Usage:
//   node scripts/diag/run-llm-pack-suggest.mjs           # DRY
//   node scripts/diag/run-llm-pack-suggest.mjs --apply   # write
//
// Cost: ~$0.003 per batch of 25 products with Haiku 4.5. 78 products ≈
// 4 batches ≈ $0.015 total — negligible.

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

const APPLY      = process.argv.includes('--apply')
const BATCH_SIZE = 25
const MODEL      = 'claude-haiku-4-5-20251001'

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

const SYSTEM_PROMPT = `You classify Swedish-restaurant alcohol products and pick the pack volume in ml.

INDUSTRY CONVENTIONS (apply unless the name explicitly states otherwise):
  - Still / sparkling / dessert / fortified wine    → 750 ml per bottle
  - Spirits (gin, vodka, whisky, rum, tequila, …)   → 700 ml per bottle  (EU 70cl standard)
  - Liqueur, schnapps, vermouth                      → 700 ml per bottle
  - Beer (single)                                    → 330 ml per bottle
  - Cider (single)                                   → 330 ml per bottle

INVOICE-UNIT INTERPRETATION:
  - BOT / bot / fl / flaska                          → 1 bottle
  - C6 / C12 / C24 / KRT / KART                      → CASE of N bottles (multiply convention)
  - ltr                                              → product is sold as a 1-liter or 1.5-liter bottle (pick the most plausible from the name; default 1000 ml when in doubt)
  - KLI / DEL / TFP / (anything you don't recognise) → AMBIGUOUS — set confidence < 0.85 and we'll skip it

THE NAME ALMOST ALWAYS DISCLOSES THE BOTTLE SIZE IMPLICITLY:
  - "Barolo … 2018", "Brunello di Montalcino", "Chardonnay 2022"   → wine_still, 750 ml
  - "Champagne", "Prosecco", "Cava", "Brut", "Spumante"             → wine_sparkling, 750 ml
  - "Jameson 40%", "Tanqueray Gin", "Beefeater Lond Dry Gin 40%"   → spirits, 700 ml
  - "Baileys", "St Germain Fläderlikör"                             → liqueur, 700 ml
  - "Birra Poretti 5,0%", "IPA", "Lager", "Pilsner"                 → beer, 330 ml per bottle (multiply by case-size when invoice_unit is a case marker)

USE THE INVOICE-LINE PRICE AS A SANITY CHECK:
  - Typical wine cost to a restaurant: 80-1000 kr per BOTTLE
  - Typical spirits cost: 150-600 kr per BOTTLE
  - Typical beer cost: 8-30 kr per BOTTLE. If per-line price is ~500 kr with qty=4, those are clearly 4 CASES, not 4 bottles — derive case_size from supplier convention (Carlsberg usually 20 or 24 per case).

HONEST-INCOMPLETE — set confidence < 0.85 when:
  - Product name is a discount, rebate, or fee line (e.g. "Avtalsrabatt JAMESON 40%", "Pant", "Frakt")
  - Alcohol category is unclear
  - invoice_unit suggests a case but you can't tell the case size from the name OR the per-line price
  - per-line price doesn't fit any reasonable single-bottle OR case interpretation

OUTPUT: Return ONLY valid JSON (no markdown, no commentary):

{
  "items": [
    { "product_id": "<uuid>", "pack_size_ml": <int>, "classification": "wine_still|wine_sparkling|wine_fortified|spirits|liqueur|beer|cider|other_alcohol", "confidence": <0.0-1.0>, "reasoning": "<1 short sentence>" }
  ]
}

Include every product_id from the input — we filter on our side.`

async function callHaiku(products) {
  const lines = products.map(p => {
    const parts = [`id=${p.product_id}`, `name="${p.name}"`]
    if (p.invoice_unit) parts.push(`invoice_unit=${p.invoice_unit}`)
    if (p.supplier_name) parts.push(`supplier=${p.supplier_name}`)
    if (p.latest_qty != null && p.latest_total_sek != null) {
      const per = p.latest_total_sek / Math.max(1, p.latest_qty)
      parts.push(`last_line: qty=${p.latest_qty} total=${p.latest_total_sek.toFixed(2)} per-unit=${per.toFixed(2)} kr`)
    }
    return parts.join(' | ')
  }).join('\n')

  const userMsg = `Classify these alcohol products and return pack_size_ml for each:\n\n${lines}`

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: 4000,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userMsg }],
    }),
  })
  if (!r.ok) {
    const text = await r.text()
    return { ok: false, error: `Anthropic ${r.status}: ${text.slice(0, 200)}` }
  }
  const j = await r.json()
  const blocks = j.content ?? []
  const text = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('').trim()
  const start = text.indexOf('{'); const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, error: 'no JSON', raw: text.slice(0, 500) }
  let parsed
  try { parsed = JSON.parse(text.slice(start, end + 1)) }
  catch (e) { return { ok: false, error: `JSON: ${e.message}`, raw: text.slice(0, 500) } }
  return {
    ok: true,
    items: Array.isArray(parsed.items) ? parsed.items : [],
    tokensIn:  j.usage?.input_tokens ?? 0,
    tokensOut: j.usage?.output_tokens ?? 0,
  }
}

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)

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

  // Enrich with one representative supplier_invoice_line per product so
  // Haiku has the case-vs-bottle anchor. Cheap — single batched query.
  const enriched = []
  for (const p of prods ?? []) {
    const { data: lines } = await db.from('supplier_invoice_lines')
      .select('quantity, total_excl_vat, unit')
      .eq('business_id', biz.id)
      .ilike('raw_description', `%${(p.name ?? '').slice(0, 20)}%`)
      .order('invoice_date', { ascending: false })
      .limit(1)
    const l = lines?.[0]
    enriched.push({
      product_id:        p.id,
      name:              p.name,
      invoice_unit:      p.invoice_unit,
      supplier_name:     p.default_supplier_name,
      latest_qty:        l?.quantity ?? null,
      latest_total_sek:  l?.total_excl_vat ?? null,
      latest_unit:       l?.unit ?? null,
    })
  }

  // Batch through Haiku.
  let totalIn = 0, totalOut = 0
  const allSuggestions = []
  const allSkipped = []
  for (let i = 0; i < enriched.length; i += BATCH_SIZE) {
    const batch = enriched.slice(i, i + BATCH_SIZE)
    console.log(`  batch ${Math.floor(i / BATCH_SIZE) + 1} / ${Math.ceil(enriched.length / BATCH_SIZE)} (${batch.length} products)`)
    const r = await callHaiku(batch)
    if (!r.ok) {
      console.error(`    FAILED: ${r.error}`)
      if (r.raw) console.error(`    raw: ${r.raw}`)
      continue
    }
    totalIn += r.tokensIn; totalOut += r.tokensOut
    for (const item of r.items) {
      const pid  = String(item.product_id ?? '')
      const pack = Number(item.pack_size_ml)
      const conf = Number(item.confidence)
      const cls  = String(item.classification ?? '')
      const rsn  = String(item.reasoning ?? '').slice(0, 200)
      if (!pid || !Number.isFinite(pack) || pack <= 0 || pack > 50_000) {
        allSkipped.push({ product_id: pid, reason: `invalid pack: ${item.pack_size_ml}`, confidence: conf })
        continue
      }
      if (!Number.isFinite(conf) || conf < 0.85) {
        allSkipped.push({ product_id: pid, reason: `low confidence ${conf} (${rsn})`, confidence: conf })
        continue
      }
      allSuggestions.push({ product_id: pid, pack_size_ml: Math.round(pack), classification: cls, confidence: conf, reasoning: rsn })
    }
  }

  console.log(`\n  Confident suggestions (conf >= 0.85): ${allSuggestions.length}`)
  console.log(`  Skipped (low conf or invalid):        ${allSkipped.length}`)
  console.log(`  Tokens: in=${totalIn} out=${totalOut} (~$${(totalIn * 0.000001 + totalOut * 0.000005).toFixed(4)})`)

  // Show sample of suggestions for eyeball.
  if (allSuggestions.length > 0) {
    console.log(`\n  Sample suggestions (first 15):`)
    const productById = new Map(enriched.map(p => [p.product_id, p]))
    for (const s of allSuggestions.slice(0, 15)) {
      const p = productById.get(s.product_id)
      console.log(`    • "${p?.name ?? '?'}" — ${s.classification}, ${s.pack_size_ml} ml (conf ${s.confidence.toFixed(2)})`)
      console.log(`      ${s.reasoning}`)
    }
  }
  if (allSkipped.length > 0) {
    console.log(`\n  Sample SKIPPED (first 10):`)
    const productById = new Map(enriched.map(p => [p.product_id, p]))
    for (const s of allSkipped.slice(0, 10)) {
      const p = productById.get(s.product_id)
      console.log(`    • "${p?.name ?? '?'}" — ${s.reason}`)
    }
  }

  if (APPLY && allSuggestions.length > 0) {
    console.log(`\n  APPLYING ${allSuggestions.length} updates…`)
    let applied = 0
    for (const s of allSuggestions) {
      const { error } = await db.from('products')
        .update({ pack_size: s.pack_size_ml, base_unit: 'ml' })
        .eq('id', s.product_id)
      if (error) { console.error(`    update ${s.product_id} failed: ${error.message}`); continue }
      applied++
    }
    console.log(`  Applied: ${applied}`)
  } else if (allSuggestions.length > 0) {
    console.log(`\n  (DRY mode — re-run with --apply to write)`)
  }
}

console.log('\ndone')
