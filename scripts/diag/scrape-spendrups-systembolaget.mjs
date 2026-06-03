// Scrape Systembolaget for Spendrups SKUs.
//
// Strategy:
//   1. For each Spendrups invoice line's (article_number, raw_description),
//      derive a clean search query from the description.
//   2. Render Systembolaget search via Playwright. Capture the
//      productsearch API JSON response — already-authenticated (the
//      page injects the Ocp-Apim key in its frontend).
//   3. Filter response.products to those where supplierName matches
//      Spendrups. From the filtered set, pick the highest Jaccard
//      match against the invoice description.
//   4. Download image from product-cdn.systembolaget.se, cache to
//      Supabase Storage at `<supplier_fortnox_number>/<article>.png`.
//   5. Write a supplier_articles row for EACH of the two Spendrups
//      supplier_fortnox_number variants in our lines ("7953185" and
//      "Spendrups" — both occur in supplier_invoice_lines).
//
// Flags:
//   --test       process first 5 articles
//   --apply      write supplier_articles rows + upload images
//   --article N  scrape just one article
//   --all        full run (default behaviour when no flag)

import fs from 'node:fs'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const TEST       = process.argv.includes('--test')
const APPLY      = process.argv.includes('--apply')
const SAMPLE     = (process.argv.find(a => a.startsWith('--sample=')) ?? '').split('=')[1]
const articleArg = (process.argv.find(a => a.startsWith('--article=')) ?? '').split('=')[1]
const BUCKET     = 'supplier-article-images'
const SPENDRUPS_FORTNOX_KEYS = ['7953185', 'Spendrups']

// Spendrups appears in supplierName under various forms — accept all
const SPENDRUPS_NAMES = [
  'spendrups bryggeri ab',
  'spendrups',
]
function isSpendrups(s) {
  const n = (s ?? '').toLowerCase().trim()
  return SPENDRUPS_NAMES.some(x => n.includes(x))
}

function jaccard(a, b) {
  const A = new Set(String(a).toLowerCase().replace(/[^\wåäöÅÄÖ]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 1))
  const B = new Set(String(b).toLowerCase().replace(/[^\wåäöÅÄÖ]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 1))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0; for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

// Derive a clean search query from invoice description.
// The descriptions have shapes like:
//   "Castello di Neive Langhe Riesling DOC 12,0% 75cl engångsglas"
//   "MENABREA ARTE IN BOTT 5,2 33EG"      (older, abbreviated)
// Systembolaget search treats every token as AND, so over-specific queries
// return 0 results. Strategy: aggressively strip noise + cap to 3 tokens.
function cleanTokens(desc) {
  let s = String(desc ?? '').trim()
  s = s.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
  s = s.replace(/\b\d+(?:[.,]\d+)?\s*%/gi, ' ')
  s = s.replace(/\b\d+(?:[.,]\d+)?\s*(?:cl|ml|l|eg|kg|g)\b/gi, ' ')
  s = s.replace(/\b(FAT|BOX|BURK|BTL|BOTT|BIB|VDI|VdI|alkoholfri|alkfri|engångsglas|engångsgl|returglas|styck|tomemb|nyckelhål|ekologisk|organic)\b/gi, ' ')
  const STOPS = new Set(['di','la','le','il','de','del','della','el','en','och','i','på','pa','-','&','/'])
  return s.split(/\s+/).filter(t => t.length > 1 && !STOPS.has(t.toLowerCase()))
}
function searchQueriesFromDescription(desc) {
  const tokens = cleanTokens(desc)
  if (tokens.length === 0) return []
  // Try most specific first, then progressively relax
  const queries = []
  if (tokens.length >= 3) queries.push(tokens.slice(0, 3).join(' '))
  if (tokens.length >= 2) queries.push(tokens.slice(0, 2).join(' '))
  if (tokens.length >= 1) queries.push(tokens[0])
  return [...new Set(queries)]
}

// Distinct Spendrups articles in our DB
console.log('Loading Spendrups articles from DB...')
const articleMap = new Map()
{
  let from = 0
  while (true) {
    const { data } = await db.from('supplier_invoice_lines')
      .select('supplier_fortnox_number, article_number, raw_description, invoice_date')
      .ilike('supplier_name_snapshot', '%spendrups%')
      .not('article_number','is',null)
      .order('invoice_date', { ascending: false })
      .range(from, from + 999)
    if (!data?.length) break
    for (const l of data) {
      const a = String(l.article_number ?? '').trim()
      if (a.length !== 7 || !/^\d+$/.test(a)) continue
      if (!articleMap.has(a)) articleMap.set(a, l.raw_description)
    }
    if (data.length < 1000) break
    from += 1000
  }
}
const articles = articleArg
  ? [articleArg]
  : SAMPLE
    ? [...articleMap.keys()].slice(0, parseInt(SAMPLE, 10))
    : TEST
      ? [...articleMap.keys()].slice(0, 5)
      : [...articleMap.keys()]
console.log(`Candidates: ${articles.length}`)

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
  viewport: { width: 1280, height: 800 },
})
const page = await ctx.newPage()

