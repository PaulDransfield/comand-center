// promote-supplier-weights-v2.mjs
//
// Walks supplier_articles → aliases → products and applies the canonical
// pack-from-supplier-article rule. Replaces the lossy v1 script that
// blindly wrote net_weight_g as pack_size for everything.
//
// Confidence-tiered output:
//   Branch 1 — single_container_weight (DUNK/HINK/PKT/etc.)
//   Branch 2 — count_carton (label "N st/Kartong")
//   Branch 3 — volume_parsed (oils/syrups/milks with NNNml/NNcl/NL in name)
//   Branch 4 — multi_pack_count (eggs etc., name parses Np + per-pack kg)
//
// Conflict policy: if the new pack_size disagrees with the current
// name_parsed value by >2×, SKIP and surface for owner review. Owner-set
// values are never overwritten.
//
// Usage:
//   node scripts/diag/promote-supplier-weights-v2.mjs                      # DRY all
//   node scripts/diag/promote-supplier-weights-v2.mjs --apply --branch=1   # apply Branch 1 only
//   node scripts/diag/promote-supplier-weights-v2.mjs --apply --branch=all # apply all

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const APPLY = process.argv.includes('--apply')
const branchArg = (process.argv.find(a => a.startsWith('--branch=')) ?? '--branch=all').split('=')[1]

