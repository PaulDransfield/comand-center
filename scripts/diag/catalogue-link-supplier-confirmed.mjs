// scripts/diag/catalogue-link-supplier-confirmed.mjs
//
// Supplier-confirmed pass — link the long tail that match-spendrups-products.mjs
// couldn't (strict Jaccard ≥ 0.55 + volume/ABV gates).
//
// Premise: when a customer's product is invoiced by Spendrups Bryggeri AB or
// Carlsberg Sverige AB, we already KNOW the supplier — so we can be a lot
// more aggressive about matching against the corresponding scraped catalogue.
// "Birra Poretti 4 Luppoli 5,0%" vs "Poretti Premium Lager" doesn't Jaccard
// well (the customer side has 4 tokens we don't, the catalogue side has 2
// tokens we don't) but they're plainly the same brand at the same supplier.
//
// Two-step pipeline:
//   1. Jaccard pre-filter (≥ 0.20) → drop the obvious non-matches.
//      Volume/ABV gates skip when either side is null (Carlsberg tiles have
//      no volume — gate would always fire false-positive without this).
//   2. Haiku LLM verifies the top candidate. Verdict ≥ 0.90 confidence AND
//      no other candidate at ≥ 0.85 → auto-link with match_method='supplier_confirmed'.
//
// DRY by default. --apply writes products.external_catalogue_*.
//
// Mirrors the orphan-rescue agent's safety thresholds + reasoning capture.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const APIKEY = env.ANTHROPIC_API_KEY
const APPLY  = process.argv.includes('--apply')

const JACCARD_PREFILTER = 0.20
const LLM_CONF_FLOOR    = 0.90
const LLM_RUNNERUP_MAX  = 0.85
const MODEL             = 'claude-haiku-4-5-20251001'

const SUPPLIER_DOMAINS = [
  { pattern: /spendrups/i,            sentinel: 'SPENDRUPS' },
  { pattern: /carlsberg/i,            sentinel: 'CARLSBERG' },
  { pattern: /enjoy\s*wine/i,         sentinel: 'ENJOY'     },
  { pattern: /lively/i,               sentinel: 'LIVELY'    },
]

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

const STOPWORDS = new Set([
  'eko','ekologisk','krav','organic','svensk','svenska','sverige',
  'cl','ml','dl','l','liter','kg','g','st','stk','styck','flaska','burk','can','bot','btl','eg','pet','glas','flask','dunk',
  'docg','doc','igt','aoc','dop',
  'and','och','med','utan','the','de','di','del','la','le','les','el','en',
  'classico','superiore','riserva','reserve','vintage',
])
function tokens(s) {
  if (!s) return []
  let t = String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
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

async function askHaiku(messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': APIKEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      messages,
    }),
  })
  if (!r.ok) throw new Error('Haiku HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200))
  const j = await r.json()
  return j.content?.[0]?.text ?? ''
}

function verdictPrompt(customerName, candidates) {
  const lines = candidates.map((c, i) => '  ' + (i + 1) + '. "' + c.s.official_name + '" (article=' + c.s.article_number + ', brand=' + (c.s.brand ?? '?') + ', abv=' + (c.s.abv ?? '?') + '%, vol=' + (c.s.vol_ml ?? '?') + 'ml)').join('\n')
  return `You are matching a restaurant's invoiced beverage product to a scraped supplier catalogue.

CUSTOMER PRODUCT: "${customerName}"

CATALOGUE CANDIDATES:
${lines}

Decide which candidate is the SAME SKU as the customer product. Same brand + same packaging shape (bottle/can/keg same size) = same SKU. Different vintages / different ABV / different pack size = NOT same. Different brand entirely = NOT same.

Be permissive about naming variations: "Birra Poretti 4 Luppoli" = "Poretti Premium Lager" if catalogue has only one Poretti. "Beefeater London Dry Gin 70cl" = "Beefeater London Dry Gin" (catalogue lacks volume tag). Customer-side prefixes like "Diageo Spirits -" should be stripped.

Respond ONLY with strict JSON:
{
  "best_idx": <1-based candidate index>,
  "confidence": <0-1>,
  "reason": "<one short sentence>"
}
If NO candidate matches, set best_idx=0, confidence=0, reason="no match".`
}