// Capture productsearch API responses (any URL shape containing the path)
const apiHits = []
const allJsonUrls = []
page.on('response', async resp => {
  const u = resp.url()
  try {
    const ct = resp.headers()['content-type'] ?? ''
    if (!ct.includes('json')) return
    allJsonUrls.push(u)
    const body = await resp.json().catch(() => null)
    if (body?.products && Array.isArray(body.products)) apiHits.push({ url: u, body })
  } catch {}
})

// One-time age-gate dismissal — context persists cookies across navigations
// so subsequent goto() shouldn't see the gate again. We call once before the
// loop and rely on cookie persistence.
async function dismissGates(p) {
  for (const sel of ['button:has-text("Jag är 20")', 'button:has-text("Ja, jag är")', '[data-test="age-gate-confirm"]']) {
    try { const btn = await p.waitForSelector(sel, { timeout: 2000 }); if (btn) { await btn.click(); break } } catch {}
  }
  for (const sel of ['button:has-text("Acceptera")', 'button:has-text("Tillåt")']) {
    try { const btn = await p.waitForSelector(sel, { timeout: 2000 }); if (btn) { await btn.click(); break } } catch {}
  }
}

// Warm-up: navigate once + dismiss gates so the context has the age cookie
console.log('Warming up (dismissing age gate)…')
await page.goto('https://www.systembolaget.se/sortiment/?q=test', { waitUntil: 'domcontentloaded', timeout: 30000 })
await dismissGates(page)
await page.waitForTimeout(4000)
apiHits.length = 0

async function downloadAndUpload(productImageBaseUrl, fortnoxKey, articleNumber) {
  if (!productImageBaseUrl) return null
  const resp = await fetch(productImageBaseUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!resp.ok) return null
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length < 1000) return null
  const ext = productImageBaseUrl.endsWith('.webp') ? 'webp' : 'png'
  const contentType = ext === 'webp' ? 'image/webp' : 'image/png'
  const objectPath = `${fortnoxKey}/${articleNumber}.${ext}`
  if (APPLY) {
    const { error } = await db.storage.from(BUCKET).upload(objectPath, buf, { contentType, upsert: true })
    if (error) { console.error(`  storage upload failed: ${error.message}`); return null }
  }
  return objectPath
}

let matched = 0, skipped = 0, errored = 0
const results = []

