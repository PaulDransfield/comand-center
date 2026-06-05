// scripts/diag/scrape-spendrups.mjs
//
// Scrape Spendrups Bryggeri's wholesale catalogue (1,356 items as of
// 2026-06-05) and upsert into supplier_articles.
//
// Way simpler than the Martin Servera Playwright scrape — Spendrups
// exposes /api/products as a single JSON call with EVERY field we
// want (name, image, brand, country, ABV, volume, packaging,
// category, href). Only complication is the age-verification gate;
// one HTTP round-trip to bypass.
//
// Rows are keyed on (supplier_fortnox_number='SPENDRUPS', article_number).
// We use a sentinel string instead of a real Fortnox number because
// the customer's Spendrups fnx_number varies per business — auto-link
// step downstream (M128) writes the article reference onto the
// products row, then the thumbnail lookup falls back to the sentinel
// when the regular (customer_fnx, article) join misses.
//
// Usage:
//   node scripts/diag/scrape-spendrups.mjs --test                 # 10 items, dry
//   node scripts/diag/scrape-spendrups.mjs --test --apply         # 10 items, writes
//   node scripts/diag/scrape-spendrups.mjs --apply                # full catalogue, writes
//   node scripts/diag/scrape-spendrups.mjs --apply --no-images    # skip image caching

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

const SENTINEL_FNX = 'SPENDRUPS'   // sentinel; not a real Fortnox number
const BUCKET       = 'supplier-article-images'
const ORIGIN       = 'https://www.spendrups.se'

// ── AVP bypass ────────────────────────────────────────────────────────
// Spendrups' age gate is a CSRF-protected form. Fetch the gate page to
// pull the __RequestVerificationToken (and grab the session cookie),
// POST back with age=25, and we're through. The age-confirmed cookie
// the server sets persists for the rest of the run.
async function bypassAvp() {
  const cookies = new Map()
  function setCookie(setHdr) {
    if (!setHdr) return
    for (const c of [].concat(setHdr)) {
      const m = c.match(/^([^=]+)=([^;]+)/)
      if (m) cookies.set(m[1].trim(), m[2].trim())
    }
  }
  function cookieHeader() {
    return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  const AVP_URL = `${ORIGIN}/avp/?returnUrl=%2fhitta-dryck%2f`

  // 1. GET the AVP page → cookie + token
  const r1 = await fetch(AVP_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'manual' })
  setCookie(r1.headers.getSetCookie?.() ?? r1.headers.get('set-cookie'))
  const html = await r1.text()
  const m = html.match(/__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/)
  if (!m) throw new Error('AVP token not found in form HTML')
  const token = m[1]

  // 2. POST age + token (URL-encoded)
  const body = new URLSearchParams({ __RequestVerificationToken: token, age: '25' }).toString()
  const r2 = await fetch(AVP_URL, {
    method: 'POST',
    headers: {
      'User-Agent':   'Mozilla/5.0',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie':       cookieHeader(),
      'Referer':      AVP_URL,
    },
    body,
    redirect: 'manual',
  })
  setCookie(r2.headers.getSetCookie?.() ?? r2.headers.get('set-cookie'))
  if (r2.status >= 400) throw new Error(`AVP POST failed: ${r2.status}`)
  return cookieHeader()
}

// ── Fetch catalogue ───────────────────────────────────────────────────
async function fetchCatalogue(cookie) {
  const r = await fetch(`${ORIGIN}/api/products?grid=small&sortfield=name`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookie, 'Accept': 'application/json' },
  })
  if (!r.ok) throw new Error(`/api/products HTTP ${r.status}`)
  const j = await r.json()
  if (!Array.isArray(j.items)) throw new Error('unexpected /api/products shape')
  return j.items
}

// ── Image cache ───────────────────────────────────────────────────────
// Mirrors scrape-martinservera.mjs::cacheImage but the image URL is a
// relative path under /ConvertedImages/ — we join with ORIGIN.
async function cacheImage(relPath, article) {
  if (!relPath) return null
  const url = relPath.startsWith('http') ? relPath : `${ORIGIN}${relPath}`
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    const ext = (relPath.match(/\.(png|jpe?g|webp|gif)/i)?.[1] ?? 'png').toLowerCase()
    const objectPath = `spendrups/${article}.${ext}`
    const { error } = await db.storage.from(BUCKET).upload(objectPath, buf, {
      contentType: r.headers.get('content-type') ?? `image/${ext}`,
      upsert: true,
    })
    if (error) { console.error(`  image upload (${article}): ${error.message}`); return null }
    return objectPath
  } catch (e) {
    console.error(`  image fetch (${article}): ${e?.message ?? e}`)
    return null
  }
}

// ── Spec normalisation ────────────────────────────────────────────────
// Spendrups volume is "0,75" (litres) → convert to ml. Alcohol is "14,50" → %.
function parseVolMl(v) {
  if (v == null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null
}
function parseAbv(v) {
  if (v == null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

// ── Main ──────────────────────────────────────────────────────────────
console.log(`Spendrups scrape  apply=${APPLY}  test=${TEST}  images=${!NO_IMAGES}`)
const cookie = await bypassAvp()
console.log('AVP bypassed.')
const items = await fetchCatalogue(cookie)
console.log(`Catalogue: ${items.length} items`)
const targets = TEST ? items.slice(0, 10) : items

let ok = 0, fail = 0, withImage = 0
for (let i = 0; i < targets.length; i++) {
  const it = targets[i]
  const article = String(it.article ?? '').trim()
  if (!article) { fail++; continue }
  const volMl = parseVolMl(it.volume)
  const abv   = parseAbv(it.alcohol)
  if ((i + 1) % 50 === 0 || TEST) {
    process.stdout.write(`[${i + 1}/${targets.length}] ${article}  ${(it.name ?? '').slice(0, 50)}  vol=${volMl}ml abv=${abv}%\n`)
  }
  if (!APPLY) { ok++; continue }
  let cachedPath = null
  if (!NO_IMAGES && it.image) {
    cachedPath = await cacheImage(it.image, article)
    if (cachedPath) withImage++
  }
  const row = {
    supplier_fortnox_number: SENTINEL_FNX,
    article_number:          article,
    source:                  'spendrups_scrape',
    fetched_at:              new Date().toISOString(),
    fetch_status:            'ok',
    official_name:           String(it.name ?? '').trim() || null,
    description:             null,
    category_path:           String(it.category ?? '').trim() || null,
    image_url:               it.image ? `${ORIGIN}${it.image}` : null,
    image_cached_path:       cachedPath,
    image_cached_at:         cachedPath ? new Date().toISOString() : null,
    brand:                   String(it.brand ?? '').trim() || null,
    country_origin:          String(it.country ?? '').trim() || null,
    net_weight_g:            null,
    units_per_pack:          1,
    units_per_pack_label:    String(it.packaging ?? '').trim() || null,
    unit:                    'FL',         // most are bottles/cans, refine later
    properties:              {
      volume_ml:   volMl,
      alcohol_pct: abv,
      category:    it.category,
      article_url: it.href ? `${ORIGIN}${it.href}` : null,
      source_api:  '/api/products',
    },
  }
  const { error } = await db.from('supplier_articles').upsert(row, { onConflict: 'supplier_fortnox_number,article_number' })
  if (error) { console.error(`  upsert (${article}): ${error.message}`); fail++; continue }
  ok++
}
console.log(`\nok=${ok}  fail=${fail}  images_cached=${withImage}  total=${targets.length}`)
if (!APPLY) console.log('(DRY — re-run with --apply to write)')
