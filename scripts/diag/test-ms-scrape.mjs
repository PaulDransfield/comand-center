// Test Martin Servera product page scrape — 5 products.
// Fetch HTML, strip to <body>, hand to Haiku to extract structured fields.
// Compare against our DB record for each.

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

// Find 5 MS products with numeric article numbers (most likely to be the MS internal ID).
const { data: lines } = await db.from('supplier_invoice_lines')
  .select('raw_description, article_number, product_alias_id')
  .ilike('supplier_name_snapshot', '%Martin Servera%')
  .not('article_number', 'is', null)
  .not('product_alias_id', 'is', null)
  .limit(50)

const seen = new Set()
const pickedLines = []
for (const l of lines ?? []) {
  if (!/^\d{4,8}$/.test(l.article_number)) continue   // pure-numeric IDs only
  if (seen.has(l.article_number)) continue
  seen.add(l.article_number); pickedLines.push(l)
  if (pickedLines.length >= 5) break
}

console.log(`Testing ${pickedLines.length} products:`)
for (const l of pickedLines) console.log(`  ${l.article_number} | "${l.raw_description}"`)

const SYSTEM_PROMPT = `You parse a Martin Servera product page (Swedish wholesale food supplier) and extract structured fields. The HTML is messy — Next.js SSR with React Server Components chunks. Look for the product info embedded in text + JSON-like fragments.

Return ONLY valid JSON (no markdown, no commentary):

{
  "name":           "<full product name>",
  "description":    "<full description text, 1-3 paragraphs>",
  "image_url":      "<full media.martinservera.se URL to the product image, or null>",
  "ean":            "<13-digit GTIN/EAN code, or null>",
  "brand":          "<brand name, or null>",
  "category_path":  "<top-level → leaf category, slash-separated, or null>",
  "ingredients":    "<full ingredients list as written, or null>",
  "allergens":      ["<allergen>", ...]   // or empty array,
  "nutrition":      { "energy_kj": <number or null>, "fat_g": <number>, "carbs_g": <number>, "protein_g": <number>, "salt_g": <number> } | null,
  "net_weight_kg":  <number or null>,
  "pack_size_text": "<e.g. '2,5 kg', '8 x 250 g', or null>",
  "origin_country": "<country, or null>",
  "storage_temp":   "<e.g. 'fryst -18°C', 'kyl 0-4°C', 'rumstemp', or null>",
  "confidence":     <0.0-1.0>
}

Use null for fields you can't reliably extract. Don't guess. Image URL must be a full https:// URL pointing at media.martinservera.se (NOT a logo or banner).`

async function fetchPage(articleNumber) {
  const r = await fetch(`https://www.martinservera.se/produkter/${articleNumber}/`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'sv,en;q=0.9',
    },
  })
  if (!r.ok) return null
  return await r.text()
}

function trimHtml(html) {
  let s = html
  // Strip <style> (CSS noise — no product data ever).
  s = s.replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ')
  // Strip Next.js prefetch/preload link rels (no product data).
  s = s.replace(/<link\s+rel="(preload|prefetch|stylesheet)"[^>]*>/g, ' ')
  // KEEP <script> — Next.js RSC chunks hold the product data in
  // self.__next_f.push([1, "..."]) payloads. EAN, ingredients, image
  // URLs are all in there.
  // Strip very obvious bundle-loader script tags (no data, all .js URLs).
  s = s.replace(/<script\s+src="[^"]*"\s*(?:async\s*)?(?:defer\s*)?><\/script>/g, ' ')
  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ')
  // Cap at 80k chars (Haiku 200k context, but cost is per-token).
  if (s.length > 80_000) s = s.slice(0, 80_000)
  return s
}

async function extractViaHaiku(html, articleNumber) {
  const userMsg = `Extract product data from this Martin Servera page (article ${articleNumber}):\n\n${html}`
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  })
  if (!r.ok) return { ok: false, error: `Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}` }
  const j = await r.json()
  const text = (j.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('').trim()
  const start = text.indexOf('{'); const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, error: 'no JSON', raw: text.slice(0, 500) }
  try {
    return { ok: true, data: JSON.parse(text.slice(start, end + 1)), tokensIn: j.usage?.input_tokens, tokensOut: j.usage?.output_tokens }
  } catch (e) {
    return { ok: false, error: `JSON: ${e.message}`, raw: text.slice(0, 500) }
  }
}

let totalIn = 0, totalOut = 0
for (const line of pickedLines) {
  console.log(`\n══ Article ${line.article_number} ══`)
  console.log(`  Invoice description: "${line.raw_description}"`)
  const html = await fetchPage(line.article_number)
  if (!html) { console.log('  fetch failed'); continue }
  console.log(`  HTML size: ${html.length} chars`)
  const trimmed = trimHtml(html)
  console.log(`  Trimmed:   ${trimmed.length} chars`)
  const r = await extractViaHaiku(trimmed, line.article_number)
  if (!r.ok) { console.log(`  FAILED: ${r.error}`); if (r.raw) console.log(`  raw: ${r.raw}`); continue }
  totalIn += r.tokensIn ?? 0; totalOut += r.tokensOut ?? 0
  const d = r.data
  console.log(`  ✓ Extracted (conf ${d.confidence ?? '?'}):`)
  console.log(`    name:           "${d.name ?? '∅'}"`)
  console.log(`    image_url:      ${d.image_url ?? '∅'}`)
  console.log(`    ean:            ${d.ean ?? '∅'}`)
  console.log(`    brand:          ${d.brand ?? '∅'}`)
  console.log(`    category:       ${d.category_path ?? '∅'}`)
  console.log(`    pack_size:      ${d.pack_size_text ?? '∅'}  net_kg=${d.net_weight_kg ?? '∅'}`)
  console.log(`    storage:        ${d.storage_temp ?? '∅'}`)
  console.log(`    origin:         ${d.origin_country ?? '∅'}`)
  console.log(`    allergens:      ${(d.allergens ?? []).join(', ') || '∅'}`)
  console.log(`    description:    ${(d.description ?? '').slice(0, 120)}${(d.description ?? '').length > 120 ? '…' : ''}`)
}
console.log(`\nTotal tokens: in=${totalIn} out=${totalOut} (~$${(totalIn * 0.000001 + totalOut * 0.000005).toFixed(4)})`)
console.log(`Avg per product: ~$${((totalIn * 0.000001 + totalOut * 0.000005) / pickedLines.length).toFixed(4)}`)
