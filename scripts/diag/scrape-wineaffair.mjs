// scripts/diag/scrape-wineaffair.mjs
//
// Scrape Wine Affair Scandinavia's catalogue via their admin-ajax.php
// `wa_products_fetch` endpoint and upsert into supplier_articles with
// sentinel supplier_fortnox_number='WINEAFFAIR'.
//
// 690 wines as of 2026-06-05. The /sortiment/ page surfaces a security
// nonce via wa_products_vars; we scrape it once, then POST in pages
// of 12 wines each (~0.7s/page → ~40s total).
//
// Each card carries: name, category, image_url, post_id (unique key),
// Systembolaget article number, restaurant price ("ex. moms"), bottle
// size in ml. Producer is often empty on the listing — Wine Affair
// has per-producer pages but we don't traverse them for this scrape.
//
// "Article number" is the WordPress post ID (e.g. '15544'). Stable
// across reorderings + name changes.

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

const SENTINEL_FNX = 'WINEAFFAIR'
const BUCKET       = 'supplier-article-images'
const ORIGIN       = 'https://wineaffair.se'

// 1. Get nonce + module config from /sortiment/ page
async function bootstrap() {
  const r = await fetch(`${ORIGIN}/sortiment/`, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  const html = await r.text()
  const nonce = html.match(/wa_products_vars\s*=\s*\{[^}]*"security":"([^"]+)"/)?.[1]
  const cfgMatch = html.match(/wa_product_lists\['list_1'\]\s*=\s*(\{[^}]+\})/)
  if (!nonce || !cfgMatch) throw new Error('Could not extract nonce + module config from /sortiment/ page')
  return { nonce, module: JSON.parse(cfgMatch[1].replace(/\\/g, '\\\\')) }
}

// 2. Fetch one page of 12 wines
async function fetchPage({ nonce, module }, page) {
  const params = new URLSearchParams()
  params.set('action', 'wa_products_fetch')
  params.set('security', nonce)
  params.set('page', String(page))
  for (const [k, v] of Object.entries(module)) {
    if (Array.isArray(v)) {
      for (const item of v) params.append(`module[${k}][]`, String(item))
    } else {
      params.set(`module[${k}]`, String(v))
    }
  }
  const r = await fetch(`${ORIGIN}/wp-admin/admin-ajax.php`, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })
  if (!r.ok) throw new Error(`page ${page} HTTP ${r.status}`)
  return await r.json()
}

// 3. Parse card HTML → product objects
function parseCards(html) {
  const cards = []
  // Split on opening tag, drop first chunk (it's whatever comes before first card).
  const chunks = html.split(/<div class="wa-product-item /).slice(1)
  for (const chunk of chunks) {
    const segment = `<div class="wa-product-item ${chunk}`
    const postIdMatch = segment.match(/post-(\d+)/)
    if (!postIdMatch) continue
    const postId = postIdMatch[1]
    const url    = segment.match(/class="wa-product-overlay-link" href="([^"]+)"/)?.[1] ?? null
    const image  = segment.match(/class="wa-product-image"[\s\S]*?<img[^>]*src="([^"]+)"/)?.[1] ?? null
    const name   = segment.match(/class="wa-product-name"[^>]*>([^<]+)/)?.[1]?.trim() ?? null
    const cat    = segment.match(/class="wa-product-category"[^>]*>([^<]+)/)?.[1]?.trim() ?? null
    const producer = segment.match(/class="wa-product-producer"[^>]*>([^<]+)/)?.[1]?.trim() ?? null
    const sysNr  = segment.match(/class="wa-product-number">[^<]*nr\s*(\d+)/)?.[1] ?? null
    const size   = segment.match(/class="wa-product-size"[^>]*>([^<]+)/)?.[1]?.trim() ?? null
    const priceR = segment.match(/class="wa-product-price restaurant[^"]*"[^>]*>([^<]+)/)?.[1]?.trim() ?? null
    const priceF = segment.match(/class="wa-product-price federal[^"]*"[^>]*>([^<]+)/)?.[1]?.trim() ?? null

    let volMl = null
    if (size) {
      const m = size.match(/(\d+(?:[.,]\d+)?)\s*(ml|cl|l)\b/i)
      if (m) {
        const n = Number(m[1].replace(',', '.'))
        volMl = m[2].toLowerCase() === 'ml' ? Math.round(n)
              : m[2].toLowerCase() === 'cl' ? Math.round(n * 10)
              : Math.round(n * 1000)
      }
    }
    cards.push({ postId, url, image, name, cat, producer, sysNr, size, priceR, priceF, volMl })
  }
  return cards
}

