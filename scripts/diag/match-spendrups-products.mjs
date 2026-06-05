// scripts/diag/match-spendrups-products.mjs
//
// Walk every business's beverage/alcohol products + match against the
// scraped supplier_articles catalogues (Spendrups + Carlsberg) by
// NAME + VOLUME + ABV. When a confident single match is found, set
// products.external_catalogue_source + external_catalogue_article.
// Downstream the supplier-article batch endpoint reads these to surface
// the Spendrups thumbnail + spec data on recipe rows + EditItemModal.
//
// Match criteria (must all hold):
//   - Jaccard(name_tokens, name_tokens) >= 0.55
//   - Volume within ±5% (or both volumes unknown)
//   - ABV within ±0.5 absolute % (or both ABV unknown)
//   - EXACTLY one Spendrups candidate clears the bar
//
// Conservative on purpose: false-positive merge of "Riesling" to the
// wrong producer would attach the wrong thumbnail and pack data to a
// recipe ingredient. Owner is much better served by 60% coverage with
// 100% precision than 90% coverage with 5% noise.
//
// DRY by default. --apply writes products.external_catalogue_*.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const APPLY = process.argv.includes('--apply')

const JACCARD_FLOOR = 0.55
const VOL_TOL_PCT   = 0.05    // ±5% volume
const ABV_TOL_ABS   = 0.5     // ±0.5%

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

const STOPWORDS = new Set([
  'eko','ekologisk','krav','organic','nyckelhål','from','svensk','svenska','sverige','frankrike','italien','tysk','spanien','österrike',
  'cl','ml','l','liter','dl','kg','g','st','stk','styck','flaska','burk','can','bot','btl','eg','pet','glas','flask','dunk','hink',
  'docg','doc','igt','igp','aoc','aop','dop',
  'red','white','pink','rose','rosé','rosato','rouge','blanc','bianco','rosso',
  'and','och','med','utan','the','de','di','del','dell','la','le','les','el','en',
  'st','vintage','classico','superiore','riserva','reserve',
])

function tokens(s) {
  if (!s) return []
  let t = String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  t = t.replace(/\([^)]*\)/g, ' ')
  // Strip numbers + volume/ABV markers
  t = t.replace(/\b\d+(?:[.,]\d+)?\s*%?\b/g, ' ')
  t = t.replace(/[^\p{Letter}\s]/gu, ' ')
  return [...new Set(t.split(/\s+/).filter(w => w.length >= 3 && !STOPWORDS.has(w)))]
}
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b)
  if (A.size === 0 || B.size === 0) return 0
  const inter = [...A].filter(x => B.has(x)).length
  return inter / new Set([...A, ...B]).size
}

// Parse customer product volume from name + pack_size/base_unit.
function inferProductVolMl(name, packSize, baseUnit) {
  // Prefer pack_size when base_unit is ml/l
  if (packSize != null && baseUnit) {
    const ps = Number(packSize)
    const bu = String(baseUnit).toLowerCase()
    if (bu === 'ml' && Number.isFinite(ps)) return ps
    if (bu === 'l'  && Number.isFinite(ps)) return ps * 1000
    if (bu === 'cl' && Number.isFinite(ps)) return ps * 10
  }
  // Fall back to parsing name (e.g. "75cl", "750ml", "0,75l", "75 eg")
  if (name) {
    const n = String(name).toLowerCase()
    let m
    if ((m = n.match(/(\d+(?:[.,]\d+)?)\s*ml\b/))) return Math.round(Number(m[1].replace(',', '.')))
    if ((m = n.match(/(\d+(?:[.,]\d+)?)\s*cl\b/))) return Math.round(Number(m[1].replace(',', '.')) * 10)
    if ((m = n.match(/(\d+(?:[.,]\d+)?)\s*l\b/)))  return Math.round(Number(m[1].replace(',', '.')) * 1000)
    if ((m = n.match(/(\d+(?:[.,]\d+)?)\s*eg\b/))) return Math.round(Number(m[1].replace(',', '.')) * 10)
  }
  return null
}
function inferProductAbv(name) {
  if (!name) return null
  const m = String(name).match(/(\d+(?:[.,]\d+)?)\s*%/)
  return m ? Number(m[1].replace(',', '.')) : null
}

