#!/usr/bin/env node
// scripts/diag-gate0-precedence-deposit-dryrun.mjs
//
// P2.0 follow-up Step 0 (READ-ONLY) per p2-0-gate0-precedence-deposit-fix-prompt.md.
//
// Simulates two proposed fixes over the current needs_review population
// for Chicce + Vero and reports what would change:
//
//   Fix 1 — Gate-0 precedence: if ANY of {basCategory, supplierClass,
//           descSignal} returns 'not_inventory', the line is not_inventory.
//           Currently the matcher uses `basCategory ?? supplierClass`,
//           so a 4xxx food account vetos a supplier classifier that
//           says 'not_inventory'. This fix activates the supplier veto.
//
//   Fix 2 — Widen deposit/logistics description rule. Adds ANCHORED
//           arms (^token\M) for the noise classes the elevated-queue
//           dry-run surfaced: PANT*, EUR-PALL, PBA RETUR*, Plockavgift,
//           Distribution, Leveransavgift, Frakt, etc. Each arm is
//           validated both-directions: catches the noise without
//           catching real products whose description merely contains
//           the token.
//
// No writes. Every signal computed in JS using the same source-of-truth
// functions as the matcher (categoryForBasAccount, categoryForSupplier).

import { readFileSync } from 'node:fs'

// ─── Mirror lib/inventory/categories.ts (SPECIFIC_OVERRIDES + 4xxx default) ──
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
function categoryForBasAccount(accountNumber) {
  if (!accountNumber) return null
  const trimmed = String(accountNumber).trim()
  if (!trimmed) return null
  const explicit = SPECIFIC_OVERRIDES[trimmed]
  if (explicit) return explicit
  if (/^4\d{3}$/.test(trimmed)) return 'food'
  return null
}

// ─── Mirror lib/inventory/suppliers.ts (subset — only the categoryForSupplier surface) ───
// Loaded inline to keep the script self-contained. If the source diverges,
// the dry-run will report stale counts — re-export from lib if that becomes a problem.
function normaliseSupplierName(raw) {
  if (!raw) return ''
  return raw.toLowerCase()
    .replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o')
    .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
}
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
function categoryForSupplier(supplierName) {
  if (!supplierName) return null
  const norm = normaliseSupplierName(supplierName)
  if (!norm) return null
  if (norm in EXACT_OVERRIDES) return EXACT_OVERRIDES[norm]
  for (const p of PATTERN_MATCHERS) {
    if (p.regex.test(supplierName) || p.regex.test(norm)) return p.category
  }
  return null
}

// ─── PROPOSED FIX 2 — deposit/logistics description rule ───
//
// Each arm is ANCHORED to ^ + word boundary (\M end-of-word). Anchoring is
// the discipline learned from the ^pant fix: mid-string tokens on real
// product descriptions (e.g. "Coca Cola 33CL, Varav pant per enhet…") must
// NOT be caught.
//
// The arms below are proposed; the script reports both-directions for each
// so we can drop or refine any that produce false positives.
const DEPOSIT_LOGISTICS_PATTERN = new RegExp(
  '^(' +
    // Deposits — PANT variants (already partially caught by existing rebate guard)
    'pant\\M' +
    '|pant\\s+aluminium' +     // PANT ALUMINIUMBURK
    '|pantgr[öo]n\\M' +        // PANTGRÖN Retur SRS
    // Pallets — anchored to start
    '|eur[-\\s]?pall\\M' +     // EUR-PALL, EUR PALL, EURPALL
    '|europall\\M' +
    '|europalle\\M' +          // EUROPAPALLE (Carlsberg's spelling)
    '|plastpall\\M' +
    '|pallet\\M' +
    '|halvpall\\M' +
    '|eng[åa]ngspall\\M' +
    '|kolli\\M' +              // Trädgårdshallen kolli = packaging units
    // Returns/return crates
    '|pba\\s+retur' +          // PBA RETURLÅDA
    '|srs\\s+(retur|back)' +   // SRS RETURBACK, SRS back
    '|retur\\s+srs' +          // Retur SRS Back
    '|returback\\M' +
    // Logistics/handling fees
    '|distribution\\s+' +      // Distribution Chicce/All Event/Frimis
    '|leveransavgift\\M' +
    '|plockavgift\\M' +
    '|frakt\\M' +
    '|fraktavgift\\M' +
    // Environmental / rounding fees (lowercase ones for variant safety)
    '|milj[öo]avgift\\M' +
    '|milj[öo]rabatt\\M' +
  ')',
  'i'
)

