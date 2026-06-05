// scripts/diag/scrape-carlsberg.mjs
//
// Scrape Carlsberg Sverige's brand-tile catalogue across all 8 drink
// categories (öl, cider, blanddrycker, festis, funktionsdryck, läsk,
// vatten, alkoholfritt) and upsert into supplier_articles with
// sentinel supplier_fortnox_number='CARLSBERG'.
//
// Different shape from the Spendrups scrape: Carlsberg's public site
// is brand-marketing, not B2B. There's no /api/products JSON; tiles
// are server-rendered HTML. And each tile is BRAND-LEVEL, not SKU-
// level — "Carlsberg Lager" is one tile that covers 33cl can + 50cl
// bottle + 30L keg. We accept that as a coverage limitation:
// brand-level thumbnails are still better than nothing for the
// recipe rows.
//
// "Article number" is the URL slug (e.g. 'falcon-export',
// 'staropramen-premium') — Carlsberg's site doesn't expose a numeric
// SKU. The slug is stable enough to key the supplier_articles row.
//
// No age-verification bypass needed (unlike Spendrups). Cloudflare
// __cf_bm is enough — first GET sets it implicitly.
//
// Usage:
//   node scripts/diag/scrape-carlsberg.mjs --test                # 1 category, dry
//   node scripts/diag/scrape-carlsberg.mjs --test --apply        # 1 category, writes
//   node scripts/diag/scrape-carlsberg.mjs --apply               # all categories, writes
//   node scripts/diag/scrape-carlsberg.mjs --apply --no-images   # skip image caching

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
const TEST      = process.argv.includes('--test')
const NO_IMAGES = process.argv.includes('--no-images')

const SENTINEL_FNX = 'CARLSBERG'
const BUCKET       = 'supplier-article-images'
const ORIGIN       = 'https://www.carlsbergsverige.se'

const CATEGORIES = [
  { slug: 'oel',            label: 'Öl' },
  { slug: 'cider',          label: 'Cider' },
  { slug: 'blanddrycker',   label: 'Blanddrycker' },
  { slug: 'festis',         label: 'Festis' },
  { slug: 'funktionsdryck', label: 'Funktionsdryck' },
  { slug: 'laesk',          label: 'Läsk' },
  { slug: 'vatten',         label: 'Vatten' },
  { slug: 'alkoholfritt',   label: 'Alkoholfritt' },
]

// ── HTML tile parser ──────────────────────────────────────────────────
// Each tile carries:
//   - <a href="/produkter/<brand>/<sku>/?Ckey=..."> with the canonical product URL
//   - <img srcset="<rel-2x> 2x"> for the thumbnail (use 2x for quality)
//   - <h2><a>...</a></h2> for the product name
//   - <dl class="brands-list-meta"> with Typ av dryck / ABV / Producerat dt+dd pairs
function decodeEntities(s) {
  if (!s) return s
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
}

function parseTiles(html, categoryLabel) {
  // Split into tile blocks by the marker class
  const blocks = html.split('class="brands-list__result-tile">').slice(1)
  const tiles = []
  for (const block of blocks) {
    // Truncate at next tile or end of brands list section
    const segment = block.split(/<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/)[0]
    // URL — first /produkter/.../ ref
    const urlMatch = segment.match(/href="(\/produkter\/[^"?]+)/)
    if (!urlMatch) continue
    const href = urlMatch[1].replace(/\/$/, '')
    const parts = href.split('/').filter(Boolean)
    if (parts.length < 3) continue
    const brandSlug = parts[1]   // e.g. 'falcon'
    const skuSlug   = parts[2]   // e.g. 'falcon-export'
    // Image — prefer 2x from srcset
    const imgMatch = segment.match(/srcset="([^"]+)"/)
    let imageRel = null
    if (imgMatch) {
      const src = imgMatch[1]
      const m2x = src.match(/(\S+)\s+2x/)
      const m1x = src.match(/(\S+)\s+1x/)
      imageRel = (m2x?.[1] ?? m1x?.[1] ?? src.split(',')[0].trim().split(' ')[0]) || null
    }
    // Product name from h2 — strip trailing whitespace + the link wrapper
    const nameMatch = segment.match(/<h2 class="brands-list__result__heading"><a [^>]*>([^<]+)</)
    const officialName = decodeEntities((nameMatch?.[1] ?? '').trim()) || null
    // Meta dl — Typ av dryck / Volymprocent alkohol / Producerat
    const meta = {}
    const dlMatch = segment.match(/<dl class="brands-list-meta[^"]*">([\s\S]*?)<\/dl>/)
    if (dlMatch) {
      const items = [...dlMatch[1].matchAll(/<dt[^>]*>([^<]+)<\/dt>\s*<dd[^>]*>([^<]+)<\/dd>/g)]
      for (const [, k, v] of items) {
        const key = k.replace(/:\s*$/, '').trim().toLowerCase()
        const val = v.trim()
        const dval = decodeEntities(val)
        if (/typ/.test(key))         meta.typ      = dval
        else if (/alkohol/.test(key)) meta.abv      = dval
        else if (/produc/.test(key))  meta.producerat = dval
      }
    }
    // ABV — "5,2%" → 5.2
    let abv = null
    if (meta.abv) {
      const m = meta.abv.match(/(\d+(?:[.,]\d+)?)/)
      if (m) abv = Number(m[1].replace(',', '.'))
    }
    tiles.push({
      sku_slug:   skuSlug,
      brand_slug: brandSlug,
      href:       `${ORIGIN}${href}`,
      image_url:  imageRel ? (imageRel.startsWith('http') ? imageRel : `${ORIGIN}${imageRel}`) : null,
      image_rel:  imageRel,
      name:       officialName,
      typ:        meta.typ ?? null,
      abv,
      origin:     meta.producerat ?? null,
      category:   categoryLabel,
    })
  }
  return tiles
}

