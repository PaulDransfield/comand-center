#!/usr/bin/env node
// scripts/diag-stage-vero-queue.mjs
//
// Stage Vero's needs_review queue for Paul's manual categorization pass.
// READ-ONLY for Steps 1+2. Step 3 PROPOSES rules but does NOT apply.
// Per stage-vero-queue-manual-pass-prompt.md.

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

async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H })
  if (!r.ok) throw new Error(`${path}: ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json()
}
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

const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const ALL_VERO_NR_FIELDS = 'id,supplier_fortnox_number,supplier_name_snapshot,fortnox_invoice_number,raw_description,article_number,quantity,total_excl_vat,account_number,account_source,match_status,source'

function isEmpty(s) { return s == null || String(s).trim() === '' }

// Same deposit/logistics/rebate pattern as the matcher Gate 0b /
// sql/p20-fix2-deposit-logistics. Mirror the shipped regex.
const DEPOSIT_LOGISTICS_REBATE = new RegExp(
  '(' +
    'avtalsrabatt|^rabatt|^pant\\b|pantersättning|öresavrundning|faktureringsavg|inkassoarvode|påminnelseavg' +
    '|^pantgr[öo]n\\b|^eur[-\\s]?pall\\b|^plastpall\\b|^pallet\\b|^halvpall\\b|^eng[åa]ngspall\\b|^kolli\\b' +
    '|^pba\\s+retur|^srs\\s+(?:retur|back)|^retur\\s+srs|^distribution\\s+|^leveransavgift\\b|^plockavgift\\b' +
    '|^frakt\\b|^milj[öo]rabatt\\b' +
  ')',
  'i'
)

// ═══════════════════════════════════════════════════════════════════
// STEP 1 — VERIFY (READ-ONLY)
// ═══════════════════════════════════════════════════════════════════

console.log(`${'═'.repeat(78)}\n  STEP 1 — Verify queue state (READ-ONLY)\n${'═'.repeat(78)}`)

const allNR = await qPaged(
  `supplier_invoice_lines?select=${ALL_VERO_NR_FIELDS}&business_id=eq.${VERO}&match_status=eq.needs_review`
)
console.log(`\n  Vero needs_review total: ${allNR.length}`)

const emptyDesc   = allNR.filter(r => isEmpty(r.raw_description))
const hasDesc     = allNR.filter(r => !isEmpty(r.raw_description))
const hasAcct     = allNR.filter(r => r.account_number != null)
const nullAcct    = allNR.filter(r => r.account_number == null)

console.log(`\n  ── Queue composition ──`)
console.log(`    Empty-description:                ${emptyDesc.length}`)
console.log(`    Has-description:                  ${hasDesc.length}`)
console.log(`    Has account_number:               ${hasAcct.length}`)
console.log(`    Null account_number:              ${nullAcct.length}`)

const byAccountSource = {}
for (const r of allNR) byAccountSource[r.account_source ?? '(null)'] = (byAccountSource[r.account_source ?? '(null)'] ?? 0) + 1
console.log(`\n  ── account_source distribution ──`)
for (const [k,v] of Object.entries(byAccountSource).sort((a,b)=>b[1]-a[1])) console.log(`    ${k.padEnd(22)} ${v}`)

// CRITICAL: deposit/logistics noise — should be 0 in needs_review post-Fix-1+2
const stragglers = allNR.filter(r => r.raw_description && DEPOSIT_LOGISTICS_REBATE.test(r.raw_description))
console.log(`\n  ── Deposit/logistics/rebate stragglers in needs_review (expect 0) ──`)
console.log(`    Total: ${stragglers.length}`)
if (stragglers.length > 0) {
  console.log(`    ⚠️  Fix 1+2 didn't fully settle — these should have moved to not_inventory:`)
  const byDesc = new Map()
  for (const s of stragglers) {
    const k = (s.raw_description ?? '').trim()
    byDesc.set(k, (byDesc.get(k) ?? 0) + 1)
  }
  for (const [d,n] of [...byDesc.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15)) {
    console.log(`      ${String(n).padStart(4)}× "${d}"`)
  }
}

// Reconcile against the empty-descriptions investigation numbers
console.log(`\n  ── Reconcile against known numbers ──`)
console.log(`    Prior investigation: 2,197 total / 656 empty / 1,541 drainable denominator`)
console.log(`    Current run:         ${allNR.length} total / ${emptyDesc.length} empty / ${allNR.length - emptyDesc.length} drainable`)

// ═══════════════════════════════════════════════════════════════════
// STEP 2 — THREE BUCKETS (READ-ONLY)
// ═══════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(78)}\n  STEP 2 — Three-bucket split\n${'═'.repeat(78)}`)

