#!/usr/bin/env node
// scripts/diag-gate0-70-regressions-drillin.mjs
//
// Drill into the 70 Vero "regressions" surfaced by diag-gate0-fix1-hunt.mjs.
//
// The question the owner posed: distinguish lines where the owner
// *confirmed this specific alias→product link* (gold-standard signal,
// worth protecting via safeguard) from lines that are merely
// match_status='matched' for some other reason (auto-fuzzy guess,
// historical artifact — these should stay vulnerable to re-veto, not
// be entrenched by a safeguard).
//
// Read-only. Classifies by alias.match_method:
//
//   owner_confirmed     → human-confirmed (PROTECT via safeguard)
//   fuzzy_same_supplier → machine guess (DON'T protect — audit queue's job)
//   fuzzy_cross_supplier→ machine guess (DON'T protect)
//   article_number      → exact-match against pre-existing alias
//                         (this LINE used an exact match; the underlying
//                          alias has its own match_method which we need
//                          to check separately — these are valid alias
//                          rows in the table per the CHECK constraint
//                          on product_aliases, but the matcher only
//                          INSERTS new aliases with the four 'creation'
//                          methods. So if any alias has this value, it
//                          predates the current insertion logic or came
//                          from a different path. Report verbatim.)
//   description_exact   → same caveat as article_number

import { readFileSync } from 'node:fs'

function parseEnv(p) {
  try {
    return Object.fromEntries(readFileSync(p, 'utf8').split('\n')
      .filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }))
  } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function qPaged(path, ps = 1000) {
  const out = []
  let from = 0
  while (true) {
    const sep = path.includes('?') ? '&' : '?'
    const r = await fetch(`${URL}/rest/v1/${path}${sep}limit=${ps}&offset=${from}`, { headers: H })
    if (!r.ok) throw new Error(`${path}: ${r.status}`)
    const rows = await r.json()
    out.push(...rows)
    if (rows.length < ps) break
    from += ps
  }
  return out
}
async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H })
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return r.json()
}

// Same NEW Gate 0 logic as diag-gate0-fix1-hunt.mjs (Frimurarholmen-removed dict)
const SPECIFIC_OVERRIDES = {
  '4010':'food','4011':'alcohol','4012':'beverage','4013':'food','4014':'food',
  '4015':'disposables','4016':'food','4017':'takeaway_material','4018':'takeaway_material','4019':'food',
  '4020':'food','4030':'food','4040':'food','4050':'food','4060':'food','4070':'food','4080':'food','4090':'food',
  '4021':'beverage','4022':'beverage','4023':'beverage','4024':'beverage',
  '4025':'alcohol','4026':'alcohol','4027':'alcohol','4028':'alcohol',
  '4110':'food','4120':'food',
  '5410':'disposables','5411':'disposables','5420':'disposables',
  '5460':'cleaning','5461':'cleaning','5462':'cleaning','5470':'disposables',
}
function categoryForBasAccount(a) {
  if (!a) return null
  const t = String(a).trim()
  if (!t) return null
  if (SPECIFIC_OVERRIDES[t]) return SPECIFIC_OVERRIDES[t]
  if (/^4\d{3}$/.test(t)) return 'food'
  return null
}
function normaliseSupplierName(raw) {
  if (!raw) return ''
  return raw.toLowerCase().replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
}
const EXACT_OVERRIDES = {
  'martin servera restauranghandel ab':'food','werners gourmetservice ab':'food','laweka gross matevent ab':'food','menigo foodservice ab':'food',
  'kungsholmens kott ab':'food','bergslagsdelikatesser i lindesberg aktiebolag':'food','kvalitetsfisk i stockholm ab':'food','rima seafood ab':'food','tradgardshallen sverige ab':'food','niseko i orebro ab':'food','kogi forsaljnings aktiebolag':'food',
  // frimurarholmen ab removed
  'carlsberg sverige aktiebolag':'alcohol','carlsberg intrum':'not_inventory','spendrups bryggeri ab':'alcohol','anora sweden ab':'alcohol','enjoy wine spirits ab':'alcohol','lihnells distillery ab':'alcohol','lively wines sweden ab':'alcohol','wine affair scandinavia ab':'alcohol','out of home ab':'alcohol',
  'ab tingstad papper':'takeaway_material','quatra sweden ab':'disposables',
  'orebro tvatt ab':'cleaning','renall ab':'cleaning','prezero recycling ab':'not_inventory',
  'e on energidistribution aktiebolag':'not_inventory','caspeco ab':'not_inventory','fortnox ab':'not_inventory','fortnox aktiebolag':'not_inventory','advania sverige ab':'not_inventory','cedra sverige ab':'not_inventory','flow sweden ab':'not_inventory','qvanti ab':'not_inventory','elavon':'not_inventory','fora ab':'not_inventory','sami':'not_inventory','securitas direct sverige ab':'not_inventory','svenskt naringsliv service ab':'not_inventory','we are marketing sverige ab':'not_inventory','barkonsult jakobsson lovgren ab':'not_inventory','ohrlings pricewaterhousecoopers ab':'not_inventory','orebro kommun':'not_inventory','orebro kommun tekniska':'not_inventory','orebro sotar n ab':'not_inventory','hlk elgruppen ab':'not_inventory','varme installation storkoksserv':'not_inventory','eventcenter i orebro ab':'not_inventory','pitchers i orebro ab':'not_inventory','ps inkasso juridik ab':'not_inventory','sthal ab':'not_inventory','ancon ab':'not_inventory','ancon aktiebolag':'not_inventory',
  'lawe restaurang ab':'not_inventory',
}
const PATTERN_MATCHERS = [
  { regex: /\b(wine|vin|spirits?|liquor|whisky|whiskey|gin|rum|tequila|brennerei|distillery)\b/i, category: 'alcohol' },
  { regex: /\b(bryggeri|brewery|brewing)\b/i, category: 'alcohol' },
  { regex: /\b(kott|meat|gris|nott|biff|kyckling|chicken|charkuteri)\b/i, category: 'food' },
  { regex: /\b(fisk|fish|seafood|skaldjur|musslor)\b/i, category: 'food' },
  { regex: /\b(bageri|bakery|brod|baguette)\b/i, category: 'food' },
  { regex: /\b(gron|gronsak|produce|tradgard|frukt|vegetables?|fruits?)\b/i, category: 'food' },
  { regex: /\b(mejeri|dairy|ost|cheese)\b/i, category: 'food' },
  { regex: /\b(grossist|wholesaler|restauranghandel|foodservice)\b/i, category: 'food' },
  { regex: /\b(tvatt|laundry|stadning|cleaning|cleanco|tvattservice)\b/i, category: 'cleaning' },
  { regex: /\b(papper|paper|forpackning|packaging|emballage)\b/i, category: 'takeaway_material' },
  { regex: /\b(forsakring|insurance|inkasso|debt|advokat|jurist|lawyer|revisor|accounting|accountant)\b/i, category: 'not_inventory' },
  { regex: /\b(installation|reparation|service|underhall|tekn)\b/i, category: 'not_inventory' },
  { regex: /\b(energi|electricity|fjarrvarme|gas|vatten|water|telefoni|internet|broadband|hosting|cloud)\b/i, category: 'not_inventory' },
]
function categoryForSupplier(n) {
  if (!n) return null
  const norm = normaliseSupplierName(n)
  if (!norm) return null
  if (norm in EXACT_OVERRIDES) return EXACT_OVERRIDES[norm]
  for (const p of PATTERN_MATCHERS) if (p.regex.test(n) || p.regex.test(norm)) return p.category
  return null
}

