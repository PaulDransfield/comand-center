// scripts/diag/scrape-enjoy.mjs
//
// Scrape Enjoy Wine & Spirits' wp-json oa_wine catalogue and upsert
// into supplier_articles with sentinel supplier_fortnox_number='ENJOY'.
//
// 441 wines as of 2026-06-05 (X-WP-Total header). wp-json is the only
// API exposed; the public /sortiment/ HTML page renders the grid via
// JS so plain GET shows only 4 megamenu tiles per page.
//
// The wp-json endpoint is SLOW (~5s per item when fully hydrated) so
// we fetch with per_page=20 in PARALLEL chunks of 3. Total ~7-10 min.
//
// Per-product detail (ABV, country, volume) lives on the individual
// product page at /sortiment/<slug>/, not in the wp-json response.
// We fetch the og:image + og:description from there as a second pass —
// that's another 441 × 0.5s = ~4 min, parallelised to ~2 min.
//
// "Article number" = the WordPress slug (e.g. 'a-christmann-riesling').
//
// Usage:
//   node scripts/diag/scrape-enjoy.mjs                      # dry
//   node scripts/diag/scrape-enjoy.mjs --apply              # writes
//   node scripts/diag/scrape-enjoy.mjs --apply --no-images  # skip image caching

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

const SENTINEL_FNX = 'ENJOY'
const BUCKET       = 'supplier-article-images'
const ORIGIN       = 'https://www.enjoywine.se'

const PER_PAGE = 10
const CONCURRENCY = 3   // detail-page fetches only — listing is now serial
const FIELDS   = '_fields=id,title,slug,link,featured_media,date'
const LISTING_TIMEOUT_MS = 90_000

async function fetchListing() {
  // Get total count first
  const head = await fetch(`${ORIGIN}/wp-json/wp/v2/oa_wine?per_page=1&${FIELDS}`, {
    method: 'HEAD',
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  const total = Number(head.headers.get('x-wp-total') ?? 0)
  const pages = Math.ceil(total / PER_PAGE)
  console.log(`Listing: ${total} wines across ${pages} pages of ${PER_PAGE} (serial — wp-json is slow)`)
  const all = []
  for (let page = 1; page <= pages; page++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), LISTING_TIMEOUT_MS)
    try {
      const r = await fetch(`${ORIGIN}/wp-json/wp/v2/oa_wine?per_page=${PER_PAGE}&page=${page}&${FIELDS}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (r.ok) {
        const arr = await r.json()
        all.push(...arr)
      } else {
        console.error(`  page ${page}: HTTP ${r.status}`)
      }
    } catch (e) {
      clearTimeout(timer)
      console.error(`  page ${page}: ${e?.message ?? e}`)
    }
    process.stdout.write(`  page ${page}/${pages} cumulative ${all.length}/${total}\n`)
  }
  return all
}

// Extract structured info from a wine's HTML detail page.
async function fetchDetail(slug) {
  try {
    const r = await fetch(`${ORIGIN}/sortiment/${slug}/`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
    })
    if (!r.ok) return null
    const html = await r.text()
    const ogImage = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? null
    const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ?? null
    const ogDesc  = html.match(/<meta property="og:description" content="([^"]+)"/)?.[1] ?? null
    // Body fields — labels are Swedish ("Alkoholhalt", "Land", "Druva", "Region")
    const abvMatch = html.match(/Alkoholhalt[^0-9]{0,16}(\d+(?:[.,]\d+)?)\s*%/i)
    const abv = abvMatch ? Number(abvMatch[1].replace(',', '.')) : null
    // Country from "Land  <span>FOO</span>" pattern is hard without DOM; try og:description preface.
    return { ogImage, ogTitle, ogDesc, abv }
  } catch { return null }
}

async function cacheImage(url, slug) {
  if (!url) return null
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    const ext = (url.match(/\.(png|jpe?g|webp|gif)/i)?.[1] ?? 'jpg').toLowerCase().replace('jpeg', 'jpg')
    const objectPath = `enjoy/${slug}.${ext}`
    const { error } = await db.storage.from(BUCKET).upload(objectPath, buf, {
      contentType: r.headers.get('content-type') ?? `image/${ext}`,
      upsert: true,
    })
    if (error) { console.error(`  image upload (${slug}): ${error.message}`); return null }
    return objectPath
  } catch (e) { return null }
}

// ── Main ──────────────────────────────────────────────────────────────
console.log(`Enjoy scrape  apply=${APPLY}  images=${!NO_IMAGES}`)
const listing = await fetchListing()
console.log(`Total wines: ${listing.length}`)

// Strip HTML entities from titles like "Crochet Sancerre Blanc Les Amoureuses"
function decodeEntities(s) {
  if (!s) return s
  return s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
          .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
          .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
}

let ok = 0, fail = 0, withImage = 0
for (let i = 0; i < listing.length; i += CONCURRENCY) {
  const batch = listing.slice(i, i + CONCURRENCY)
  const details = await Promise.all(batch.map(w => fetchDetail(w.slug)))
  for (let j = 0; j < batch.length; j++) {
    const w = batch[j]
    const d = details[j]
    const title = decodeEntities(w.title?.rendered ?? '').trim()
    if (!w.slug || !title) { fail++; continue }
    if (!APPLY) { ok++; continue }
    let cachedPath = null
    if (!NO_IMAGES && d?.ogImage) {
      cachedPath = await cacheImage(d.ogImage, w.slug)
      if (cachedPath) withImage++
    }
    const row = {
      supplier_fortnox_number: SENTINEL_FNX,
      article_number:          w.slug,
      source:                  'enjoy_scrape',
      fetched_at:              new Date().toISOString(),
      fetch_status:            'ok',
      official_name:           title,
      description:             d?.ogDesc ?? null,
      category_path:           null,
      image_url:               d?.ogImage ?? null,
      image_cached_path:       cachedPath,
      image_cached_at:         cachedPath ? new Date().toISOString() : null,
      brand:                   null,
      country_origin:          null,
      net_weight_g:            null,
      units_per_pack:          1,
      units_per_pack_label:    null,
      unit:                    'FL',
      properties:              {
        volume_ml:   null,
        alcohol_pct: d?.abv ?? null,
        wp_id:       w.id,
        article_url: w.link ?? `${ORIGIN}/sortiment/${w.slug}/`,
        source_api:  'wp-json/wp/v2/oa_wine',
      },
    }
    const { error } = await db.from('supplier_articles').upsert(row, { onConflict: 'supplier_fortnox_number,article_number' })
    if (error) { console.error(`  upsert (${w.slug}): ${error.message}`); fail++; continue }
    ok++
  }
  process.stdout.write(`  upserted ${ok}/${listing.length} (images cached: ${withImage})\r`)
}
process.stdout.write('\n')
console.log(`ok=${ok}  fail=${fail}  images_cached=${withImage}  total=${listing.length}`)
if (!APPLY) console.log('(DRY — re-run with --apply to write)')