// Inline the helper because Node ESM imports of TS from .mjs are awkward
// in this repo. Mirror lib/inventory/pack-from-supplier-article.ts —
// when the TS helper evolves, update this in lockstep.
const SINGLE_WEIGHT_UNITS = new Set(['DUNK','BURK','HINK','PKT','FRP','PÅSE','PASE','SÄCK','SACK','IFRP','KG','ASK','BACK'])
function toUpper(u) { return (u ?? '').trim().toUpperCase() }
function parseVolumeMl(name) {
  let m = name.match(/(?<![\d,.])(\d+(?:[.,]\d+)?)\s*l\b/i)
  if (m) return { ml: Math.round(Number(m[1].replace(',','.')) * 1000), matched: m[0] }
  m = name.match(/(?<![\d,.])(\d+(?:[.,]\d+)?)\s*cl\b/i)
  if (m) return { ml: Math.round(Number(m[1].replace(',','.')) * 10),    matched: m[0] }
  m = name.match(/(?<![\d,.])(\d+(?:[.,]\d+)?)\s*ml\b/i)
  if (m) return { ml: Math.round(Number(m[1].replace(',','.'))),         matched: m[0] }
  return null
}
function parseNPackFromName(name) {
  const m = name.match(/(?<![\d,.])(\d+)\s*(?:p|p\.|-pack|st)\b/i)
  if (m) return { n: parseInt(m[1],10), matched: m[0] }
  return null
}
function parsePerPackWeightG(name) {
  let m = name.match(/(\d+(?:[.,]\d+)?)\s*kg\b/i)
  if (m) return Math.round(Number(m[1].replace(',','.')) * 1000)
  m = name.match(/(\d+(?:[.,]\d+)?)\s*g\b/i)
  if (m) return Math.round(Number(m[1].replace(',','.')))
  return null
}
function parseVolumeLabel(label) {
  let m = label.match(/^(\d+(?:[.,]\d+)?)\s*l\s*\//i)
  if (m) return { ml: Math.round(Number(m[1].replace(',','.')) * 1000) }
  m = label.match(/^(\d+(?:[.,]\d+)?)\s*cl\s*\//i)
  if (m) return { ml: Math.round(Number(m[1].replace(',','.')) * 10) }
  m = label.match(/^(\d+(?:[.,]\d+)?)\s*ml\s*\//i)
  if (m) return { ml: Math.round(Number(m[1].replace(',','.'))) }
  return null
}
function packFromSupplierArticle(row) {
  const unit  = toUpper(row.unit)
  const label = (row.units_per_pack_label ?? '').trim()
  const lower = label.toLowerCase()
  const netG  = row.net_weight_g != null ? Number(row.net_weight_g) : null
  const name  = (row.official_name ?? '').trim()
  // 1 — count carton
  if (/^\d[\d.,]*\s*st\s*\//i.test(lower) && Number.isFinite(Number(row.units_per_pack)) && Number(row.units_per_pack) > 0) {
    const n = Math.round(Number(row.units_per_pack))
    return { kind:'count_carton', pack_size:n, base_unit:'st', confidence:'high',
             notes:`Label "${label}" → ${n} pieces per buy unit` }
  }
  // 2 — volume from label
  const volLabel = parseVolumeLabel(label)
  if (volLabel && unit !== 'KRT' && unit !== 'BACK') {
    return { kind:'volume_from_label', pack_size:volLabel.ml, base_unit:'ml', confidence:'high',
             notes:`Label "${label}" → ${volLabel.ml} ml per buy unit` }
  }
  // 3 — volume from name
  if (unit !== 'KRT' && unit !== 'BACK') {
    const v = parseVolumeMl(name)
    if (v) return { kind:'volume_from_name', pack_size:v.ml, base_unit:'ml', confidence:'high',
                    notes:`Volume "${v.matched}" from name → ${v.ml} ml` }
  }
  // 4 — Viktvara
  if (/^\s*viktvara\s*$/i.test(label) && unit === 'KG') {
    return { kind:'viktvara', pack_size:1000, base_unit:'g', confidence:'high',
             notes:`Label "Viktvara" with unit=KG → 1000 g (1 kg)` }
  }
  // 5 — single container weight
  if (netG != null && netG > 0 && (SINGLE_WEIGHT_UNITS.has(unit) || (unit === 'ST' && /\/styck/i.test(lower)))) {
    return { kind:'single_container_weight', pack_size:netG, base_unit:'g', confidence:'high',
             notes:`Unit=${unit} treated as single container, net_weight=${netG}g` }
  }
  // 6 — multi-pack count carton
  if (unit === 'KRT' && netG != null && netG > 0 && /\/kartong/i.test(lower)) {
    const np = parseNPackFromName(name)
    const perPackG = parsePerPackWeightG(name)
    if (np && perPackG && perPackG > 0) {
      const subPacks = Math.round(netG / perPackG)
      if (subPacks >= 1 && subPacks <= 50) {
        const totalSt = np.n * subPacks
        return { kind:'multi_pack_count', pack_size:totalSt, base_unit:'st',
                 confidence: subPacks === 1 ? 'high' : 'medium',
                 notes:`"${np.matched}" + per-pack ${perPackG}g → ${subPacks} sub-pack(s) × ${np.n} = ${totalSt} st per KRT` }
      }
    }
  }
  return { kind:'skip', reason:`unit=${unit||'∅'} label="${label||'∅'}" net_g=${netG??'∅'}` }
}

// ===== Driver =====
console.log('Loading supplier_articles…')
const articles = []
let from = 0
while (true) {
  const { data, error } = await db.from('supplier_articles')
    .select('supplier_fortnox_number, article_number, official_name, unit, net_weight_g, units_per_pack, units_per_pack_label, fetch_status')
    .eq('fetch_status', 'ok')
    .order('article_number').range(from, from + 999)
  if (error) { console.error(error.message); break }
  if (!data?.length) break
  articles.push(...data)
  if (data.length < 1000) break
  from += 1000
}
console.log(`Loaded ${articles.length} supplier_articles rows.`)

const articleByKey = new Map()
for (const a of articles) articleByKey.set(`${a.supplier_fortnox_number}|${a.article_number}`, a)

// Resolve articles → aliases → products
const aliasToArticle = new Map()
const CHUNK = 100
for (let i = 0; i < articles.length; i += CHUNK) {
  const slice = articles.slice(i, i + CHUNK)
  const artNums = slice.map(a => a.article_number)
  const { data } = await db.from('supplier_invoice_lines')
    .select('product_alias_id, supplier_fortnox_number, article_number')
    .in('article_number', artNums)
    .not('product_alias_id', 'is', null)
  for (const l of data ?? []) {
    const k = `${l.supplier_fortnox_number}|${l.article_number}`
    if (!articleByKey.has(k)) continue
    if (!aliasToArticle.has(l.product_alias_id)) aliasToArticle.set(l.product_alias_id, k)
  }
}
console.log(`Aliases pointing at scraped articles: ${aliasToArticle.size}`)

const aliasIds = [...aliasToArticle.keys()]
const productToArticle = new Map()
for (let i = 0; i < aliasIds.length; i += 100) {
  const slice = aliasIds.slice(i, i + 100)
  const { data } = await db.from('product_aliases').select('id, product_id').in('id', slice)
  for (const a of data ?? []) {
    if (!productToArticle.has(a.product_id)) productToArticle.set(a.product_id, aliasToArticle.get(a.id))
  }
}
console.log(`Distinct products: ${productToArticle.size}`)

// Pull products + classify
const productIds = [...productToArticle.keys()]
const byBranch = { count_carton: [], volume_from_label: [], volume_from_name: [], viktvara: [], single_container_weight: [], multi_pack_count: [] }
const skipped = { owner_set: 0, no_change: 0, conflict: 0, branch_skip: 0 }
const conflicts = []   // owner-review queue

for (let i = 0; i < productIds.length; i += 100) {
  const slice = productIds.slice(i, i + 100)
  const { data: prods } = await db.from('products')
    .select('id, name, pack_size, base_unit, pack_source, invoice_unit')
    .in('id', slice)
  for (const p of prods ?? []) {
    const k = productToArticle.get(p.id)
    const a = articleByKey.get(k); if (!a) continue
    const decision = packFromSupplierArticle(a)
    if (decision.kind === 'skip') { skipped.branch_skip++; continue }
    if (p.pack_source === 'owner_set') { skipped.owner_set++; continue }
    if (p.pack_size != null && Number(p.pack_size) === decision.pack_size && p.base_unit === decision.base_unit) {
      skipped.no_change++; continue
    }
    // Conflict: name_parsed already set AND disagrees by >2× → SKIP + review
    // EXCEPTION: if current value is < 10 (clearly a Swedish-comma-as-decimal
    // parser bug like "1,785g" → 1.785 instead of 1785), allow the override.
    if (p.pack_source === 'name_parsed' && p.pack_size != null && Number.isFinite(Number(p.pack_size))) {
      const oldPack = Number(p.pack_size)
      const ratio   = Math.max(oldPack, decision.pack_size) / Math.max(1, Math.min(oldPack, decision.pack_size))
      const sameUnit = p.base_unit === decision.base_unit
      const obviouslyBuggy = oldPack > 0 && oldPack < 10 && decision.pack_size > 100   // tiny value, MS says realistic
      if ((!sameUnit || ratio > 2) && !obviouslyBuggy) {
        conflicts.push({ id: p.id, name: p.name, old: { p: oldPack, b: p.base_unit }, new: { p: decision.pack_size, b: decision.base_unit }, branch: decision.kind, article: a })
        skipped.conflict++
        continue
      }
    }
    byBranch[decision.kind].push({
      id: p.id, name: p.name,
      old_pack: p.pack_size, old_base: p.base_unit, old_source: p.pack_source,
      new_pack: decision.pack_size, new_base: decision.base_unit,
      confidence: decision.confidence, notes: decision.notes,
      article: a,
    })
  }
}

console.log(`\n=== Proposals by branch ===`)
for (const [b, list] of Object.entries(byBranch)) {
  console.log(`  ${b}: ${list.length}`)
}
console.log(`\nSkipped: owner_set=${skipped.owner_set}, no_change=${skipped.no_change}, conflict=${skipped.conflict}, branch_skip=${skipped.branch_skip}`)

for (const [b, list] of Object.entries(byBranch)) {
  if (list.length === 0) continue
  console.log(`\n--- ${b} (showing first 8 of ${list.length}) ---`)
  for (const p of list.slice(0, 8)) {
    console.log(`  • "${p.name}"`)
    console.log(`      ${p.old_pack ?? '∅'} ${p.old_base ?? '∅'} (${p.old_source ?? '∅'}) → ${p.new_pack} ${p.new_base}  conf=${p.confidence}`)
    console.log(`      ${p.notes}`)
  }
}

if (conflicts.length > 0) {
  console.log(`\n=== CONFLICTS — needs owner review (${conflicts.length}, showing first 12) ===`)
  for (const c of conflicts.slice(0, 12)) {
    console.log(`  • "${c.name}"  (${c.branch})`)
    console.log(`      currently ${c.old.p} ${c.old.b}   vs   MS implies ${c.new.p} ${c.new.b}`)
    console.log(`      MS art ${c.article.article_number} "${c.article.official_name}" unit=${c.article.unit} net=${c.article.net_weight_g}g label="${c.article.units_per_pack_label}"`)
  }
}

if (APPLY) {
  const apply = branchArg === 'all'
    ? Object.values(byBranch).flat()
    : (byBranch[branchSlug(branchArg)] ?? [])
  console.log(`\n=== APPLYING ${apply.length} ===`)
  let ok = 0
  for (const p of apply) {
    const { error } = await db.from('products')
      .update({ pack_size: p.new_pack, base_unit: p.new_base, pack_source: 'supplier_official' })
      .eq('id', p.id)
    if (error) { console.error(`  "${p.name}" failed: ${error.message}`); continue }
    ok++
  }
  console.log(`Updated: ${ok} / ${apply.length}`)
} else {
  console.log(`\n(DRY mode — re-run with --apply --branch=<1|2|3|4|all> to write)`)
}

function branchSlug(arg) {
  // Slug numbers MUST match the byBranch declaration order at the top
  // of the file so the DRY report's branch labels and the --branch=N
  // CLI flag agree.
  return ({
    '1': 'count_carton',
    '2': 'volume_from_label',
    '3': 'volume_from_name',
    '4': 'viktvara',
    '5': 'single_container_weight',
    '6': 'multi_pack_count',
    'all': 'all',
  })[arg] ?? arg
}