const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

// Pull all currently-matched + voucher_backfill lines at Vero
const lines = await qPaged(
  `supplier_invoice_lines?select=id,business_id,supplier_fortnox_number,supplier_name_snapshot,raw_description,account_number,product_alias_id,total_excl_vat` +
  `&business_id=eq.${VERO}&match_status=eq.matched&account_source=eq.voucher_backfill`
)

// Compute regressions (new Gate 0 would veto)
const regressions = []
for (const line of lines) {
  const supplierClass = categoryForSupplier(line.supplier_name_snapshot)
  const basCategory   = categoryForBasAccount(line.account_number)
  // Apply new Gate 0 (without safeguard) — we want to count what WOULD regress before safeguard
  let vetoSignal = null
  if (supplierClass === 'not_inventory') vetoSignal = 'supplier_veto'
  else {
    const resolved = basCategory ?? supplierClass
    if (!resolved || resolved === 'other') vetoSignal = 'fallthrough_unknown'
  }
  if (vetoSignal) regressions.push({ line, vetoSignal, supplierClass, basCategory })
}
console.log(`Total currently-matched + voucher_backfill at Vero: ${lines.length}`)
console.log(`Regressions (would be vetoed by new Gate 0): ${regressions.length}`)
console.log(`  by veto signal:`)
const bySignal = {}
for (const r of regressions) bySignal[r.vetoSignal] = (bySignal[r.vetoSignal] ?? 0) + 1
for (const [k, v] of Object.entries(bySignal)) console.log(`    ${k}: ${v}`)

// Fetch alias details for each regression line
const aliasIds = [...new Set(regressions.map(r => r.line.product_alias_id).filter(Boolean))]
console.log(`\nFetching ${aliasIds.length} distinct aliases...`)
const aliasMap = new Map()
// Batch in chunks of 50 to keep URLs short
for (let i = 0; i < aliasIds.length; i += 50) {
  const batch = aliasIds.slice(i, i + 50)
  const aliasList = batch.map(id => `"${id}"`).join(',')
  const aliases = await q(`product_aliases?select=id,raw_description,match_method,match_confidence,first_seen_at,product_id,is_active&id=in.(${aliasList})`)
  for (const a of aliases) aliasMap.set(a.id, a)
}

