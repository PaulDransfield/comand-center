#!/usr/bin/env node
// scripts/diag-p20-voucher-backfill-step1-dryrun.mjs
//
// P2.0 Step 1 — DRY-RUN of the voucher-as-ground-truth back-fill +
// rebate-pattern guard. Read-only; writes nothing. Per the prompt:
//
//   "Produce the full report of what WOULD be written (per business:
//    lines affected, account distribution) and show it before any write."
//
// And per owner refinement on the rebate guard:
//
//   "The dry-run should report exactly which lines the guard moves to
//    not_inventory, by description, so we can eyeball that it's only
//    catching true rebates before it goes live — same dry-run discipline
//    as the back-fill itself."
//
// TWO independent operations characterised separately:
//
//   OPERATION 1 — Account back-fill (categorisation signal).
//     Target: supplier_invoice_lines whose parent invoice maps to a
//     SINGLE-expense-account voucher (per Step 0 finding).
//     Write would be: account_number = <expense_account>,
//                     account_source = 'voucher_backfill'
//     Effect: Gate 0 routes via categoryForBasAccount instead of the
//             supplier-name fallback. Doesn't change match_status on
//             already-matched lines (matcher only acts on needs_review).
//
//   OPERATION 2 — Rebate guard (description-level signal, complementary).
//     Target: lines whose raw_description matches REBATE_NOISE_PATTERN.
//     Fires REGARDLESS of BAS account (per owner: "general case, not
//     just to rescue Vero").
//     Write would be: match_status = 'not_inventory',
//                     product_alias_id = NULL
//     Effect: removes from review queue + correctly labels as
//             not_inventory in metrics.
//
// IDEMPOTENT: re-running this script produces identical line IDs +
// identical accounts. No writes anywhere.

import { readFileSync } from 'node:fs'

function parseEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter(l => l.includes('=') && !l.trim().startsWith('#'))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
    )
  } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) { console.error('Missing env'); process.exit(1) }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const BUSINESSES = [
  { id: CHICCE, name: 'Chicce Slotsgatan' },
  { id: VERO,   name: 'Vero Italiano'    },
]

// REVISED pattern — owner-locked after dry-run #1 surfaced a real
// false-positive class at Chicce. The original D3 pattern had
// `\bpant\b` which catches BOTH legitimate deposit lines (PANT…)
// AND product names with ", Varav pant per enhet:" appended as a
// deposit annotation (e.g. "COCA COLA BRK 33CL, Varav pant per
// enhet: 17,80"). Routing those Coca-Cola lines to not_inventory
// would be wrong.
//
// Fix: anchor to start (`^pant\b`). Every legitimate deposit line
// in the dry-run leads with PANT / Pant; every false positive has
// `pant` mid-string after Varav. Owner approved 2026-05-30.
const REBATE_PATTERN = /(avtalsrabatt|^rabatt|^pant\b|pantersättning|öresavrundning|faktureringsavg|inkassoarvode|påminnelseavg)/i

// Original (pre-fix) — kept for the DIRECTION-B check below: any
// line caught by the old pattern but NOT by the new one is now NOT
// routed to not_inventory. Owner must eyeball that list to confirm
// it's all false positives, not legitimate deposits we dropped.
const REBATE_PATTERN_OLD = /(avtalsrabatt|^rabatt|\bpant\b|pantersättning|öresavrundning|faktureringsavg|inkassoarvode|påminnelseavg)/i

// Exclude list for BAS accounts that should never end up in account_number
// because they're the AP / VAT / rounding side of the booking.
const EXCLUDE_ACCOUNTS = new Set([
  2440, 2641, 2642, 2643, 2644, 2645, 2646, 2647, 2648, 2649,
  2990,                         // accrued costs (manual entry credit side)
  3740, 7960, 7980,
])
function isExpenseAccount(acct) {
  if (acct == null || !Number.isFinite(acct)) return false
  if (EXCLUDE_ACCOUNTS.has(acct)) return false
  if (acct >= 1000 && acct < 3000) return false
  if (acct >= 3000 && acct < 4000) return false
  if (acct >= 8000)                return false
  return true
}

