#!/usr/bin/env node
// scripts/diag-gate0-regression-detail.mjs
//
// Drill-in on the 67 currently-matched voucher_backfill lines that the
// proposed new Gate 0 would veto to not_inventory. Two possibilities:
//   (a) wrong matches like the 17 Chicce Carlsberg rebate aliases (the
//       new rule correctly catching past mistakes — proceed with apply
//       + outcome correction transaction per P2.0)
//   (b) real food/alcohol products whose description happens to contain
//       a deposit-y token (false positive — tighten pattern arms)
//
// Reports raw_description + supplier + alias + product, grouped by
// which veto signal fires. Read-only.

import { readFileSync } from 'node:fs'

// Same pattern + categories code as diag-gate0-precedence-deposit-dryrun.mjs
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
function categoryForBasAccount(a) { if (!a) return null; const t = String(a).trim(); if (!t) return null; if (SPECIFIC_OVERRIDES[t]) return SPECIFIC_OVERRIDES[t]; if (/^4\d{3}$/.test(t)) return 'food'; return null }
function normaliseSupplierName(raw) { if (!raw) return ''; return raw.toLowerCase().replace(/å/g,'a').replace(/ä/g,'a').replace(/ö/g,'o').replace(/[^\w\s]/g,' ').replace(/\s+/g,' ').trim() }
const EXACT_OVERRIDES = {
  'martin servera restauranghandel ab':'food','werners gourmetservice ab':'food','laweka gross matevent ab':'food','menigo foodservice ab':'food',
  'kungsholmens kott ab':'food','bergslagsdelikatesser i lindesberg aktiebolag':'food','kvalitetsfisk i stockholm ab':'food','rima seafood ab':'food','tradgardshallen sverige ab':'food','niseko i orebro ab':'food','kogi forsaljnings aktiebolag':'food',
  'frimurarholmen ab':'not_inventory',
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

const DEPOSIT_LOGISTICS_PATTERN = new RegExp(
  '^(' +
    'pant\\M|pant\\s+aluminium|pantgr[öo]n\\M' +
    '|eur[-\\s]?pall\\M|europall\\M|europalle\\M|plastpall\\M|pallet\\M|halvpall\\M|eng[åa]ngspall\\M|kolli\\M' +
    '|pba\\s+retur|srs\\s+(retur|back)|retur\\s+srs|returback\\M' +
    '|distribution\\s+|leveransavgift\\M|plockavgift\\M|frakt\\M|fraktavgift\\M' +
    '|milj[öo]avgift\\M|milj[öo]rabatt\\M' +
  ')',
  'i'
)

function parseEnv(p) { try { return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]})) } catch { return {} } }
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function qPaged(path, ps=1000) { const out=[]; let from=0; while(true){const sep=path.includes('?')?'&':'?'; const r=await fetch(`${URL}/rest/v1/${path}${sep}limit=${ps}&offset=${from}`,{headers:H}); if(!r.ok)throw new Error(`${path}: ${r.status}`); const rows=await r.json(); out.push(...rows); if(rows.length<ps)break; from+=ps} return out }
async function q(path) { const r=await fetch(`${URL}/rest/v1/${path}`,{headers:H}); if(!r.ok)throw new Error(`${path}: ${r.status}`); return r.json() }

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

// Pull every currently-matched + voucher_backfill line and check which would regress
const all = []
for (const bid of [CHICCE, VERO]) {
  const rows = await qPaged(`supplier_invoice_lines?select=id,business_id,supplier_fortnox_number,supplier_name_snapshot,raw_description,account_number,product_alias_id,total_excl_vat&business_id=eq.${bid}&match_status=eq.matched&account_source=eq.voucher_backfill`)
  all.push(...rows)
}
console.log(`Total currently-matched + voucher_backfill lines: ${all.length}`)

const regressions = []
for (const line of all) {
  const basCategory = categoryForBasAccount(line.account_number)
  const supplierClass = categoryForSupplier(line.supplier_name_snapshot)
  const descSignal = (line.raw_description && DEPOSIT_LOGISTICS_PATTERN.test(line.raw_description)) ? 'not_inventory' : null
  const vetoes = []
  if (basCategory === 'not_inventory') vetoes.push('bas')
  if (supplierClass === 'not_inventory') vetoes.push('supplier')
  if (descSignal === 'not_inventory') vetoes.push('description')
  if (vetoes.length > 0) {
    regressions.push({ line, vetoes, basCategory, supplierClass, descSignal })
  }
}
console.log(`Lines new Gate 0 would veto: ${regressions.length}\n`)

// Fetch product names for the affected aliases
const aliasIds = [...new Set(regressions.map(r => r.line.product_alias_id).filter(Boolean))]
const aliasList = aliasIds.map(id => `"${id}"`).join(',')
const aliases = aliasIds.length === 0 ? [] : await q(`product_aliases?select=id,raw_description,product_id,match_method,match_confidence&id=in.(${aliasList})`)
const aliasMap = new Map(aliases.map(a => [a.id, a]))
const productIds = [...new Set(aliases.map(a => a.product_id).filter(Boolean))]
const products = productIds.length === 0 ? [] : await q(`products?select=id,name,category&id=in.(${productIds.map(id => `"${id}"`).join(',')})`)
const productMap = new Map(products.map(p => [p.id, p]))

// Group by which signal fired
const bySignal = { bas: [], supplier: [], description: [], multi: [] }
for (const r of regressions) {
  if (r.vetoes.length > 1) bySignal.multi.push(r)
  else bySignal[r.vetoes[0]].push(r)
}

for (const [signal, items] of Object.entries(bySignal)) {
  if (items.length === 0) continue
  console.log(`\n${'═'.repeat(78)}\n  Vetoed by signal: ${signal} (${items.length} lines)\n${'═'.repeat(78)}`)
  // Group by (supplier, raw_description) for compactness
  const groups = new Map()
  for (const item of items) {
    const k = `${item.line.supplier_name_snapshot ?? '?'}||${item.line.raw_description ?? ''}`
    const g = groups.get(k) ?? { ...item, count: 0, total_sek: 0 }
    g.count += 1
    g.total_sek += Number(item.line.total_excl_vat ?? 0)
    groups.set(k, g)
  }
  const sorted = [...groups.values()].sort((a,b) => b.count - a.count)
  for (const g of sorted) {
    const alias = aliasMap.get(g.line.product_alias_id)
    const product = alias?.product_id ? productMap.get(alias.product_id) : null
    console.log(`  ${String(g.count).padStart(3)}× ${g.total_sek.toFixed(0).padStart(8)}SEK [${(g.line.supplier_name_snapshot ?? '?').slice(0,30).padEnd(30)}] "${g.line.raw_description}"`)
    console.log(`        → linked to product: "${product?.name ?? '(deleted)'}"  via alias.method=${alias?.match_method ?? '?'}`)
  }
}

console.log(`\nDone.`)