// Fetch product names
const productIds = [...new Set([...aliasMap.values()].map(a => a.product_id).filter(Boolean))]
const productMap = new Map()
for (let i = 0; i < productIds.length; i += 50) {
  const batch = productIds.slice(i, i + 50)
  const products = await q(`products?select=id,name,category&id=in.(${batch.map(id => `"${id}"`).join(',')})`)
  for (const p of products) productMap.set(p.id, p)
}

// Classify each regression by alias match_method
const byMethod = {}
for (const r of regressions) {
  const a = aliasMap.get(r.line.product_alias_id)
  const m = a?.match_method ?? '(alias not found)'
  if (!byMethod[m]) byMethod[m] = []
  byMethod[m].push({ ...r, alias: a, product: a?.product_id ? productMap.get(a.product_id) : null })
}

console.log(`\n${'═'.repeat(78)}\n  REGRESSION SPLIT by alias.match_method\n${'═'.repeat(78)}\n`)
console.log(`  This is the answer to: "are the 70 owner_confirmed or merely matched?"\n`)
const order = ['owner_confirmed', 'fuzzy_same_supplier', 'fuzzy_cross_supplier', 'article_number', 'description_exact', '(alias not found)']
for (const m of order) {
  if (!byMethod[m]) continue
  console.log(`\n  ── ${m} (${byMethod[m].length} lines) ──`)
  // Group by (supplier, raw_description) for compactness
  const groups = new Map()
  for (const r of byMethod[m]) {
    const k = `${r.line.supplier_name_snapshot ?? '?'}||${r.line.raw_description ?? ''}`
    const g = groups.get(k) ?? { ...r, count: 0, sek_total: 0 }
    g.count += 1
    g.sek_total += Number(r.line.total_excl_vat ?? 0)
    groups.set(k, g)
  }
  for (const g of [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 30)) {
    const product_name = g.product?.name ?? '(deleted)'
    console.log(`    ${String(g.count).padStart(3)}× ${g.sek_total.toFixed(0).padStart(8)}SEK [${(g.line.supplier_name_snapshot ?? '?').slice(0,28).padEnd(28)}] veto=${g.vetoSignal.padEnd(20)} basCat=${(g.basCategory ?? 'null').padEnd(10)} alias.conf=${(g.alias?.match_confidence ?? 'n/a').toString().padEnd(10)}`)
    console.log(`        line desc: "${g.line.raw_description}"`)
    console.log(`        alias raw: "${g.alias?.raw_description ?? '(no alias)'}" → product "${product_name}"`)
  }
}

console.log(`\n${'═'.repeat(78)}\n  HEADLINE\n${'═'.repeat(78)}\n`)
const counts = Object.fromEntries(order.map(m => [m, (byMethod[m]?.length ?? 0)]))
const ownerConfirmed = counts.owner_confirmed
const machineGuess   = (counts.fuzzy_same_supplier ?? 0) + (counts.fuzzy_cross_supplier ?? 0)
const exactMatch     = (counts.article_number ?? 0) + (counts.description_exact ?? 0)
const total          = regressions.length
console.log(`  owner_confirmed (human-verified, PROTECT):      ${ownerConfirmed.toString().padStart(3)} / ${total} = ${(100*ownerConfirmed/Math.max(1,total)).toFixed(1)}%`)
console.log(`  machine fuzzy   (machine guess, DON'T protect): ${machineGuess.toString().padStart(3)} / ${total} = ${(100*machineGuess/Math.max(1,total)).toFixed(1)}%`)
console.log(`  exact-match     (predates current matcher logic): ${exactMatch.toString().padStart(3)} / ${total}`)
console.log(``)
if (ownerConfirmed / Math.max(1, total) > 0.5) {
  console.log(`  → MOSTLY owner_confirmed: BROADEN the safeguard. The 70 prove the narrow`)
  console.log(`    (supplier-veto-only) version was incomplete; owner confirmation should`)
  console.log(`    outrank fallthrough_unknown too.`)
} else if (machineGuess / Math.max(1, total) > 0.5) {
  console.log(`  → MOSTLY machine guesses: do NOT broaden. These are exactly the fragile`)
  console.log(`    matches the audit queue exists to catch. They should stay vulnerable to`)
  console.log(`    re-veto. The narrow safeguard remains correct.`)
} else {
  console.log(`  → MIXED: needs eyeball decision. Look at the exact-match bucket — are`)
  console.log(`    those genuinely human-traceable matches (alias originally created by`)
  console.log(`    owner action) or auto-generated cache rows? Verdict depends on that.`)
}

console.log(`\nDone. Read-only — no writes.`)