async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H })
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json()
}
async function qPaged(path, pageSize = 1000) {
  const out = []
  let from = 0
  while (true) {
    const r = await fetch(`${URL}/rest/v1/${path}`, {
      headers: { ...H, Range: `${from}-${from + pageSize - 1}`, Prefer: 'count=none' },
    })
    if (!r.ok) throw new Error(`GET ${path} (range ${from}) → HTTP ${r.status}: ${await r.text().catch(() => '')}`)
    const rows = await r.json()
    out.push(...rows)
    if (rows.length < pageSize) break
    from += pageSize
    if (from > 100_000) break
  }
  return out
}

const section = (t) => console.log(`\n${'═'.repeat(78)}\n  ${t}\n${'═'.repeat(78)}`)

// Local mirror of categoryForBasAccount for human-readable labels.
function categoryForBasLocal(acct) {
  if (acct == null || !Number.isFinite(acct)) return null
  const SPECIFIC = {
    4010: 'food', 4011: 'alcohol', 4012: 'beverage', 4013: 'food', 4014: 'food',
    4015: 'disposables', 4016: 'food', 4017: 'takeaway_material', 4018: 'takeaway_material',
    4019: 'food', 4020: 'food', 4021: 'beverage', 4022: 'beverage', 4023: 'beverage',
    4024: 'beverage', 4025: 'alcohol', 4026: 'alcohol', 4027: 'alcohol', 4028: 'alcohol',
    4030: 'food', 4040: 'food', 4050: 'food', 4060: 'food', 4070: 'food',
    4080: 'food', 4090: 'food', 4110: 'food', 4120: 'food',
    5410: 'disposables', 5411: 'disposables', 5420: 'disposables',
    5460: 'cleaning', 5461: 'cleaning', 5462: 'cleaning', 5470: 'disposables',
  }
  if (SPECIFIC[acct]) return SPECIFIC[acct]
  if (acct >= 4000 && acct < 5000) return 'food (default 4xxx rule)'
  return null
}

const summary = []

