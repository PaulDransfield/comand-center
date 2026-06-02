// scripts/diag/scrape-martinservera.mjs
//
// Scrape Martin Servera product pages and upsert into supplier_articles.
// Cross-customer: the rows are keyed on (supplier_fortnox_number,
// article_number) — every customer with an alias pointing at the same
// MS article gets the row.
//
// Usage:
//   node scripts/diag/scrape-martinservera.mjs --test            # 5 article test (no writes by default)
//   node scripts/diag/scrape-martinservera.mjs --test --apply    # 5 article test, writes
//   node scripts/diag/scrape-martinservera.mjs --all             # every MS article across all customers
//   node scripts/diag/scrape-martinservera.mjs --refresh-stale   # re-scrape rows older than 90 days
//   node scripts/diag/scrape-martinservera.mjs --article 262899  # one specific article
//
// Requirements:
//   - npx playwright install chromium  (one-time, ~200MB)
//   - sql/M121-SUPPLIER-ARTICLES.sql applied
//   - Supabase Storage bucket 'supplier-article-images' created (see M121 footer)

import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

// ── Env ───────────────────────────────────────────────────────────────
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// ── CLI ───────────────────────────────────────────────────────────────
const args   = process.argv.slice(2)
const APPLY  = args.includes('--apply')
const TEST   = args.includes('--test')
const ALL    = args.includes('--all')
const STALE  = args.includes('--refresh-stale')
const ONE    = (() => {
  const i = args.indexOf('--article')
  return i >= 0 ? args[i + 1] : null
})()

// Martin Servera supplier_fortnox_number — comes from Fortnox. Owner
// businesses tend to share the same supplier number for MS because
// it's a single registered company. We discover it from the data.
const MS_NAME_PATTERN = '%martin servera%'

// ── Browser ───────────────────────────────────────────────────────────
let browser
async function getBrowser() {
  if (browser) return browser
  browser = await chromium.launch({ headless: true })
  return browser
}

// ── Scrape one page ──────────────────────────────────────────────────
// MS shows an age gate ('Är du över 20 år?') before every product page
// because some are alcoholic; the entire page is gated. Set the cookie
// directly so we skip the modal — saves a click per page and ensures
// the spec data renders on first paint.
const AGE_GATE_COOKIE = {
  name:    'ms-age-verified',   // best-guess; falls back to clicking the modal
  value:   'true',
  domain:  '.martinservera.se',
  path:    '/',
  expires: Math.floor(Date.now() / 1000) + 86400 * 365,
}