async function cacheImage(url, postId) {
  if (!url) return null
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    const ext = (url.match(/\.(png|jpe?g|webp|gif)/i)?.[1] ?? 'jpg').toLowerCase().replace('jpeg', 'jpg')
    const objectPath = `wineaffair/${postId}.${ext}`
    const { error } = await db.storage.from(BUCKET).upload(objectPath, buf, {
      contentType: r.headers.get('content-type') ?? `image/${ext}`,
      upsert: true,
    })
    if (error) { console.error(`  image upload (${postId}): ${error.message}`); return null }
    return objectPath
  } catch { return null }
}

// ── Main ──────────────────────────────────────────────────────────────
console.log(`Wine Affair scrape  apply=${APPLY}  images=${!NO_IMAGES}`)
const boot = await bootstrap()
console.log(`Nonce: ${boot.nonce}  module.posts_per_page=${boot.module.posts_per_page}`)

const allCards = []
let page = 1, totalFound = 0
while (true) {
  let res
  try { res = await fetchPage(boot, page) } catch (e) { console.error(`page ${page}:`, e?.message); break }
  if (page === 1) totalFound = res.found_posts ?? 0
  const cards = parseCards(res.html ?? '')
  for (const c of cards) allCards.push(c)
  process.stdout.write(`  page ${page}: +${cards.length} cards (cumulative ${allCards.length}/${totalFound})\n`)
  if (cards.length === 0) break
  if (allCards.length >= totalFound && totalFound > 0) break
  page++
}
console.log(`Total cards scraped: ${allCards.length}`)

let ok = 0, fail = 0, withImage = 0
for (let i = 0; i < allCards.length; i++) {
  const c = allCards[i]
  if (!c.postId) { fail++; continue }
  if (!APPLY) { ok++; continue }
  let cachedPath = null
  if (!NO_IMAGES && c.image) {
    cachedPath = await cacheImage(c.image, c.postId)
    if (cachedPath) withImage++
  }
  const priceMatch = c.priceR ? (c.priceR.match(/(\d+(?:[.,]\d+)?)/)?.[1] ?? null) : null
  const row = {
    supplier_fortnox_number: SENTINEL_FNX,
    article_number:          c.postId,
    source:                  'wineaffair_scrape',
    fetched_at:              new Date().toISOString(),
    fetch_status:            'ok',
    official_name:           c.name,
    description:             null,
    category_path:           c.cat,
    image_url:               c.image,
    image_cached_path:       cachedPath,
    image_cached_at:         cachedPath ? new Date().toISOString() : null,
    brand:                   c.producer,
    country_origin:          null,
    net_weight_g:            null,
    units_per_pack:          1,
    units_per_pack_label:    c.size,
    unit:                    'FL',
    properties:              {
      volume_ml:                  c.volMl,
      alcohol_pct:                null,
      systembolaget_article_number: c.sysNr,
      price_sek_ex_vat:           priceMatch ? Number(priceMatch.replace(',', '.')) : null,
      article_url:                c.url,
      source_api:                 'admin-ajax/wa_products_fetch',
    },
  }
  const { error } = await db.from('supplier_articles').upsert(row, { onConflict: 'supplier_fortnox_number,article_number' })
  if (error) { console.error(`  upsert (${c.postId}): ${error.message}`); fail++; continue }
  ok++
  if ((ok + fail) % 50 === 0) process.stdout.write(`  upserted ${ok}/${allCards.length} (images cached: ${withImage})\n`)
}
console.log(`ok=${ok}  fail=${fail}  images_cached=${withImage}  total=${allCards.length}`)
if (!APPLY) console.log('(DRY — re-run with --apply to write)')