for (const biz of BUSINESSES) {
  section(`Business: ${biz.name} (${biz.id})`)

  // Pull lines + bridge + vouchers (same as Step 0)
  const lines = await qPaged(
    `supplier_invoice_lines?select=id,fortnox_invoice_number,match_status,account_number,raw_description,total_excl_vat,product_alias_id&business_id=eq.${biz.id}`
  )
  const linesById = new Map(lines.map(l => [l.id, l]))
  const linesByInvoice = new Map()
  for (const l of lines) {
    const arr = linesByInvoice.get(l.fortnox_invoice_number) ?? []
    arr.push(l)
    linesByInvoice.set(l.fortnox_invoice_number, arr)
  }
  const distinctInvoices = [...linesByInvoice.keys()]
  console.log(`  Total lines: ${lines.length}  distinct invoices: ${distinctInvoices.length}`)

  // Resolve invoice → voucher via raw_data.Vouchers JSONB
  const invToVoucher = new Map()
  for (let i = 0; i < distinctInvoices.length; i += 200) {
    const slice = distinctInvoices.slice(i, i + 200).map(n => `"${n}"`).join(',')
    const rows = await q(`fortnox_supplier_invoices?select=given_number,raw_data&business_id=eq.${biz.id}&given_number=in.(${slice})`)
    for (const r of rows) {
      const arr = Array.isArray(r.raw_data?.Vouchers) ? r.raw_data.Vouchers : null
      if (!arr) continue
      const bookings = arr.filter(v => v?.ReferenceType === 'SUPPLIERINVOICE')
      if (bookings.length === 0) continue
      const b = bookings[0]
      invToVoucher.set(r.given_number, { series: b.Series, number: b.Number })
    }
  }

  // Pull all vouchers for this business and build index
  const vouchersAll = await qPaged(
    `fortnox_vouchers_cache?select=voucher_series,voucher_number,rows&business_id=eq.${biz.id}`
  )
  const voucherIdx = new Map()
  for (const v of vouchersAll) {
    voucherIdx.set(`${v.voucher_series}|${v.voucher_number}`, v)
  }

  // ── OPERATION 1 — Account back-fill plan ─────────────────────────────
  // Determine: for each invoice, what's the single expense account (if any)?
  // Build the (line_id, account_number) tuples that would be written.
  const accountBackfillTuples = []   // { line_id, current_account, new_account, raw_description, total_excl_vat }
  const accountTallies = new Map()   // expense_account → line count
  let invoicesSingleAccount = 0
  let invoicesMultiAccount  = 0
  let invoicesZeroAccount   = 0
  let invoicesVoucherMiss   = 0

  for (const givenNumber of distinctInvoices) {
    const ref = invToVoucher.get(givenNumber)
    if (!ref) { invoicesVoucherMiss++; continue }
    const v = voucherIdx.get(`${ref.series}|${ref.number}`)
    if (!v) { invoicesVoucherMiss++; continue }
    const expRows = (v.rows ?? []).filter(r => Number(r.Debit ?? 0) > 0 && isExpenseAccount(Number(r.Account)))
    const distinct = new Set(expRows.map(r => Number(r.Account)))
    if (distinct.size === 0)      { invoicesZeroAccount++;  continue }
    if (distinct.size  >  1)      { invoicesMultiAccount++; continue }
    invoicesSingleAccount++
    const acct = [...distinct][0]
    for (const line of linesByInvoice.get(givenNumber)) {
      accountBackfillTuples.push({
        line_id:           line.id,
        current_account:   line.account_number,
        new_account:       acct,
        raw_description:   line.raw_description,
        total_excl_vat:    Number(line.total_excl_vat ?? 0),
        match_status:      line.match_status,
      })
      accountTallies.set(acct, (accountTallies.get(acct) ?? 0) + 1)
    }
  }

  console.log(`\n  OPERATION 1 — Account back-fill plan`)
  console.log(`    ${accountBackfillTuples.length} lines would have account_number set`)
  console.log(`    (from ${invoicesSingleAccount} single-account voucher-matched invoices)`)
  console.log(`    Skipped: ${invoicesMultiAccount} multi-account invoices (left NULL — conservative default)`)
  console.log(`    Skipped: ${invoicesZeroAccount} zero-expense-account invoices (no debit-side expense rows)`)
  console.log(`    Skipped: ${invoicesVoucherMiss} invoices with no voucher resolved`)

  console.log(`\n    Account distribution (account / line count / category route):`)
  const sortedAccts = [...accountTallies.entries()].sort((a, b) => b[1] - a[1])
  for (const [acct, n] of sortedAccts) {
    const cat = categoryForBasLocal(acct)
    console.log(`      ${String(acct).padEnd(6)} ${String(n).padStart(5)} lines  → ${cat ?? '(not_inventory)'}`)
  }

  // Lines that would change ALSO break out by match_status (so we see how
  // many already-matched vs needs_review lines get the new signal — only
  // needs_review benefits immediately; matched lines benefit on next rematch)
  const byStatus = new Map()
  for (const t of accountBackfillTuples) {
    byStatus.set(t.match_status, (byStatus.get(t.match_status) ?? 0) + 1)
  }
  console.log(`\n    Back-fill affected lines by match_status:`)
  for (const [s, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(s).padEnd(16)} ${n}`)
  }

  // Show 5 sample tuples for eyeball
  console.log(`\n    Sample back-fill rows (first 5):`)
  for (const t of accountBackfillTuples.slice(0, 5)) {
    console.log(`      line=${t.line_id.slice(0, 8)}… status=${t.match_status.padEnd(14)}  ${String(t.new_account).padEnd(6)}  "${(t.raw_description ?? '').slice(0, 60)}"`)
  }

  // ── OPERATION 2 — Rebate guard plan ──────────────────────────────────
  // Fires regardless of BAS account; based on raw_description match.
  const rebateLines = lines.filter(l => l.raw_description && REBATE_PATTERN.test(l.raw_description))

  console.log(`\n  OPERATION 2 — Rebate guard plan`)
  console.log(`    Pattern: ${REBATE_PATTERN.source}  (case-insensitive)`)
  console.log(`    ${rebateLines.length} lines would be routed to match_status='not_inventory' (+ product_alias_id=NULL)`)

  // Break by current match_status — so we see if we're changing already-matched
  // rows (intrusive: clears alias link) vs needs_review (no alias to clear).
  const rebateByStatus = new Map()
  for (const l of rebateLines) rebateByStatus.set(l.match_status, (rebateByStatus.get(l.match_status) ?? 0) + 1)
  console.log(`\n    By current match_status:`)
  for (const [s, n] of [...rebateByStatus.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(s).padEnd(16)} ${n}`)
  }
  const alreadyMatchedWithAlias = rebateLines.filter(l => l.match_status === 'matched' && l.product_alias_id).length
  if (alreadyMatchedWithAlias > 0) {
    console.log(`      → of which ${alreadyMatchedWithAlias} are 'matched' with a non-null product_alias_id`)
    console.log(`        (the rebate guard WOULD clear those alias links; flagged INTRUSIVE — see "Open question" below)`)
  }

  // CRITICAL OWNER REQUIREMENT — full distinct-description list for eyeball.
  // Show every distinct raw_description that would be moved, with counts,
  // sorted by count desc. Owner scans for false positives (legit products
  // with 'rabatt' / 'pant' / etc. that aren't really rebates).
  const descCounts = new Map()
  for (const l of rebateLines) {
    const k = (l.raw_description ?? '').trim()
    descCounts.set(k, (descCounts.get(k) ?? 0) + 1)
  }
  const sortedDescs = [...descCounts.entries()].sort((a, b) => b[1] - a[1])
  console.log(`\n    DIRECTION A — distinct descriptions CAUGHT by NEW guard (eyeball for false positives KEPT):`)
  console.log(`      ${sortedDescs.length} distinct descriptions, ${rebateLines.length} total lines`)
  for (const [desc, n] of sortedDescs) {
    console.log(`      ${String(n).padStart(4)}× "${desc}"`)
  }

  // ── DIRECTION-B CHECK (owner requirement before write) ───────────
  // Lines caught by the OLD pattern but NOT by the new one are now
  // NOT routed to not_inventory. Confirm they're all real products
  // (false positives the fix correctly drops), not legitimate
  // deposit lines we accidentally lost.
  const oldRebateIds = new Set(lines.filter(l => l.raw_description && REBATE_PATTERN_OLD.test(l.raw_description)).map(l => l.id))
  const newRebateIds = new Set(rebateLines.map(l => l.id))
  const droppedByFix = lines.filter(l => oldRebateIds.has(l.id) && !newRebateIds.has(l.id))
  console.log(`\n    DIRECTION B — distinct descriptions DROPPED by the ^pant\\b anchor:`)
  console.log(`      ${droppedByFix.length} lines no longer caught (expected: all "Varav pant" product annotations)`)
  if (droppedByFix.length === 0) {
    console.log(`      (none — none of the OLD-pattern catches relied on the loose \\bpant\\b rule)`)
  } else {
    const droppedCounts = new Map()
    for (const l of droppedByFix) {
      const k = (l.raw_description ?? '').trim()
      droppedCounts.set(k, (droppedCounts.get(k) ?? 0) + 1)
    }
    const sortedDropped = [...droppedCounts.entries()].sort((a, b) => b[1] - a[1])
    for (const [desc, n] of sortedDropped) {
      // Heuristic verdict per line — visible flag if a description "looks like" a real product
      const looksLikeProduct = /,\s*Varav pant|\s+Varav pant/i.test(desc)
      const verdict = looksLikeProduct ? '✓ correctly dropped (product with deposit annotation)' : '⚠️ EYEBALL — does this look like a legitimate deposit line?'
      console.log(`      ${String(n).padStart(4)}× "${desc}"`)
      console.log(`           → ${verdict}`)
    }
  }

  // ── INTERSECTION — lines in both Op 1 and Op 2 ───────────────────────
  const backfillIds = new Set(accountBackfillTuples.map(t => t.line_id))
  const rebateIds   = new Set(rebateLines.map(l => l.id))
  const both = [...rebateIds].filter(id => backfillIds.has(id))
  console.log(`\n  INTERSECTION — lines hit by BOTH operations: ${both.length}`)
  console.log(`    For these, Operation 1 still sets account_number, AND Operation 2 sets`)
  console.log(`    match_status='not_inventory'. The two writes compose cleanly.`)

  // ── Summary ──────────────────────────────────────────────────────────
  const opOnlyA = accountBackfillTuples.length - both.length
  const opOnlyB = rebateLines.length - both.length
  const untouched = lines.length - opOnlyA - opOnlyB - both.length

  console.log(`\n  WRITE SUMMARY (per business):`)
  console.log(`    Lines untouched:                          ${untouched}  (${(100*untouched/lines.length).toFixed(1)}%)`)
  console.log(`    Lines affected by account back-fill only: ${opOnlyA}`)
  console.log(`    Lines affected by rebate guard only:      ${opOnlyB}`)
  console.log(`    Lines affected by BOTH:                   ${both.length}`)
  console.log(`    Total lines that would change:            ${opOnlyA + opOnlyB + both.length}  (${(100*(opOnlyA+opOnlyB+both.length)/lines.length).toFixed(1)}%)`)

  summary.push({
    biz: biz.name,
    total_lines: lines.length,
    op1_lines: accountBackfillTuples.length,
    op2_lines: rebateLines.length,
    op2_already_matched_with_alias: alreadyMatchedWithAlias,
    both: both.length,
    distinct_rebate_descs: sortedDescs.length,
    untouched,
  })
}