function checkDepositLogistics(rawDescription) {
  if (!rawDescription) return null
  return DEPOSIT_LOGISTICS_PATTERN.test(rawDescription) ? 'not_inventory' : null
}

// ─── PROPOSED FIX 1 — new Gate 0 precedence ───
// Returns { class, firedBy } — class is 'not_inventory' or the positive category, firedBy lists every signal that contributed.
function newGate0(line, ownerOverride) {
  const basCategory   = categoryForBasAccount(line.account_number)
  const supplierClass = categoryForSupplier(line.supplier_name_snapshot)
  const descSignal    = checkDepositLogistics(line.raw_description)

  const vetoes = []
  if (ownerOverride === 'not_inventory') vetoes.push('owner_override')
  if (basCategory === 'not_inventory') vetoes.push('bas')
  if (supplierClass === 'not_inventory') vetoes.push('supplier')
  if (descSignal === 'not_inventory') vetoes.push('description')

  if (vetoes.length > 0) {
    return { class: 'not_inventory', firedBy: vetoes, basCategory, supplierClass, descSignal }
  }

  // No veto — fall through to positive path (current logic).
  const resolved = basCategory ?? supplierClass
  if (!resolved || resolved === 'other') {
    return { class: 'not_inventory', firedBy: ['fallthrough_unknown'], basCategory, supplierClass, descSignal }
  }
  return { class: resolved, firedBy: [], basCategory, supplierClass, descSignal }
}

// ─── Env + DB ───────────────────────────────────────────────────────
function parseEnv(path) {
  try {
    return Object.fromEntries(readFileSync(path, 'utf8').split('\n')
      .filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }))
  } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) { console.error('Missing env'); process.exit(1) }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function qPaged(path, pageSize = 1000) {
  const out = []
  let from = 0
  while (true) {
    const sep = path.includes('?') ? '&' : '?'
    const url = `${URL}/rest/v1/${path}${sep}limit=${pageSize}&offset=${from}`
    const r = await fetch(url, { headers: H })
    if (!r.ok) throw new Error(`${path} → HTTP ${r.status}: ${await r.text().catch(() => '')}`)
    const rows = await r.json()
    out.push(...rows)
    if (rows.length < pageSize) break
    from += pageSize
  }
  return out
}

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const BUSINESSES = [
  { id: CHICCE, name: 'Chicce' },
  { id: VERO,   name: 'Vero' },
]

// ─── Pre-load per-business owner overrides for `supplier_classifications` ──
async function loadOwnerOverrides(business_id) {
  const rows = await qPaged(`supplier_classifications?select=supplier_fortnox_number,classification&business_id=eq.${business_id}`)
  const map = new Map()
  for (const r of rows) map.set(r.supplier_fortnox_number, r.classification)
  return map
}

// ─── Main ────────────────────────────────────────────────────────────
async function processBusiness(label, business_id) {
  console.log(`\n${'═'.repeat(78)}\n  ${label}\n${'═'.repeat(78)}`)
  const overrides = await loadOwnerOverrides(business_id)
  console.log(`  Per-business supplier_classifications overrides: ${overrides.size}`)

  const lines = await qPaged(
    `supplier_invoice_lines?` +
    `select=id,business_id,supplier_fortnox_number,supplier_name_snapshot,article_number,raw_description,unit,account_number,account_source,match_status,product_alias_id,total_excl_vat` +
    `&business_id=eq.${business_id}` +
    `&match_status=eq.needs_review`
  )
  console.log(`  needs_review lines: ${lines.length}`)

  const movesByVeto = {
    owner_override: [],
    bas: [],
    supplier: [],
    description: [],
    fallthrough_unknown: [],
  }
  const unchanged = []  // still needs_review under new logic (positive category)
  const movedToNotInventory = []

  for (const line of lines) {
    const ownerOverride = overrides.get(line.supplier_fortnox_number) ?? null
    const r = newGate0(line, ownerOverride)
    if (r.class === 'not_inventory') {
      movedToNotInventory.push({ line, ...r })
      for (const v of r.firedBy) movesByVeto[v].push({ line, ...r })
    } else {
      unchanged.push({ line, ...r })
    }
  }

  console.log(`\n  Movements (currently needs_review → would become not_inventory):`)
  console.log(`    Total moving:                ${movedToNotInventory.length}`)
  console.log(`    By veto signal (a line can fire multiple):`)
  console.log(`      owner_override (M083):     ${movesByVeto.owner_override.length}`)
  console.log(`      BAS account:               ${movesByVeto.bas.length}`)
  console.log(`      Supplier classification:   ${movesByVeto.supplier.length}`)
  console.log(`      Description rule (FIX 2):  ${movesByVeto.description.length}`)
  console.log(`      Fallthrough (unknown signals): ${movesByVeto.fallthrough_unknown.length}`)
  console.log(`    Still needs_review (genuine residual): ${unchanged.length}`)

  return { label, business_id, lines, movedToNotInventory, unchanged, movesByVeto }
}