// 1. Load all external-catalogue articles (Spendrups + Carlsberg).
//    Carlsberg tiles are brand-level (no volume_ml) so the matcher
//    needs Jaccard + ABV alone for those — the volume gate already
//    skips when either side is null so the same engine handles both.
const SOURCES = [
  { sentinel: 'SPENDRUPS',  source: 'spendrups_scrape'  },
  { sentinel: 'CARLSBERG',  source: 'carlsberg_scrape'  },
  { sentinel: 'LIVELY',     source: 'lively_scrape'     },
  { sentinel: 'ENJOY',      source: 'enjoy_scrape'      },
  { sentinel: 'WINEAFFAIR', source: 'wineaffair_scrape' },
]
const catalogueIndex = []
for (const src of SOURCES) {
  const { data } = await db.from('supplier_articles')
    .select('article_number, official_name, properties, image_cached_path, brand, country_origin')
    .eq('supplier_fortnox_number', src.sentinel).eq('source', src.source).eq('fetch_status', 'ok')
  console.log(`${src.sentinel} articles loaded: ${data?.length ?? 0}`)
  for (const s of data ?? []) {
    catalogueIndex.push({
      ...s,
      sentinel: src.sentinel,
      tokens:  tokens(s.official_name),
      vol_ml:  s.properties?.volume_ml ?? null,
      abv:     s.properties?.alcohol_pct ?? null,
    })
  }
}
const spendrupsIndex = catalogueIndex   // legacy var name preserved

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)
  // 2. Customer products in beverage/alcohol categories
  let prods, err
  ;({ data: prods, error: err } = await db.from('products')
    .select('id, name, category, pack_size, base_unit, external_catalogue_source, external_catalogue_article')
    .eq('business_id', biz.id).is('archived_at', null)
    .in('category', ['beverage', 'alcohol']))
  if (err && /external_catalogue_/.test(err.message)) {
    console.log('  (M128 not applied — falling back to columns without external_catalogue_*)')
    ;({ data: prods, error: err } = await db.from('products')
      .select('id, name, category, pack_size, base_unit')
      .eq('business_id', biz.id).is('archived_at', null)
      .in('category', ['beverage', 'alcohol']))
  }
  if (err) { console.error(`  query error: ${err.message}`); continue }
  if (!prods) { console.error('  prods is null'); continue }
  console.log(`  Beverage/alcohol products: ${prods.length}`)
  const candidates = prods.filter(p => !p.external_catalogue_article)
  console.log(`  Unlinked: ${candidates.length}`)

  const matched   = []
  const ambiguous = []
  const noMatch   = []
  for (const p of candidates) {
    const pTokens = tokens(p.name)
    if (pTokens.length === 0) { noMatch.push({ p, reason: 'no tokens' }); continue }
    const pVol    = inferProductVolMl(p.name, p.pack_size, p.base_unit)
    const pAbv    = inferProductAbv(p.name)
    const hits = []
    for (const s of spendrupsIndex) {
      const j = jaccard(pTokens, s.tokens)
      if (j < JACCARD_FLOOR) continue
      // Volume check (both must have one for the band; if either side is unknown, skip the gate)
      if (pVol != null && s.vol_ml != null) {
        if (Math.abs(pVol - s.vol_ml) / Math.max(pVol, s.vol_ml) > VOL_TOL_PCT) continue
      }
      // ABV check
      if (pAbv != null && s.abv != null) {
        if (Math.abs(pAbv - s.abv) > ABV_TOL_ABS) continue
      }
      hits.push({ s, j })
    }
    hits.sort((a, b) => b.j - a.j)
    if (hits.length === 0)      noMatch.push({ p })
    else if (hits.length === 1) matched.push({ p, hit: hits[0] })
    else {
      // Allow if top hit clearly dominates (j gap >= 0.15)
      if (hits[0].j - hits[1].j >= 0.15) matched.push({ p, hit: hits[0] })
      else                                ambiguous.push({ p, hits: hits.slice(0, 3) })
    }
  }
  console.log(`  Matched: ${matched.length}  Ambiguous: ${ambiguous.length}  No-match: ${noMatch.length}`)

  console.log(`\n  Sample matches:`)
  for (const { p, hit } of matched.slice(0, 12)) {
    console.log(`    "${p.name?.slice(0,40).padEnd(40)}"  →  [${hit.s.sentinel}] "${hit.s.official_name?.slice(0,40)}"  j=${hit.j.toFixed(2)}  art=${hit.s.article_number}`)
  }
  if (ambiguous.length > 0) {
    console.log(`\n  Sample ambiguous (top 2 candidates):`)
    for (const { p, hits } of ambiguous.slice(0, 5)) {
      console.log(`    "${p.name?.slice(0,40)}"`)
      for (const h of hits) console.log(`        ? "${h.s.official_name?.slice(0,42)}" j=${h.j.toFixed(2)}`)
    }
  }

  if (APPLY) {
    let ok = 0
    for (const { p, hit } of matched) {
      const { error } = await db.from('products').update({
        external_catalogue_source:  hit.s.sentinel,
        external_catalogue_article: hit.s.article_number,
      }).eq('id', p.id)
      if (error) console.error(`  ${p.id.slice(0,8)} ${error.message}`)
      else ok++
    }
    console.log(`\n  Applied ${ok}/${matched.length} links`)
  }
}
console.log(APPLY ? '\nDone (--apply).' : '\n(DRY — re-run with --apply to write)')