section('CROSS-BUSINESS SUMMARY')
console.log(`
  Metric                                              Chicce      Vero
  ────────────────────────────────────────────────────────────────────`)
const col = (k) => {
  const c = summary.find(s => s.biz === 'Chicce Slotsgatan')?.[k] ?? '—'
  const v = summary.find(s => s.biz === 'Vero Italiano')?.[k]    ?? '—'
  return `${String(c).padStart(10)}  ${String(v).padStart(10)}`
}
console.log(`  Total supplier_invoice_lines                       ${col('total_lines')}`)
console.log(`  Op1: account back-fill lines                       ${col('op1_lines')}`)
console.log(`  Op2: rebate guard lines                            ${col('op2_lines')}`)
console.log(`    of which already 'matched' with alias            ${col('op2_already_matched_with_alias')}`)
console.log(`  Intersection (both ops)                            ${col('both')}`)
console.log(`  Distinct rebate descriptions                       ${col('distinct_rebate_descs')}`)
console.log(`  Lines untouched                                    ${col('untouched')}`)

section('OPEN QUESTION FOR OWNER BEFORE THE WRITE')
console.log(`
  Operation 2 (rebate guard) is intrusive on lines whose match_status is
  currently 'matched' WITH a product_alias_id — clearing the alias link
  removes the line's contribution from that alias's usage count and
  could trigger demotion of confidently-wrong auto-matches (which is
  arguably the correct effect, since the alias was wrong: a real
  product alias was matching a rebate).

  Per business (counts in the table above):
  ${summary.find(s => s.biz === 'Chicce Slotsgatan')?.op2_already_matched_with_alias ?? 0}  Chicce 'matched' rebate lines with non-null product_alias_id
  ${summary.find(s => s.biz === 'Vero Italiano')?.op2_already_matched_with_alias ?? 0}  Vero   'matched' rebate lines with non-null product_alias_id

  Recommend going through with the clear — the rebate-guard's whole
  point is to undo confidently-wrong matches like the D2 Chiarlo /
  Jameson cluster. But it's the kind of intrusive write that benefits
  from explicit owner sign-off, not implicit "of course".

  Two design follow-throughs if approved:
    (a) Lines flipped to 'not_inventory' lose their product_alias_id —
        D1's demotion code path increments corrections_against on the
        formerly-attached alias for free (via the same /correct-
        attribution endpoint we'd reuse).
    (b) The audit_sample outcomes table gets a new row per affected
        alias with owner_action='skip_non_inventory', agreed=false,
        context='rebate_guard_backfill' — keeps the learning loop fed
        with the correction signal.
`)

console.log('\nDone. Read-only — no rows changed, no writes. Awaiting owner go/no-go before Step 1 SQL.\n')