// Group empties by supplier — identify the top 7 itemized-impossible wholesalers
const emptyBySupplier = new Map()
for (const r of emptyDesc) {
  const key = r.supplier_fortnox_number
  const g = emptyBySupplier.get(key) ?? {
    supplier_fortnox_number: key,
    name: r.supplier_name_snapshot ?? '?',
    count: 0,
    sek: 0,
    accounts: new Set(),
  }
  g.count += 1
  g.sek += Math.abs(Number(r.total_excl_vat ?? 0))
  if (r.account_number) g.accounts.add(r.account_number)
  emptyBySupplier.set(key, g)
}
const supplierRanked = [...emptyBySupplier.values()].sort((a,b)=>b.count-a.count)

// Bucket A: empties from the top-N food/drink wholesalers
// (Cutoff: any supplier contributing >= 25 empty lines in needs_review)
const TOP_N_CUTOFF = 25
const topSuppliers = supplierRanked.filter(s => s.count >= TOP_N_CUTOFF)
const topSupplierNums = new Set(topSuppliers.map(s => s.supplier_fortnox_number))

const bucketA = emptyDesc.filter(r => topSupplierNums.has(r.supplier_fortnox_number))
const bucketA_other = emptyDesc.filter(r => !topSupplierNums.has(r.supplier_fortnox_number))

// Bucket B: deposit/logistics stragglers (computed above)
const bucketB = stragglers

// Bucket C: everything else
const bucketC = allNR.filter(r =>
  !bucketA.includes(r) &&
  !bucketB.includes(r) &&
  !bucketA_other.includes(r)  // also exclude empties from minor suppliers (they're un-itemizable too, just not concentrated)
)

console.log(`\n  Bucket A — un-itemizable empties from top food/drink wholesalers (>=${TOP_N_CUTOFF} lines): ${bucketA.length} lines`)
console.log(`    SEK: ${bucketA.reduce((s,r)=>s+Math.abs(Number(r.total_excl_vat ?? 0)),0).toFixed(0)}`)
console.log(`    Suppliers (${topSuppliers.length}):`)
for (const s of topSuppliers) {
  console.log(`      ${String(s.count).padStart(4)}× ${s.sek.toFixed(0).padStart(8)} SEK  #${s.supplier_fortnox_number.padEnd(10)} ${s.name.slice(0,40).padEnd(40)} accounts: ${[...s.accounts].sort().join(',') || '(none)'}`)
}

console.log(`\n  Bucket A-other — un-itemizable empties from smaller suppliers: ${bucketA_other.length} lines`)
console.log(`    SEK: ${bucketA_other.reduce((s,r)=>s+Math.abs(Number(r.total_excl_vat ?? 0)),0).toFixed(0)}`)
console.log(`    Long tail: ${supplierRanked.length - topSuppliers.length} suppliers contribute these`)

console.log(`\n  Bucket B — deposit/logistics stragglers (should be 0): ${bucketB.length} lines`)
console.log(`    SEK: ${bucketB.reduce((s,r)=>s+Math.abs(Number(r.total_excl_vat ?? 0)),0).toFixed(0)}`)

console.log(`\n  Bucket C — has-description itemizable lines (THE REAL WORK): ${bucketC.length} lines`)
console.log(`    SEK: ${bucketC.reduce((s,r)=>s+Math.abs(Number(r.total_excl_vat ?? 0)),0).toFixed(0)}`)

// Deduplicate Bucket C by (supplier, normalised raw_description) — distinct products
const UNIT_SUFFIX_RE = /(\d+)\s+(st|kg|hg|g|l|cl|ml|dl|pack|frp|fp|paket|liter|kilo|gram)\b/gi
function normalise(raw) {
  if (!raw) return ''
  return raw.toLowerCase().replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o')
    .replace(/[éè]/g, 'e').replace(/[^\w\s]/g, ' ')
    .replace(UNIT_SUFFIX_RE, (_, n, u) => `${n}${u.toLowerCase()}`)
    .replace(/\s+/g, ' ').trim()
}
const distinctC = new Set()
for (const r of bucketC) distinctC.add(`${r.supplier_fortnox_number}||${normalise(r.raw_description)}`)
console.log(`\n  HEADLINE — Bucket C distinct itemizable products (supplier × normalised description): ${distinctC.size}`)
console.log(`    Line-to-distinct ratio: ${bucketC.length > 0 ? (bucketC.length/Math.max(1,distinctC.size)).toFixed(1) : 'n/a'}`)
console.log(`    → THIS is the scope of Paul's manual pass — ~${distinctC.size} product decisions, not ${bucketC.length} line eyeballs.`)

// Sanity check totals
console.log(`\n  Bucket totals: A=${bucketA.length} + A-other=${bucketA_other.length} + B=${bucketB.length} + C=${bucketC.length} = ${bucketA.length + bucketA_other.length + bucketB.length + bucketC.length}`)
console.log(`  Should equal allNR.length=${allNR.length} — match: ${(bucketA.length + bucketA_other.length + bucketB.length + bucketC.length) === allNR.length ? 'YES ✓' : 'NO ⚠️'}`)