async function fetchCategory(slug) {
  const r = await fetch(`${ORIGIN}/vaara-drycker/${slug}/`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
  })
  if (!r.ok) throw new Error(`/${slug}/ HTTP ${r.status}`)
  return await r.text()
}

// ── Image cache (mirrors Spendrups + Martin Servera) ──────────────────
async function cacheImage(url, sku_slug) {
  if (!url) return null
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    const ext = (url.match(/\.(png|jpe?g|webp|gif)/i)?.[1] ?? 'png').toLowerCase().replace('jpeg', 'jpg')
    const objectPath = `carlsberg/${sku_slug}.${ext}`
    const { error } = await db.storage.from(BUCKET).upload(objectPath, buf, {
      contentType: r.headers.get('content-type') ?? `image/${ext}`,
      upsert: true,
    })
    if (error) { console.error(`  image upload (${sku_slug}): ${error.message}`); return null }
    return objectPath
  } catch (e) {
    console.error(`  image fetch (${sku_slug}): ${e?.message ?? e}`)
    return null
  }
}

// ── Main ──────────────────────────────────────────────────────────────
console.log(`Carlsberg scrape  apply=${APPLY}  test=${TEST}  images=${!NO_IMAGES}`)
const targets = TEST ? CATEGORIES.slice(0, 1) : CATEGORIES

const allTiles = []
const seen = new Set()  // dedupe by sku_slug (a brand could be in 2 categories)
for (const cat of targets) {
  process.stdout.write(`category=${cat.slug} fetching... `)
  const html = await fetchCategory(cat.slug)
  const tiles = parseTiles(html, cat.label)
  process.stdout.write(`${tiles.length} tiles\n`)
  for (const t of tiles) {
    if (seen.has(t.sku_slug)) continue
    seen.add(t.sku_slug)
    allTiles.push(t)
  }
}
console.log(`Total unique tiles: ${allTiles.length}`)

if (TEST) {
  for (const t of allTiles.slice(0, 10)) {
    console.log(`  ${t.sku_slug.padEnd(35)}  "${(t.name ?? '').slice(0, 30)}"  abv=${t.abv}%  typ="${(t.typ ?? '').slice(0, 30)}"`)
  }
}

if (!APPLY) {
  console.log('(DRY — re-run with --apply to write)')
  process.exit(0)
}

let ok = 0, fail = 0, withImage = 0
for (let i = 0; i < allTiles.length; i++) {
  const t = allTiles[i]
  if ((i + 1) % 25 === 0) process.stdout.write(`[${i + 1}/${allTiles.length}] ${t.sku_slug}\n`)
  let cachedPath = null
  if (!NO_IMAGES && t.image_url) {
    cachedPath = await cacheImage(t.image_url, t.sku_slug)
    if (cachedPath) withImage++
  }
  const row = {
    supplier_fortnox_number: SENTINEL_FNX,
    article_number:          t.sku_slug,
    source:                  'carlsberg_scrape',
    fetched_at:              new Date().toISOString(),
    fetch_status:            'ok',
    official_name:           t.name,
    description:             null,
    category_path:           t.category,
    image_url:               t.image_url,
    image_cached_path:       cachedPath,
    image_cached_at:         cachedPath ? new Date().toISOString() : null,
    brand:                   t.brand_slug,
    country_origin:          t.origin,
    net_weight_g:            null,
    units_per_pack:          1,
    units_per_pack_label:    null,
    unit:                    'FL',
    properties:              {
      volume_ml:   null,   // brand-level — not surfaced on the listing
      alcohol_pct: t.abv,
      typ:         t.typ,
      article_url: t.href,
      source_html: `/vaara-drycker/${t.category.toLowerCase()}/`,
    },
  }
  const { error } = await db.from('supplier_articles').upsert(row, { onConflict: 'supplier_fortnox_number,article_number' })
  if (error) { console.error(`  upsert (${t.sku_slug}): ${error.message}`); fail++; continue }
  ok++
}
console.log(`\nok=${ok}  fail=${fail}  images_cached=${withImage}  total=${allTiles.length}`)