async function scrapeArticle(articleNumber) {
  const b = await getBrowser()
  const ctx = await b.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    locale: 'sv-SE',
    viewport: { width: 1280, height: 900 },
  })
  // Pre-set the age gate cookie (best-effort; if name is different we
  // fall back to clicking the gate after page load).
  try { await ctx.addCookies([AGE_GATE_COOKIE]) } catch (_) {}
  const page = await ctx.newPage()
  const url  = `https://www.martinservera.se/produkter/${articleNumber}/`
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 })
    if (!resp || resp.status() >= 400) {
      return { ok: false, status: resp?.status() ?? 0, reason: 'http-error' }
    }
    // Click through the age gate if the cookie didn't dismiss it.
    try {
      const btn = page.getByRole('button', { name: /20 år eller äldre/i }).first()
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click()
        await page.waitForTimeout(800)
      }
    } catch (_) {}
    // Click the "Detaljer" and "Specifikation" expand sections — they're
    // collapsed by default; spec data only renders into the DOM after click.
    for (const label of ['Detaljer', 'Specifikation']) {
      try {
        const t = page.locator(`text="${label}"`).first()
        if (await t.isVisible({ timeout: 1500 })) {
          await t.click({ timeout: 2000 })
          await page.waitForTimeout(400)
        }
      } catch (_) {}
    }
    // Wait for any spec field to materialise.
    try {
      await page.waitForFunction(
        () => /Varumärke|Bruttovikt|Nettovikt|GTIN|Artikelnummer/.test(document.body.innerText),
        { timeout: 8000 },
      )
    } catch (_) {}
    await page.waitForTimeout(500)

    // ── Extract ────────────────────────────────────────────────────
    const data = await page.evaluate((artNum) => {
      const out = {}
      out.title = document.title.split('|')[0].split(' - ')[0].trim()

      // PRODUCT IMAGE — MS uses srcset variants like:
      //   media.martinservera.se/w_<W>,q_auto,f_auto/prod/martinservera/produkt/3/050/704/DV02_<artNum>_01.png
      // We grab the widest variant. Filter to images that contain the
      // article number in the filename — that's the surest match.
      const allImgs = new Set()
      for (const i of document.querySelectorAll('img')) {
        const src = i.currentSrc || i.src || i.getAttribute('data-src')
        if (src) allImgs.add(src)
        const ss = i.getAttribute('srcset')
        if (ss) for (const part of ss.split(',')) {
          const url = part.trim().split(/\s+/)[0]
          if (url) allImgs.add(url)
        }
      }
      let bestImage = null, bestW = 0
      for (const url of allImgs) {
        if (!url.includes('media.martinservera.se')) continue
        if (!url.includes(`_${artNum}_`) && !url.includes(`/${artNum}_`) && !url.includes(`/${artNum}.`)) continue
        const wm = url.match(/\/w_(\d+),/)
        const w  = wm ? Number(wm[1]) : 0
        if (w > bestW) { bestW = w; bestImage = url }
      }
      // Fallback — first MS image with /produkt/ in the path.
      if (!bestImage) {
        for (const url of allImgs) {
          if (url.includes('media.martinservera.se') && url.includes('/produkt/') &&
              !/logo|favicon|emv|banner|toppbild|kategori|inspiration/i.test(url)) {
            bestImage = url; break
          }
        }
      }
      // MS serves the SAME image at any width via /w_<N>,q_auto,f_auto/.
      // Bump to w_1024 for crisp owner-facing display regardless of which
      // responsive variant the page picked.
      if (bestImage) bestImage = bestImage.replace(/\/w_\d+,/, '/w_1024,')
      out.image_url = bestImage

      // DESCRIPTION — first paragraph after the product title, skip nav/cookie text.
      const ogDesc = document.querySelector('meta[property="og:description"]')?.content
      out.description = ogDesc || null

      // SPEC PAIRS — MS renders each pair as a flex row with two children:
      //   <div class="flex justify-between"><span>Varumärke</span><a>Aviko</a></div>
      // Walk every element whose first child has class containing
      // 'justify-between' AND has exactly 2 element children where the
      // first is a label string.
      const specs = {}
      const KNOWN_LABELS = new Set([
        'Varumärke', 'Bruttovikt', 'Nettovikt', 'Enhet', 'Antal/enhet',
        'Antal per hel förpackning', 'Antal per förpackning',
        'Varutyp', 'Land', 'Ursprungsland', 'Tillverkningsland',
        'Artikelnummer', 'Art.nr leverantör', 'Leverantörens artikelnummer',
        'GTIN', 'EAN', 'Streckkod',
        'Bredd mm', 'Höjd mm', 'Djup mm', 'Vikt',
        'Hållbarhet', 'Förvaring', 'Allergener', 'Innehåll',
      ])
      // Walk all elements that look like spec rows.
      const rows = document.querySelectorAll('div.flex.justify-between, div[class*="justify-between"]')
      for (const r of rows) {
        const kids = Array.from(r.children).filter(n => n.nodeType === 1)
        if (kids.length < 2) continue
        const k = kids[0].textContent.trim()
        const v = kids.slice(1).map(n => n.textContent.trim()).join(' ').trim()
        if (!k || !v) continue
        if (k.length > 60 || v.length > 300) continue
        if (KNOWN_LABELS.has(k) || /[A-ZÅÄÖa-zåäö ]{3,30}/.test(k)) {
          if (!specs[k]) specs[k] = v
        }
      }
      out.specs = specs

      // CATEGORY BREADCRUMB
      const crumbEls = document.querySelectorAll('nav a, [class*="breadcrumb" i] a, [class*="brodsmul" i] a')
      const crumbs = Array.from(crumbEls)
        .map(a => a.textContent.trim())
        .filter(t => t && t.length > 1 && t.length < 50 && !/start|hem|home|tillbaka/i.test(t))
      out.category_path = crumbs.length >= 2 ? [...new Set(crumbs)].slice(0, 6).join(' > ') : null

      // BRAND from itemprop (rare) or specs
      const brandEl = document.querySelector('[itemprop="brand"]')
      out.brand = brandEl ? brandEl.textContent.trim() : (specs['Varumärke'] ?? null)

      return out
    }, articleNumber)

    return { ok: true, status: resp.status(), data }
  } catch (e) {
    return { ok: false, reason: String(e.message ?? e).slice(0, 200) }
  } finally {
    await ctx.close()
  }
}

