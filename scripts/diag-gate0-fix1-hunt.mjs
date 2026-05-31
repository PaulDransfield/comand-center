#!/usr/bin/env node
// scripts/diag-gate0-fix1-hunt.mjs
//
// P2.0 Fix 1 dry-run with multi-purpose-supplier hunt (READ-ONLY).
//
// Simulates the new Gate 0 precedence:
//   1. Per-business override (supplier_classifications M083) — always veto
//   2. Description rule (lib/inventory/description-rules.ts) — always veto
//      (already shipped via Fix 2; here as a no-op for needs_review since
//       Fix 2 already flipped its targets; included for completeness on
//       any new lines)
//   3. Global supplier dictionary (suppliers.ts EXACT_OVERRIDES post-
//      Frimurarholmen removal, plus PATTERN_MATCHERS) — vetoes UNLESS
//      an owner_confirmed alias exists for this line's (supplier,
//      normalised_description). The safeguard prevents the global
//      guess from silently undoing an explicit owner verification.
//   4. Positive routing: basCategory ?? supplierClass
//
// Reports three things:
//   A. Vero Frimurarholmen regression check — confirm the 8 owner_confirmed
//      lines no longer regress
//   B. Multi-purpose-supplier hunt — every line where supplier-veto fires
//      AND BAS gives a positive food/alcohol signal AND no owner_confirmed
//      safeguard. Grouped by supplier; high counts = candidate mis-
//      globalised supplier
//   C. Expected queue movement under new Gate 0 (lines currently needs_
//      review that would move to not_inventory)

import { readFileSync } from 'node:fs'

// ─── Mirror lib/inventory/categories.ts ───
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

// ─── Mirror lib/inventory/suppliers.ts (POST-Frimurarholmen removal) ───
function normaliseSupplierName(raw) {
  if (!raw) return ''
  return raw.toLowerCase()
    .replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o')
    .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
}
const EXACT_OVERRIDES = {
  'martin servera restauranghandel ab':'food','werners gourmetservice ab':'food','laweka gross matevent ab':'food','menigo foodservice ab':'food',
  'kungsholmens kott ab':'food','bergslagsdelikatesser i lindesberg aktiebolag':'food','kvalitetsfisk i stockholm ab':'food','rima seafood ab':'food','tradgardshallen sverige ab':'food','niseko i orebro ab':'food','kogi forsaljnings aktiebolag':'food',
  // 'frimurarholmen ab' REMOVED 2026-05-31 (multi-purpose)
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
  if (norm in EXACT_OVERRIDES) return { category: EXACT_OVERRIDES[norm], source: 'exact_override' }
  for (const p of PATTERN_MATCHERS) {
    if (p.regex.test(n) || p.regex.test(norm)) return { category: p.category, source: 'pattern_match' }
  }
  return null
}

// ─── Normalisation (matches lib/inventory/normalise.ts) ───
const UNIT_SUFFIX_RE = /(\d+)\s+(st|kg|hg|g|l|cl|ml|dl|pack|frp|fp|paket|liter|kilo|gram)\b/gi
function normaliseDescription(raw) {
  if (!raw) return ''
  return raw.toLowerCase()
    .replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o')
    .replace(/[éè]/g, 'e').replace(/[^\w\s]/g, ' ')
    .replace(UNIT_SUFFIX_RE, (_, n, u) => `${n}${u.toLowerCase()}`)
    .replace(/\s+/g, ' ').trim()
}

