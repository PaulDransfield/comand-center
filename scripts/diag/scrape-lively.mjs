// scripts/diag/scrape-lively.mjs
//
// Scrape Lively Wines' catalogue and upsert into supplier_articles
// with sentinel supplier_fortnox_number='LIVELY'.
//
// Lively runs on Shopify which exposes /products.json — clean JSON,
// no AVP, no JS rendering. 93 products as of 2026-06-05, fits in one
// limit=250 call. Each row has title, handle (URL slug), vendor
// (producer), product_type ("Red wine"/"Sweet wine"/"Sparkling"…),
// images[].src, variants[].price + grams + sku.
//
// Volume + ABV aren't structured Shopify fields; they're embedded in
// body_html ("Alcohol: 13.5%", "Grapes: 100% Moscato", "750 ml" etc.).
// We pull them with a few defensive regexes — leave null when the page
// doesn't say so the matcher's volume/ABV gates skip rather than
// false-match.
//
// "Article number" is the Shopify handle (e.g. 'ricossa-moscato').
//
// Usage:
//   node scripts/diag/scrape-lively.mjs                 # dry
//   node scripts/diag/scrape-lively.mjs --apply         # writes
//   node scripts/diag/scrape-lively.mjs --apply --no-images

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const APPLY     = process.argv.includes('--apply')
const NO_IMAGES = process.argv.includes('--no-images')

const SENTINEL_FNX = 'LIVELY'
const BUCKET       = 'supplier-article-images'
const ORIGIN       = 'https://livelywines.se'

// ── body_html parsers ────────────────────────────────────────────────
function stripHtml(s) {
  if (!s) return ''
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim()
}
function parseAbv(text) {
  if (!text) return null
  // ABV context required — bare "100%" is a grape blend ratio, not alcohol.
  // Accept only when preceded by alc/alcohol/abv/vol/alkohol within 12 chars.
  const m = text.match(/(?:alc(?:ohol)?|abv|alkohol|vol(?:ymprocent)?)[^0-9%]{0,12}(\d{1,2}(?:[.,]\d+)?)\s*%/i)
  if (!m) return null
  const v = Number(m[1].replace(',', '.'))
  // Wine ABV realistically 4-22%; spirits up to 60%. Outside that = not ABV.
  return Number.isFinite(v) && v >= 4 && v <= 60 ? v : null
}
function parseVolMl(text, productTitle) {
  if (!text && !productTitle) return null
  const haystack = `${productTitle ?? ''} ${text ?? ''}`
  let m
  if ((m = haystack.match(/(\d{2,4})\s*ml\b/i)))   return Number(m[1])
  if ((m = haystack.match(/(\d{1,3})\s*cl\b/i)))   return Number(m[1]) * 10
  if ((m = haystack.match(/(\d(?:[.,]\d+)?)\s*l(?:iter)?\b/i))) {
    const n = Number(m[1].replace(',', '.'))
    return Number.isFinite(n) ? Math.round(n * 1000) : null
  }
  return null
}

async function fetchAll() {
  // Lively had 93 products as of 2026-06-05; limit=250 covers any
  // realistic growth. Bumping to 250 keeps it one round-trip.
  const r = await fetch(`${ORIGIN}/products.json?limit=250`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  })
  if (!r.ok) throw new Error(`/products.json HTTP ${r.status}`)
  const j = await r.json()
  return j.products ?? []
}

// ── Image cache (mirrors Spendrups + Carlsberg) ───────────────────────
async function cacheImage(url, handle) {
  if (!url) return null
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    const ext = (url.match(/\.(png|jpe?g|webp|gif)/i)?.[1] ?? 'jpg').toLowerCase().replace('jpeg', 'jpg')
    const objectPath = `lively/${handle}.${ext}`
    const { error } = await db.storage.from(BUCKET).upload(objectPath, buf, {
      contentType: r.headers.get('content-type') ?? `image/${ext}`,
      upsert: true,
    })
    if (error) { console.error(`  image upload (${handle}): ${error.message}`); return null }
    return objectPath
  } catch (e) {
    console.error(`  image fetch (${handle}): ${e?.message ?? e}`)
    return null
  }
}

// ── Main ──────────────────────────────────────────────────────────────
console.log(`Lively scrape  apply=${APPLY}  images=${!NO_IMAGES}`)
const products = await fetchAll()
console.log(`Catalogue: ${products.length} products`)

let ok = 0, fail = 0, withImage = 0
for (let i = 0; i < products.length; i++) {
  const p = products[i]
  const handle = String(p.handle ?? '').trim()
  if (!handle) { fail++; continue }
  const text  = stripHtml(p.body_html)
  const abv   = parseAbv(text)
  const volMl = parseVolMl(text, p.title)
  const v0    = (p.variants ?? [])[0] ?? {}
  const img0  = (p.images   ?? [])[0]?.src ?? null
  const price = v0.price ? Number(v0.price) : null
  const grams = v0.grams ? Number(v0.grams) : null

  if ((i + 1) % 20 === 0 || !APPLY) {
    process.stdout.write(`[${i + 1}/${products.length}] ${handle.padEnd(40)} "${(p.title ?? '').slice(0, 36)}" vol=${volMl}ml abv=${abv}%\n`)
  }
  if (!APPLY) { ok++; continue }

  let cachedPath = null
  if (!NO_IMAGES && img0) {
    cachedPath = await cacheImage(img0, handle)
    if (cachedPath) withImage++
  }

  const row = {
    supplier_fortnox_number: SENTINEL_FNX,
    article_number:          handle,
    source:                  'lively_scrape',
    fetched_at:              new Date().toISOString(),
    fetch_status:            'ok',
    official_name:           String(p.title ?? '').trim() || null,
    description:             text ? text.slice(0, 2000) : null,
    category_path:           String(p.product_type ?? '').trim() || null,
    image_url:               img0,
    image_cached_path:       cachedPath,
    image_cached_at:         cachedPath ? new Date().toISOString() : null,
    brand:                   String(p.vendor ?? '').trim() || null,
    country_origin:          null,   // Lively doesn't expose this on the listing
    net_weight_g:            grams,  // Shopify variant.grams — weight inc. bottle
    units_per_pack:          1,
    units_per_pack_label:    null,
    unit:                    'FL',
    properties:              {
      volume_ml:   volMl,
      alcohol_pct: abv,
      shopify_id:  p.id,
      sku:         v0.sku ?? null,
      price_sek:   price,
      tags:        p.tags ?? null,
      article_url: `${ORIGIN}/products/${handle}`,
      source_api:  '/products.json',
    },
  }
  const { error } = await db.from('supplier_articles').upsert(row, { onConflict: 'supplier_fortnox_number,article_number' })
  if (error) { console.error(`  upsert (${handle}): ${error.message}`); fail++; continue }
  ok++
}
console.log(`\nok=${ok}  fail=${fail}  images_cached=${withImage}  total=${products.length}`)
if (!APPLY) console.log('(DRY — re-run with --apply to write)')