// ── Map raw specs → typed columns ────────────────────────────────────
function parseSpecs(specs) {
  const out = {}
  const get = (...keys) => {
    for (const k of keys) {
      for (const sk of Object.keys(specs)) {
        if (sk.toLowerCase() === k.toLowerCase()) return specs[sk]
      }
    }
    return null
  }
  const num = s => {
    if (!s) return null
    const m = String(s).match(/-?\d+(?:[.,]\d+)?/)
    return m ? Number(m[0].replace(',', '.')) : null
  }
  const grams = s => {
    if (!s) return null
    const t = String(s).toLowerCase()
    const n = num(t)
    if (n == null) return null
    if (/\bkg\b/.test(t)) return n * 1000
    if (/\bhg\b/.test(t)) return n * 100
    return n
  }
  out.brand                 = get('Varumärke', 'Brand')
  out.gtin                  = get('GTIN', 'EAN', 'Streckkod')?.replace(/\s+/g, '') ?? null
  out.brutto_weight_g       = grams(get('Bruttovikt', 'Brutto vikt'))
  out.net_weight_g          = grams(get('Nettovikt', 'Netto vikt'))
  out.unit                  = get('Enhet')
  const upp                 = get('Antal/enhet', 'Antal per enhet')
  out.units_per_pack_label  = upp
  out.units_per_pack        = num(upp)
  out.packs_per_master      = num(get('Antal per hel förpackning', 'Antal/förpackning'))
  out.storage_type          = (get('Varutyp') ?? '').toLowerCase().includes('frys') ? 'fryst'
                            : (get('Varutyp') ?? '').toLowerCase().includes('kyl')  ? 'kyl'
                            : (get('Varutyp') ?? '').toLowerCase().includes('rum')  ? 'rum'
                            : (get('Varutyp') ?? null)
  out.country_origin        = get('Land', 'Ursprungsland', 'Tillverkningsland')
  out.supplier_internal_sku = get('Art.nr leverantör', 'Leverantörens artikelnummer')
  return out
}

// ── Image cache to Supabase Storage ──────────────────────────────────
const BUCKET = 'supplier-article-images'
async function cacheImage(imageUrl, supplierFortnoxNumber, articleNumber) {
  if (!imageUrl) return null
  try {
    const r = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    const ext = (imageUrl.match(/\.(jpg|jpeg|png|webp)/i)?.[1] ?? 'jpg').toLowerCase()
    const rel = `${supplierFortnoxNumber}/${articleNumber}.${ext}`
    const { error } = await db.storage.from(BUCKET).upload(rel, buf, {
      upsert:      true,
      contentType: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg',
    })
    if (error) {
      // Bucket might not exist yet — fall back to storing the upstream URL only.
      console.warn(`    image cache failed: ${error.message}`)
      return null
    }
    return rel
  } catch (e) {
    console.warn(`    image fetch failed: ${e.message}`)
    return null
  }
}