const allResults = []
for (const biz of BUSINESSES) {
  allResults.push(await processBusiness(biz.name, biz.id))
}

// ─── Direction-A check per new pattern arm: catches across both businesses ──
//
// Direction A: confirm each arm catches actual deposit/logistics lines.
// Direction B: confirm each arm doesn't catch any real product (manual eyeball).

const ALL_ARMS = [
  { name: 'pant\\M (existing — kept)',           regex: /^pant\b/i },
  { name: 'pant\\s+aluminium (PANT ALUMINIUMBURK)', regex: /^pant\s+aluminium/i },
  { name: 'pantgrön/pantgron (PANTGRÖN Retur)',  regex: /^pantgr[öo]n\b/i },
  { name: 'eur-pall/eur pall',                   regex: /^eur[-\s]?pall\b/i },
  { name: 'europall',                            regex: /^europall\b/i },
  { name: 'europalle (Carlsberg)',               regex: /^europalle\b/i },
  { name: 'plastpall',                           regex: /^plastpall\b/i },
  { name: 'pallet',                              regex: /^pallet\b/i },
  { name: 'halvpall',                            regex: /^halvpall\b/i },
  { name: 'engångspall/engangspall',             regex: /^eng[åa]ngspall\b/i },
  { name: 'kolli (Trädgårdshallen)',             regex: /^kolli\b/i },
  { name: 'pba retur',                           regex: /^pba\s+retur/i },
  { name: 'srs retur|back',                      regex: /^srs\s+(retur|back)/i },
  { name: 'retur srs',                           regex: /^retur\s+srs/i },
  { name: 'returback',                           regex: /^returback\b/i },
  { name: 'distribution (with space)',           regex: /^distribution\s+/i },
  { name: 'leveransavgift',                      regex: /^leveransavgift\b/i },
  { name: 'plockavgift',                         regex: /^plockavgift\b/i },
  { name: 'frakt',                               regex: /^frakt\b/i },
  { name: 'fraktavgift',                         regex: /^fraktavgift\b/i },
  { name: 'miljöavgift/miljoavgift',             regex: /^milj[öo]avgift\b/i },
  { name: 'miljörabatt/miljorabatt',             regex: /^milj[öo]rabatt\b/i },
]

const allLines = allResults.flatMap(b => b.lines)
console.log(`\n${'═'.repeat(78)}\n  Direction-A check per new arm — what each catches (cross-business)\n${'═'.repeat(78)}`)
for (const arm of ALL_ARMS) {
  const hits = allLines.filter(l => l.raw_description && arm.regex.test(l.raw_description))
  if (hits.length === 0) {
    console.log(`\n  ${arm.name}: 0 hits — arm doesn't fire anywhere; consider dropping`)
    continue
  }
  // Distinct descriptions
  const distinct = new Map()
  for (const h of hits) {
    const k = (h.raw_description ?? '').trim()
    distinct.set(k, (distinct.get(k) ?? 0) + 1)
  }
  const sorted = [...distinct.entries()].sort((a, b) => b[1] - a[1])
  console.log(`\n  ${arm.name}: ${hits.length} lines, ${distinct.size} distinct descriptions`)
  for (const [desc, n] of sorted.slice(0, 15)) {
    console.log(`    ${String(n).padStart(4)}× "${desc}"`)
  }
  if (sorted.length > 15) console.log(`    … ${sorted.length - 15} more distinct descriptions`)
}