// ═══════════════════════════════════════════════════════════════════
// STEP 3 — PROPOSE RULES (DO NOT APPLY)
// ═══════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(78)}\n  STEP 3 — Stage per-supplier rules (PROPOSE, do not apply)\n${'═'.repeat(78)}`)
console.log(`\n  Semantic: terminal-state ONLY empty-description lines from these suppliers.`)
console.log(`  Itemized (non-empty) lines from the same suppliers MUST stay in queue.\n`)

// For each top supplier, both-directions check:
//   - count empty needs_review lines (would be moved)
//   - count non-empty needs_review lines from same supplier (must NOT be moved)
//   - count empty NON-needs_review lines (already terminal — for context)
const allFromTopSuppliers = await qPaged(
  `supplier_invoice_lines?select=id,supplier_fortnox_number,supplier_name_snapshot,raw_description,account_number,match_status,total_excl_vat` +
  `&business_id=eq.${VERO}` +
  `&supplier_fortnox_number=in.(${[...topSupplierNums].map(n => `"${n}"`).join(',')})`
)

for (const s of topSuppliers) {
  const sLines = allFromTopSuppliers.filter(r => r.supplier_fortnox_number === s.supplier_fortnox_number)
  const sEmptyNR     = sLines.filter(r => isEmpty(r.raw_description) && r.match_status === 'needs_review')
  const sEmptyOther  = sLines.filter(r => isEmpty(r.raw_description) && r.match_status !== 'needs_review')
  const sHasDescNR   = sLines.filter(r => !isEmpty(r.raw_description) && r.match_status === 'needs_review')
  const sHasDescOther = sLines.filter(r => !isEmpty(r.raw_description) && r.match_status !== 'needs_review')

  const accDist = new Map()
  for (const r of sEmptyNR) accDist.set(r.account_number ?? '(null)', (accDist.get(r.account_number ?? '(null)') ?? 0) + 1)

  console.log(`  ── ${s.name} (Fortnox #${s.supplier_fortnox_number}) ──`)
  console.log(`     Rule would flip:        ${sEmptyNR.length} empty-description needs_review lines (${sEmptyNR.reduce((sum,r)=>sum+Math.abs(Number(r.total_excl_vat ?? 0)),0).toFixed(0)} SEK)`)
  console.log(`     Account distribution:   ${[...accDist.entries()].map(([a,n]) => `${a}:${n}`).join(', ')}`)
  console.log(`     Both-directions guard:`)
  console.log(`       Itemized needs_review lines from same supplier (MUST stay):    ${sHasDescNR.length}`)
  console.log(`       Empties already terminal (matched/not_inventory — context):    ${sEmptyOther.length}`)
  console.log(`       Itemized terminal lines (matched products — confirms supplier sells real items): ${sHasDescOther.length}`)
  if (sHasDescNR.length > 0) {
    console.log(`     Sample itemized lines that WOULD STAY:`)
    for (const r of sHasDescNR.slice(0, 3)) {
      console.log(`       "${(r.raw_description ?? '').slice(0,55)}"`)
    }
  }
  console.log()
}

// Mechanism flag
console.log(`${'─'.repeat(78)}`)
console.log(`  MECHANISM CHOICE (the trap)`)
console.log(`${'─'.repeat(78)}`)
console.log(`
  The existing per-business override mechanism — supplier_classifications
  (M083) — is a BLANKET rule: it terminal-states EVERY line from a given
  supplier at a given business. That is the wrong tool for these 7 rules.
  These suppliers sell real food/drink — itemized lines from them must
  stay in the queue (or get matched normally). M083 would catch the
  itemized lines too, which is the opposite of what the prompt wants.

  Two ways to express the narrower "empty-only" semantic:

    (a) ONE-TIME SQL flip (analogous to Fix 2 deposit-guard backfill).
        UPDATE supplier_invoice_lines SET match_status='not_inventory'
        WHERE business_id=Vero AND supplier_fortnox_number IN (top7)
          AND match_status='needs_review' AND raw_description IS NULL/empty
        Idempotent. Handles the current queue. Future incoming empty
        lines from these suppliers would re-elevate to needs_review on
        ingest unless a persistent rule is added.

    (b) NEW PERSISTENT RULE — a (business_id, supplier_fortnox_number)
        + "empty_description_to_not_inventory" flag table the matcher
        consults at Gate 0. Catches both existing and future empties.
        ~1 schema migration + a few lines in matcher.ts.

  Recommendation: (a) for THIS staging round so Paul's manual pass lands
  on the cleaned queue, plus (b) as a small persistent fix afterwards so
  the rule survives future ingests. The two work together — (a) is the
  immediate one-time clean; (b) is the durable rule.

  EITHER WAY: stop here, this is staging. Awaiting Paul's go on the
  7 rules + the mechanism choice.
`)

console.log(`Done. Read-only — no rows changed.`)