// ── Discover articles to scrape ──────────────────────────────────────
async function discoverArticles() {
  // Pull every supplier_invoice_line where supplier is MS and article_number
  // is numeric (5-7 digits, MS internal SKU). Dedupe by (supplier_fortnox_number, article_number).
  const articles = new Map()   // key = supplier|article → { supplier_fortnox_number, article_number, sample_desc, businesses: Set }
  let from = 0
  while (true) {
    const { data, error } = await db.from('supplier_invoice_lines')
      .select('supplier_fortnox_number, article_number, raw_description, business_id')
      .ilike('supplier_name_snapshot', MS_NAME_PATTERN)
      .not('article_number', 'is', null)
      .not('supplier_fortnox_number', 'is', null)
      .order('id').range(from, from + 999)
    if (error) { console.error(error.message); break }
    if (!data || data.length === 0) break
    for (const l of data) {
      if (!/^\d{4,8}$/.test(l.article_number)) continue
      const k = `${l.supplier_fortnox_number}|${l.article_number}`
      if (!articles.has(k)) articles.set(k, {
        supplier_fortnox_number: l.supplier_fortnox_number,
        article_number:          l.article_number,
        sample_desc:             l.raw_description,
        businesses:              new Set([l.business_id]),
      })
      else articles.get(k).businesses.add(l.business_id)
    }
    if (data.length < 1000) break
    from += 1000
  }
  return [...articles.values()]
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  let candidates
  if (ONE) {
    const all = await discoverArticles()
    candidates = all.filter(a => a.article_number === ONE)
    if (candidates.length === 0) {
      console.error(`Article ${ONE} not found in any supplier_invoice_line for Martin Servera.`)
      process.exit(1)
    }
  } else if (TEST) {
    const all = await discoverArticles()
    candidates = all.slice(0, 5)
  } else if (STALE) {
    // Re-scrape rows last fetched > 90 days ago.
    const { data } = await db.from('supplier_articles')
      .select('supplier_fortnox_number, article_number')
      .eq('source', 'martinservera_scrape')
      .lt('fetched_at', new Date(Date.now() - 90 * 86400_000).toISOString())
    candidates = (data ?? []).map(d => ({
      supplier_fortnox_number: d.supplier_fortnox_number,
      article_number:          d.article_number,
    }))
  } else if (ALL) {
    candidates = await discoverArticles()
    // Skip ones already scraped successfully (use --refresh-stale to update those).
    const { data: existing } = await db.from('supplier_articles')
      .select('supplier_fortnox_number, article_number')
      .eq('source', 'martinservera_scrape')
      .eq('fetch_status', 'ok')
    const have = new Set((existing ?? []).map(e => `${e.supplier_fortnox_number}|${e.article_number}`))
    candidates = candidates.filter(c => !have.has(`${c.supplier_fortnox_number}|${c.article_number}`))
  } else {
    console.error('Pick one: --test | --all | --refresh-stale | --article <N>')
    process.exit(1)
  }

  console.log(`Candidates: ${candidates.length}`)
  if (candidates.length === 0) { await browser?.close(); return }

  let ok = 0, errs = 0
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    process.stdout.write(`[${i + 1}/${candidates.length}] ${c.article_number}  "${c.sample_desc ?? ''}"  …`)
    const r = await scrapeArticle(c.article_number)
    if (!r.ok) {
      console.log(` FAIL (${r.reason ?? r.status})`)
      errs++
      if (APPLY || !TEST) {
        await db.from('supplier_articles').upsert({
          supplier_fortnox_number: c.supplier_fortnox_number,
          article_number:          c.article_number,
          source:                  'martinservera_scrape',
          fetched_at:              new Date().toISOString(),
          fetch_status:            r.status === 404 ? 'not_found' : 'error',
          fetch_error:             r.reason ?? `HTTP ${r.status}`,
        })
      }
      continue
    }
    const specs = parseSpecs(r.data.specs ?? {})
    let cachedPath = null
    if (r.data.image_url && (APPLY || !TEST)) {
      cachedPath = await cacheImage(r.data.image_url, c.supplier_fortnox_number, c.article_number)
    }
    if (TEST && !APPLY) {
      console.log(` OK`)
      console.log(`    name:      ${r.data.title ?? '∅'}`)
      console.log(`    image:     ${r.data.image_url ?? '∅'}`)
      console.log(`    brand:     ${specs.brand ?? '∅'}`)
      console.log(`    gtin:      ${specs.gtin ?? '∅'}`)
      console.log(`    weights:   brutto=${specs.brutto_weight_g ?? '∅'} g  netto=${specs.net_weight_g ?? '∅'} g`)
      console.log(`    unit:      ${specs.unit ?? '∅'}  upp=${specs.units_per_pack_label ?? '∅'}  packs=${specs.packs_per_master ?? '∅'}`)
      console.log(`    storage:   ${specs.storage_type ?? '∅'}  origin=${specs.country_origin ?? '∅'}`)
      console.log(`    supplier_sku: ${specs.supplier_internal_sku ?? '∅'}`)
      console.log(`    raw specs keys: ${Object.keys(r.data.specs ?? {}).slice(0, 12).join(', ')}`)
      ok++
      continue
    }
    const { error: upErr } = await db.from('supplier_articles').upsert({
      supplier_fortnox_number: c.supplier_fortnox_number,
      article_number:          c.article_number,
      source:                  'martinservera_scrape',
      fetched_at:              new Date().toISOString(),
      fetch_status:            'ok',
      official_name:           r.data.title,
      description:             r.data.description,
      category_path:           r.data.category_path,
      image_url:               r.data.image_url,
      image_cached_path:       cachedPath,
      image_cached_at:         cachedPath ? new Date().toISOString() : null,
      brand:                   r.data.brand ?? specs.brand,
      gtin:                    specs.gtin,
      brutto_weight_g:         specs.brutto_weight_g,
      net_weight_g:            specs.net_weight_g,
      unit:                    specs.unit,
      units_per_pack:          specs.units_per_pack,
      units_per_pack_label:    specs.units_per_pack_label,
      packs_per_master:        specs.packs_per_master,
      storage_type:            specs.storage_type,
      country_origin:          specs.country_origin,
      supplier_internal_sku:   specs.supplier_internal_sku,
      properties:              r.data.specs ?? null,
    })
    if (upErr) {
      console.log(` UPSERT FAIL: ${upErr.message}`)
      errs++
    } else {
      console.log(` OK`)
      ok++
    }
  }

  console.log(`\nResults: ${ok} ok / ${errs} errors`)
  await browser?.close()
}

await main()