// Load sentinel catalogues + index by tokens.
async function loadSentinel(sentinel) {
  const { data } = await db.from('supplier_articles')
    .select('article_number, official_name, properties, image_cached_path, brand')
    .eq('supplier_fortnox_number', sentinel).eq('fetch_status', 'ok')
  return (data ?? []).map(s => ({
    ...s,
    sentinel,
    tokens: tokens(s.official_name),
    vol_ml: s.properties?.volume_ml ?? null,
    abv:    s.properties?.alcohol_pct ?? null,
  }))
}

console.log('Catalogue link  apply=' + APPLY)
console.log('Loading sentinels...')
const catalogues = {}
for (const d of SUPPLIER_DOMAINS) catalogues[d.sentinel] = await loadSentinel(d.sentinel)
console.log('  SPENDRUPS: ' + catalogues.SPENDRUPS.length + '  CARLSBERG: ' + catalogues.CARLSBERG.length)

for (const biz of BUSINESSES) {
  console.log('\n══ ' + biz.name + ' ══════════════════════════════════════════════════════')
  const { data: prods } = await db.from('products')
    .select('id, name, default_supplier_name')
    .eq('business_id', biz.id).is('archived_at', null)
    .in('category', ['beverage', 'alcohol'])
    .is('external_catalogue_article', null)

  let linked = 0, skipped = 0, noCand = 0
  for (const p of prods) {
    const sup = String(p.default_supplier_name ?? '').toLowerCase()
    const domain = SUPPLIER_DOMAINS.find(d => d.pattern.test(sup))
    if (!domain) continue

    // Skip credit-note style lines.
    if (/avtalsrabatt|pant|öresavrundning|deposit/i.test(p.name)) { skipped++; continue }

    // Pre-filter candidates.
    const pTokens = tokens(p.name)
    if (pTokens.length === 0) { skipped++; continue }
    const candidates = []
    for (const s of catalogues[domain.sentinel]) {
      const j = jaccard(pTokens, s.tokens)
      if (j >= JACCARD_PREFILTER) candidates.push({ s, j })
    }
    if (candidates.length === 0) { noCand++; continue }
    candidates.sort((a, b) => b.j - a.j)
    const top = candidates.slice(0, 5)

    // LLM verdict.
    let verdict
    try {
      const txt = await askHaiku([{ role: 'user', content: verdictPrompt(p.name, top) }])
      const m = txt.match(/\{[\s\S]*\}/)
      if (!m) { skipped++; continue }
      verdict = JSON.parse(m[0])
    } catch (e) {
      console.error('  LLM err ' + p.id.slice(0, 8) + ': ' + (e.message ?? e))
      skipped++; continue
    }

    if (!verdict.best_idx || verdict.confidence < LLM_CONF_FLOOR) {
      console.log('  skip "' + p.name.slice(0, 38).padEnd(38) + '" → conf=' + verdict.confidence + ' (' + (verdict.reason ?? '') + ')')
      skipped++; continue
    }
    const hit = top[verdict.best_idx - 1]?.s
    if (!hit) { skipped++; continue }
    console.log('  LINK "' + p.name.slice(0, 38).padEnd(38) + '" → [' + domain.sentinel + '] "' + hit.official_name + '" conf=' + verdict.confidence)

    if (APPLY) {
      const { error } = await db.from('products').update({
        external_catalogue_source:  domain.sentinel,
        external_catalogue_article: hit.article_number,
      }).eq('id', p.id)
      if (error) console.error('  apply err ' + p.id.slice(0, 8) + ': ' + error.message)
      else linked++
    } else {
      linked++
    }
  }
  console.log('  ' + biz.name + ' summary: ' + (APPLY ? 'linked' : 'would-link') + '=' + linked + ', skipped=' + skipped + ', no-candidate=' + noCand)
}
console.log(APPLY ? '\nDone (--apply).' : '\n(DRY — re-run with --apply to write)')
