// Simulate the dedupe ladder against the names of the products that
// today's auto-merge consolidated. Confirms the new POST /api/inventory/
// items endpoint would have caught each one as "did you mean X?" instead
// of letting the orphan get created.
//
// We mirror the algorithm from lib/inventory/normalise.ts. Update both
// in lockstep when the helper changes.

function normaliseDescription(raw) {
  if (!raw) return ''
  return raw.toLowerCase()
    .replace(/å/g,'a').replace(/ä/g,'a').replace(/ö/g,'o')
    .replace(/[éè]/g,'e')
    .replace(/[^\w\s]/g, ' ')
    .replace(/(\d+)\s+(st|kg|hg|g|l|cl|ml|dl|pack|frp|fp|paket|liter|kilo|gram)\b/gi, (_, n, u) => `${n}${u.toLowerCase()}`)
    .replace(/\s+/g, ' ').trim()
}

const NOISE_TAILS = [
  /,?\s*nyckelhål\s*;?\s*$/i,
  /,?\s*från\s+sverige\s*;?\s*$/i,
  /,?\s*ursprungsland\s*:\s*[^,;()]+;?\s*$/i,
  /,?\s*eu-?ekologisk\s*;?\s*$/i,
  /,?\s*krav\s*;?\s*$/i,
  /,?\s*svensk\s+fågel\s*;?\s*$/i,
  /,?\s*msc\s*;?\s*$/i,
  /,?\s*kött\s+fr\s+sverige\s*;?\s*$/i,
  /\(\s*sverige\s*\)\s*$/i,
]

function normaliseProductName(raw) {
  if (!raw) return ''
  let s = raw
  let changed = true
  while (changed) {
    changed = false
    for (const re of NOISE_TAILS) {
      const next = s.replace(re, '')
      if (next !== s) { s = next; changed = true }
    }
  }
  return normaliseDescription(s)
}

function tokenise(name) {
  return new Set(normaliseProductName(name).split(/\s+/).filter(t => t.length > 1))
}