for (let i = 0; i < articles.length; i++) {
  const article = articles[i]
  const desc = articleMap.get(article) ?? ''
  const queries = searchQueriesFromDescription(desc)
  process.stdout.write(`[${i+1}/${articles.length}] ${article}  "${(queries[0] ?? '').slice(0,40)}"  `)

  try {
    // Try progressively-relaxed queries; stop on first non-empty result set
    let lastHit = null
    let allProducts = []
    let usedQuery = ''
    for (const q of queries) {
      apiHits.length = 0
      allJsonUrls.length = 0
      const url = `https://www.systembolaget.se/sortiment/?q=${encodeURIComponent(q)}`
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await dismissGates(page)
      for (let t = 0; t < 20 && apiHits.length === 0; t++) await page.waitForTimeout(500)
      if (apiHits.length === 0) continue
      const h = apiHits[apiHits.length - 1]
      const prods = h.body?.products ?? []
      if (prods.length > 0) { lastHit = h; allProducts = prods; usedQuery = q; break }
    }
    if (!lastHit) { console.log('… 0 results for any query'); skipped++; continue }

    // Rank ALL products by Jaccard against original description.
    // Confidence comes from the description match, not the importer field —
    // Systembolaget's supplierName is the IMPORTER (e.g. Diageo for Baileys),
    // not always the Swedish distributor (Spendrups) that invoices Vero.
    const ranked = allProducts
      .map(p => ({ p, sim: jaccard(desc, `${p.productNameBold ?? ''} ${p.productNameThin ?? ''}`),
                   isSpendrups: isSpendrups(p.supplierName) }))
      .sort((a, b) => b.sim - a.sim)
    const best = ranked[0]
    // Threshold: 0.5 for non-Spendrups (strict), 0.3 for Spendrups (extra confidence anchor)
    const threshold = best.isSpendrups ? 0.3 : 0.5
    if (best.sim < threshold) {
      console.log(`… top sim ${best.sim.toFixed(2)} below threshold ${threshold} (${best.p.supplierName ?? '?'})`)
      skipped++; continue
    }
    const hit = lastHit

    // Image URL: extract from the rendered DOM by matching the productNumber in
    // its <a href="/produkt/.../baileys-8305402/"> wrapper. Systembolaget's API
    // doesn't expose images for new products, but the page renders them via
    // an internal image-id distinct from productNumber.
    const pn = String(best.p.productNumber ?? '')
    let imageUrl = null
    if (pn) {
      imageUrl = await page.evaluate((targetPn) => {
        const anchor = document.querySelector(`a[href*="-${targetPn}/"]`)
        if (!anchor) return null
        const img = anchor.querySelector('img')
        if (!img) return null
        const src = img.src || img.getAttribute('data-src') || ''
        // src is like "https://www.systembolaget.se/_next/image/?url=https%3A%2F%2Fproduct-cdn...100.webp&w=2000&q=75"
        // Decode the url param and bump to _400.webp
        const m = src.match(/[?&]url=([^&]+)/)
        if (!m) return src
        const real = decodeURIComponent(m[1])
        if (!real.includes('product-cdn.systembolaget.se')) return null
        // Upgrade size suffix
        return real.replace(/_100\.webp$/, '_400.webp').replace(/_200\.webp$/, '_400.webp')
      }, pn)
    }

    // Sanity: try fetching the image to confirm it exists
    let cachedPath = null
    if (imageUrl) {
      cachedPath = await downloadAndUpload(imageUrl, '7953185', article)
    }

    const officialName = [best.p.productNameBold, best.p.productNameThin].filter(Boolean).join(' ').trim()
    // Volume label: "70 cl" / "33 cl" — Systembolaget exposes this as volume (ml)
    const volumeMl = Number(best.p.volume) > 0 ? Math.round(Number(best.p.volume)) : null
    const volumeLabel = volumeMl ? `${(volumeMl / 10).toFixed(0)} cl/flaska` : null
    const row = {
      source:              'systembolaget_scrape',
      article_number:      article,
      official_name:       officialName,
      brand:               best.p.producerName ?? best.p.productNameBold ?? null,
      unit:                'FL',                          // bottle — matches Spendrups invoice unit convention
      net_weight_g:        null,
      units_per_pack:      1,                              // single bottle
      units_per_pack_label: volumeLabel,
      country_origin:      best.p.country ?? null,
      gtin:                null,
      image_cached_path:   cachedPath,
      fetch_status:        cachedPath ? 'ok' : 'no_image',
      fetched_at:          new Date().toISOString(),
    }

    if (APPLY) {
      // Write for BOTH supplier_fortnox_number variants
      for (const sk of SPENDRUPS_FORTNOX_KEYS) {
        const { error } = await db.from('supplier_articles').upsert(
          { supplier_fortnox_number: sk, ...row },
          { onConflict: 'supplier_fortnox_number,article_number' }
        )
        if (error) { console.log(`  upsert ${sk}: ${error.message}`); errored++; break }
      }
    }
    console.log(`OK sim=${best.sim.toFixed(2)}  "${officialName.slice(0,40)}"`)
    matched++
    results.push({ article, name: officialName, sim: best.sim })
  } catch (e) {
    console.log(`… error ${e.message.slice(0, 80)}`)
    errored++
  }

  // Rate-limit politely
  await page.waitForTimeout(500)
}

await browser.close()

console.log(`\nSummary:`)
console.log(`  Matched: ${matched}`)
console.log(`  Skipped: ${skipped}`)
console.log(`  Errored: ${errored}`)
console.log(`  Total:   ${articles.length}`)