// ─── Env + DB ───
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
    if (!r.ok) throw new Error(`${path}: ${r.status}: ${await r.text().catch(() => '')}`)
    const rows = await r.json()
    out.push(...rows)
    if (rows.length < ps) break
    from += ps
  }
  return out
}
async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H })
  if (!r.ok) throw new Error(`${path}: ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json()
}

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const BUSINESSES = [
  { id: CHICCE, name: 'Chicce' },
  { id: VERO,   name: 'Vero' },
]

// ─── Owner-confirmed safeguard: bulk-load all owner_confirmed aliases ───
async function loadOwnerConfirmedSafeguard(business_id) {
  const rows = await qPaged(
    `product_aliases?select=supplier_fortnox_number,normalised_description` +
    `&business_id=eq.${business_id}` +
    `&match_method=eq.owner_confirmed` +
    `&is_active=eq.true`
  )
  // Build a Set of "supplier||normalised" keys for fast lookup
  return new Set(rows.map(r => `${r.supplier_fortnox_number}||${r.normalised_description}`))
}

async function loadOwnerOverrides(business_id) {
  const rows = await qPaged(`supplier_classifications?select=supplier_fortnox_number,classification&business_id=eq.${business_id}`)
  return new Map(rows.map(r => [r.supplier_fortnox_number, r.classification]))
}

// ─── New Gate 0 simulation (Fix 1 spec) ───
function newGate0(line, ownerOverride, ownerConfirmedSet) {
  // 0a: per-business override
  if (ownerOverride === 'not_inventory') {
    return { class: 'not_inventory', firedBy: ['owner_override_per_business'] }
  }

  // 0b: description rule — Fix 2 already shipped; checked here for completeness
  //     but it won't fire for needs_review lines anymore (Fix 2 cleaned them up).

  // 0c: global supplier dictionary, with owner_confirmed safeguard
  const supplierClassResult = categoryForSupplier(line.supplier_name_snapshot)
  const supplierClass = supplierClassResult?.category ?? null
  const supplierSource = supplierClassResult?.source ?? null

  const basCategory = categoryForBasAccount(line.account_number)

  if (supplierClass === 'not_inventory') {
    const normalised = normaliseDescription(line.raw_description)
    const safeguarded = normalised && ownerConfirmedSet.has(`${line.supplier_fortnox_number}||${normalised}`)
    if (!safeguarded) {
      // SAFETY HUNT MARKER: supplier veto fires; record whether BAS contradicts
      return {
        class: 'not_inventory',
        firedBy: ['supplier_veto'],
        supplierSource,
        basCategory,
        contradiction: basCategory && ['food','alcohol','beverage'].includes(basCategory),
        safeguarded: false,
      }
    }
    return {
      class: 'safeguarded_passthrough',
      firedBy: [],
      supplierSource,
      basCategory,
      safeguarded: true,
    }
  }

  // 0d: positive routing
  const resolved = basCategory ?? supplierClass
  if (!resolved || resolved === 'other') {
    return { class: 'not_inventory', firedBy: ['fallthrough_unknown'] }
  }
  return { class: resolved, firedBy: [] }
}

// ─── Main ───
async function processBusiness(label, business_id) {
  console.log(`\n${'═'.repeat(78)}\n  ${label}\n${'═'.repeat(78)}`)
  const ownerOverrides = await loadOwnerOverrides(business_id)
  const ownerConfirmedSet = await loadOwnerConfirmedSafeguard(business_id)
  console.log(`  Owner per-business overrides: ${ownerOverrides.size}`)
  console.log(`  Owner-confirmed safeguard signatures: ${ownerConfirmedSet.size}`)

  // Pull current needs_review (the queue we're trying to clean further)
  const needsReviewLines = await qPaged(
    `supplier_invoice_lines?select=id,business_id,supplier_fortnox_number,supplier_name_snapshot,raw_description,account_number,total_excl_vat,match_status,product_alias_id` +
    `&business_id=eq.${business_id}&match_status=eq.needs_review`
  )
  console.log(`  Current needs_review: ${needsReviewLines.length}`)

  // Also pull currently-matched + voucher_backfill lines — the regression-guard
  // population (was 8 Frimurarholmen lines pre-fix; should be 0 post-fix).
  const matchedVbLines = await qPaged(
    `supplier_invoice_lines?select=id,business_id,supplier_fortnox_number,supplier_name_snapshot,raw_description,account_number` +
    `&business_id=eq.${business_id}&match_status=eq.matched&account_source=eq.voucher_backfill`
  )
  console.log(`  Currently-matched + voucher_backfill (regression-guard population): ${matchedVbLines.length}`)

  // ─── A. Regression check — would new Gate 0 veto any currently-matched line? ───
  const regressions = []
  for (const line of matchedVbLines) {
    const ov = ownerOverrides.get(line.supplier_fortnox_number) ?? null
    const r = newGate0(line, ov, ownerConfirmedSet)
    if (r.class === 'not_inventory') {
      regressions.push({ line, r })
    }
  }
  console.log(`  REGRESSION CHECK: currently-matched lines new Gate 0 would veto: ${regressions.length}`)
  if (regressions.length > 0) {
    console.log(`  ⚠️  Frimurarholmen removal expected to drop the 8 pre-fix regressions; any non-zero here is a NEW class — drill in.`)
    for (const r of regressions.slice(0, 20)) {
      console.log(`    [${(r.line.supplier_name_snapshot ?? '?').slice(0,30).padEnd(30)}] "${r.line.raw_description}" — fired: ${r.r.firedBy.join(',')}`)
    }
  }

  // ─── B. needs_review movement under new Gate 0 ───
  const moves = { owner_override: [], supplier_veto: [], fallthrough_unknown: [] }
  const unchanged = []
  for (const line of needsReviewLines) {
    const ov = ownerOverrides.get(line.supplier_fortnox_number) ?? null
    const r = newGate0(line, ov, ownerConfirmedSet)
    if (r.class === 'not_inventory') {
      for (const v of r.firedBy) moves[v]?.push({ line, r })
    } else {
      unchanged.push({ line, r })
    }
  }
  console.log(`\n  ── B. needs_review movement under new Gate 0 ──`)
  console.log(`     owner_override (per-business): ${moves.owner_override.length}`)
  console.log(`     supplier_veto (global dict):   ${moves.supplier_veto.length}`)
  console.log(`     fallthrough_unknown:           ${moves.fallthrough_unknown.length}`)
  console.log(`     unchanged (still needs_review): ${unchanged.length}`)

  // ─── C. Multi-purpose-supplier HUNT ───
  //
  // The signature: supplier veto fires AND BAS gives a positive food/alcohol
  // signal AND no owner_confirmed safeguard. That means the global dictionary
  // is asserting "not_inventory" while the accountant's BAS coding says food.
  // High-count suppliers in this list are candidate mis-globalised entries —
  // owner reviews and decides whether to remove them from EXACT_OVERRIDES.
  console.log(`\n  ── C. MULTI-PURPOSE-SUPPLIER HUNT ──`)
  const hunt = moves.supplier_veto.filter(m => m.r.contradiction)
  console.log(`     Lines where supplier-veto fires AND BAS gives food/alcohol contradiction: ${hunt.length}`)
  if (hunt.length > 0) {
    // Group by supplier
    const bySupplier = new Map()
    for (const h of hunt) {
      const k = h.line.supplier_name_snapshot ?? '?'
      const g = bySupplier.get(k) ?? { name: k, lines: 0, sek_total: 0, supplier_source: h.r.supplierSource, sample_descs: new Set() }
      g.lines += 1
      g.sek_total += Number(h.line.total_excl_vat ?? 0)
      g.sample_descs.add(h.line.raw_description)
      bySupplier.set(k, g)
    }
    const sorted = [...bySupplier.values()].sort((a, b) => b.lines - a.lines)
    console.log(`     Grouped by supplier (high counts = candidate mis-globalised entries):\n`)
    for (const g of sorted) {
      const samples = [...g.sample_descs].slice(0, 3).map(s => `"${s.slice(0,50)}"`).join('; ')
      console.log(`       ${String(g.lines).padStart(4)} lines  ${g.sek_total.toFixed(0).padStart(8)} SEK  source=${g.supplier_source.padEnd(15)}  [${g.name.slice(0,40)}]`)
      console.log(`            samples: ${samples}`)
    }
  } else {
    console.log(`     Clean — no multi-purpose-supplier candidates surfaced.`)
  }

  return { label, business_id, needsReviewLines, regressions, moves, unchanged, hunt }
}

const all = []
for (const biz of BUSINESSES) {
  all.push(await processBusiness(biz.name, biz.id))
}

// ─── HEADLINE ───
console.log(`\n${'═'.repeat(78)}\n  HEADLINE\n${'═'.repeat(78)}`)
for (const r of all) {
  console.log(`\n  ${r.label}:`)
  console.log(`    Regressions on matched+voucher_backfill (expect 0):   ${r.regressions.length}`)
  console.log(`    needs_review → not_inventory under new Gate 0:        ${r.moves.owner_override.length + r.moves.supplier_veto.length + r.moves.fallthrough_unknown.length}`)
  console.log(`      └─ via supplier_veto:                              ${r.moves.supplier_veto.length}`)
  console.log(`      └─ of which surface multi-purpose candidates:       ${r.hunt.length}`)
  console.log(`    needs_review remaining after fix:                     ${r.unchanged.length}`)
}

console.log(`\nDone. Read-only — no writes.`)