function jaccard(a, b) {
  const A = tokenise(a), B = tokenise(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0; for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

// The cases today's auto-merge consolidated. (orphan_name, owner_name)
const CASES = [
  ['HARICOTS VERTS 2,5KG, Nyckelhål;',      'Haricots Verts 2,5kg'],
  ['HASSELNÖTSKÄRNA BLANCH 1KG Nyckelhål;', 'Hasselnötskärna Blanch 1kg'],
  ['KÖRSBÄR UKÄ 2,5KG Nyckelhål;',          'Körsbär Ukä 2,5kg'],
  ['HJORTYTTERFILE 1,1-1,8KG Ursprungsland:Nya Zeeland', 'Hjortytterfile 1,1-1,8kg'],
  ['Tvål & Shampoo ULTRA 2,5L',             'Tvål & Schampo ULTRA 2,5L (2/fp)'],
  ['Villa Massa Limoncello 50cl',           'Villa Massa Limoncello 50c'],
  ['Pagus Bisano Valp Rip Doc 75eg',        'PAGUS BISANO VALP RIP DOC 75EG'],
  ['Oxfilé svans 2,5kg x 2st',              'Oxfilé svans 2,5kg x 2st (Sverige)'],
  ['Kallrökt lax skivad fryst',             'Kallrökt lax skivad fryst Vinga Seafood'],
  ['Hummerkött vac 320g * MSC',             'Hummerkött vac 300g * MSC'],
  ['Argentinsk kummelfilé 110/220 MSC',     'Stillahavskummelfilé 110/220 MSC'],
  ['Antica Osteria Rosso 75eg',             'Casa Vinicola Antica Osteria Rosso Montepulciano 12,5% 75cl'],
  ['Beefeater Lond Dry Gin 40% 1x0,70 Bot', 'Beefeater London Dry Gin 40% 70cl'],
]

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

// For a given (chef-typed) name + business, simulate Step D — search
// supplier_invoice_lines by ilike on first token, score by Jaccard
// against raw_description, aggregate by alias→product, return best.
async function simulateStepD(businessId, name) {
  const firstToken = name.split(/\s+/)[0]?.toLowerCase()
  if (!firstToken || firstToken.length < 3) return null
  const cutoff = new Date(Date.now() - 18 * 30 * 86400000).toISOString().slice(0, 10)
  const { data: lines } = await db.from('supplier_invoice_lines')
    .select('product_alias_id, raw_description')
    .eq('business_id', businessId).gte('invoice_date', cutoff)
    .not('product_alias_id','is',null).not('raw_description','is',null)
    .ilike('raw_description', `%${firstToken}%`).limit(500)
  const aliasHits = new Map()
  for (const l of lines ?? []) {
    const sim = jaccard(name, l.raw_description)
    if (sim < 0.5) continue
    const prev = aliasHits.get(l.product_alias_id)
    if (!prev) aliasHits.set(l.product_alias_id, { bestSim: sim, sampleDesc: l.raw_description })
    else if (sim > prev.bestSim) { prev.bestSim = sim; prev.sampleDesc = l.raw_description }
  }
  if (aliasHits.size === 0) return null
  const aliasIds = [...aliasHits.keys()]
  const { data: aliases } = await db.from('product_aliases').select('id, product_id').in('id', aliasIds).eq('is_active', true)
  const productHits = new Map()
  for (const a of aliases ?? []) {
    const h = aliasHits.get(a.id); if (!h) continue
    const prev = productHits.get(a.product_id)
    if (!prev) productHits.set(a.product_id, { bestSim: h.bestSim, sampleDesc: h.sampleDesc })
    else if (h.bestSim > prev.bestSim) { prev.bestSim = h.bestSim; prev.sampleDesc = h.sampleDesc }
  }
  if (productHits.size === 0) return null
  // Best by sim
  const top = [...productHits.entries()].sort((a,b) => b[1].bestSim - a[1].bestSim)[0]
  return { product_id: top[0], bestSim: top[1].bestSim, sampleDesc: top[1].sampleDesc }
}

console.log('Dedupe-ladder simulation against the 13 auto-merge cases:\n')
let exact = 0, normalised = 0, similar = 0, line_sim = 0, missed = 0
for (const [orphan, owner] of CASES) {
  const normOrphan = normaliseProductName(orphan)
  const normOwner  = normaliseProductName(owner)
  const sim        = jaccard(orphan, owner)
  let result
  if (orphan === owner)              { result = 'STEP A — exact'; exact++ }
  else if (normOrphan === normOwner) { result = 'STEP B — normalised'; normalised++ }
  else if (sim >= 0.7)               { result = `STEP C — similarity ${sim.toFixed(2)}`; similar++ }
  else {
    // Step D — try both businesses (we don't know which the orphan was at)
    const dC = await simulateStepD(CHICCE, orphan)
    const dV = await simulateStepD(VERO, orphan)
    const d = (dC && (!dV || dC.bestSim >= dV.bestSim)) ? dC : dV
    if (d) {
      result = `STEP D — line sim ${d.bestSim.toFixed(2)} via "${d.sampleDesc.slice(0,40)}"`
      line_sim++
    } else {
      result = `MISSED — name sim ${sim.toFixed(2)}, no line match`
      missed++
    }
  }
  console.log(`  "${orphan}"`)
  console.log(`    → ${result}`)
}

console.log(`\nSummary:`)
console.log(`  Step A (exact):       ${exact}`)
console.log(`  Step B (normalised):  ${normalised}`)
console.log(`  Step C (name sim):    ${similar}`)
console.log(`  Step D (line sim):    ${line_sim}`)
console.log(`  MISSED:               ${missed}`)
console.log(`Catch rate: ${((CASES.length - missed) / CASES.length * 100).toFixed(0)}%`)