// ─── Direction-B check: anything currently matched/not_inventory that the
// new pattern WOULD have caught — flags risk of false-positive in case
// future runs re-evaluate. Limited to matched lines (these are real products).
console.log(`\n${'═'.repeat(78)}\n  Direction-B check — would any currently 'matched' product be caught?\n${'═'.repeat(78)}`)
const matchedLines = []
for (const biz of BUSINESSES) {
  const more = await qPaged(
    `supplier_invoice_lines?select=id,business_id,raw_description&business_id=eq.${biz.id}&match_status=eq.matched&limit=10000`,
  )
  matchedLines.push(...more)
}
console.log(`  Scanning ${matchedLines.length} 'matched' lines across both businesses…`)
const fpDescs = new Map()
for (const l of matchedLines) {
  if (l.raw_description && DEPOSIT_LOGISTICS_PATTERN.test(l.raw_description)) {
    const k = (l.raw_description ?? '').trim()
    fpDescs.set(k, (fpDescs.get(k) ?? 0) + 1)
  }
}
if (fpDescs.size === 0) {
  console.log(`  CLEAN: 0 currently-matched real products would be caught by the new pattern.`)
} else {
  console.log(`  ⚠️  ${fpDescs.size} distinct currently-matched descriptions match the new pattern:`)
  const sorted = [...fpDescs.entries()].sort((a, b) => b[1] - a[1])
  for (const [desc, n] of sorted) {
    console.log(`    ${String(n).padStart(4)}× "${desc}"`)
  }
  console.log(`\n  → If these are real products (eyeball), the arms catching them need tightening.`)
}

// ─── Confirm P2.0 positive matches don't regress ───
console.log(`\n${'═'.repeat(78)}\n  P2.0 positive-match regression guard\n${'═'.repeat(78)}`)
//   Lines currently match_status='matched' AND account_source='voucher_backfill' should still
//   classify positively under new Gate 0 (not get vetoed by anything).
const vbMatched = []
for (const biz of BUSINESSES) {
  const more = await qPaged(
    `supplier_invoice_lines?select=id,business_id,supplier_fortnox_number,supplier_name_snapshot,account_number,raw_description,total_excl_vat&business_id=eq.${biz.id}&match_status=eq.matched&account_source=eq.voucher_backfill&limit=10000`,
  )
  vbMatched.push(...more)
}
console.log(`  Currently-matched lines with account_source='voucher_backfill': ${vbMatched.length}`)
let regressionCount = 0
for (const line of vbMatched) {
  const r = newGate0(line, null)  // owner overrides not loaded here; rare to flip a matched line
  if (r.class === 'not_inventory') regressionCount += 1
}
console.log(`  Lines that NEW Gate 0 would veto to not_inventory: ${regressionCount}`)
console.log(`  Expected: 0 — these are real matched products. Any non-zero requires investigation.`)

// ─── HEADLINE ─────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(78)}\n  HEADLINE — expected queue reduction\n${'═'.repeat(78)}`)
for (const r of allResults) {
  const dedup = new Set(r.movedToNotInventory.map(m => m.line.id))
  console.log(`\n  ${r.label}:`)
  console.log(`    needs_review NOW:                            ${r.lines.length}`)
  console.log(`    Would move to not_inventory under new rules: ${dedup.size}  (${(100*dedup.size/r.lines.length).toFixed(1)}%)`)
  console.log(`    Genuine residual after fix:                  ${r.unchanged.length}`)
  console.log(`    Of the moves, fired by:`)
  console.log(`      Description rule alone (Fix 2):  ${r.movesByVeto.description.filter(m => !m.firedBy.includes('supplier') && !m.firedBy.includes('owner_override') && !m.firedBy.includes('bas')).length}`)
  console.log(`      Supplier classifier (Fix 1):     ${r.movesByVeto.supplier.length}`)
  console.log(`      Description AND supplier:        ${r.movesByVeto.description.filter(m => m.firedBy.includes('supplier')).length}`)
  console.log(`      Owner override pre-existed:      ${r.movesByVeto.owner_override.length}`)
}

console.log(`\nDone. Read-only — no writes occurred.`)
