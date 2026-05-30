#!/usr/bin/env node
// scripts/diag-p20-voucher-backfill-step0.mjs
//
// P2.0 Step 0 — READ-ONLY characterisation of the voucher → invoice-line
// join. Per the prompt, the findings block must answer four questions
// before any back-fill SQL is even drafted:
//
//   1. Join key reliability — what fraction of supplier_invoice_lines
//      successfully map to a fortnox_vouchers_cache voucher?
//   2. Booking shape — what's the exclude list (AP, VAT, rounding, FX)?
//   3. Single-vs-multi expense-account split per business — the COVERAGE
//      CEILING (owner-flagged as the most important number).
//   4. Account → category sanity — do the distinct expense accounts
//      that appear map sensibly via existing categories.ts logic?
//
// Plus the rebate-cohort cross-check per owner refinement: if the
// Avtalsrabatt noise sits in single-account invoices, goal #1
// (kill Gate-0 noise) lands independent of goal #2 (Vero lift).
//
// NO writes. NO Fortnox API calls — pure SQL against
// fortnox_vouchers_cache (M080) + fortnox_supplier_invoices (M098)
// + supplier_invoice_lines (M075).

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

async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H })
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json()
}
async function qPaged(path, pageSize = 1000) {
  // Some queries can exceed PostgREST's 1000-row default cap.
  // Loop with .range() until we get a short page.
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
    if (from > 100_000) break  // safety
  }
  return out
}

const section = (t) => console.log(`\n${'═'.repeat(78)}\n  ${t}\n${'═'.repeat(78)}`)

// ── Carry-forward from the current-state investigation: Gate 0 reads
//    account_number when present. Step 2 (consumer activation) is just
//    flipping the switch, not building a new code path.
section('Carry-forward — Gate 0 consumer is ALREADY WIRED')
console.log(`
  lib/inventory/matcher.ts:74-109 — Gate 0 evaluates in this order:
    (a) supplier_classifications override (M083, per-business)
    (b) categoryForBasAccount(line.account_number) — reads it directly
    (c) categoryForSupplier(supplier_name_snapshot) — current fallback
        (heavily used today because account_number is ~100% NULL)

  lib/inventory/categories.ts — categoryForBasAccount returns:
    - 4xxx range → 'food' (default-include rule)
    - Specific overrides for 4010 (food), 4011 (alcohol), 4017
      (takeaway_material), 5410/5460 (disposables/cleaning) etc.
    - Anything outside 4xxx + the allowlist → null (= 'not_inventory')

  → P2.0's Step 2 is activation, not build. Once account_number is
    populated, the (c) supplier-name fallback gets skipped for those
    lines and Gate 0 routes via BAS directly. Rebate lines (4990 etc)
    AND service/fee lines (6xxx) AND VAT/AP rows (2xxx) — if they
    showed up — would route to not_inventory automatically.
`)

// Holders for the cross-business summary
const summary = []

for (const biz of BUSINESSES) {
  section(`Business: ${biz.name} (${biz.id})`)

  // ── 0. Pull the universe of lines + their parent invoices ─────────
  console.log('\n  Pulling all supplier_invoice_lines + their bridge rows...')
  const lines = await qPaged(
    `supplier_invoice_lines?select=id,fortnox_invoice_number,match_status,account_number,raw_description,total_excl_vat` +
    `&business_id=eq.${biz.id}`
  )
  console.log(`    supplier_invoice_lines: ${lines.length}`)

  if (lines.length === 0) {
    console.log('    (no lines — skipping)')
    summary.push({ biz: biz.name, skipped: true })
    continue
  }

  // Group lines by invoice number
  const linesByInvoice = new Map()
  for (const l of lines) {
    const arr = linesByInvoice.get(l.fortnox_invoice_number) ?? []
    arr.push(l)
    linesByInvoice.set(l.fortnox_invoice_number, arr)
  }
  const distinctInvoices = [...linesByInvoice.keys()]
  console.log(`    distinct fortnox_invoice_number values: ${distinctInvoices.length}`)

  // ── 1. Resolve invoice → voucher via raw_data.Vouchers JSONB ─────
  //
  // The dedicated voucher_series + voucher_number columns on
  // fortnox_supplier_invoices are 100% NULL (the supplier-sync cron
  // doesn't extract them from the API response). But raw_data carries
  // the full payload, including a `Vouchers` array of refs like:
  //   [{"Year":7,"Number":606,"Series":"D","ReferenceType":"SUPPLIERINVOICE"}, ...]
  //
  // A single supplier invoice CAN have multiple vouchers (booking +
  // payment + correction). For categorisation we only want the one
  // with ReferenceType='SUPPLIERINVOICE' — the original booking.
  //
  // This is workable today. A follow-up fix to the sync cron should
  // extract these into the dedicated columns so future code doesn't
  // have to parse JSONB.
  const invToVoucher = new Map()  // given_number → { series, number, year, invoice_date }
  let missingRawData = 0
  let multiBookings  = 0
  for (let i = 0; i < distinctInvoices.length; i += 200) {
    const slice = distinctInvoices.slice(i, i + 200).map(n => `"${n}"`).join(',')
    const rows = await q(
      `fortnox_supplier_invoices?select=given_number,invoice_date,raw_data` +
      `&business_id=eq.${biz.id}&given_number=in.(${slice})`
    )
    for (const r of rows) {
      const arr = Array.isArray(r.raw_data?.Vouchers) ? r.raw_data.Vouchers : null
      if (!arr) { missingRawData++; continue }
      const bookings = arr.filter(v => v?.ReferenceType === 'SUPPLIERINVOICE')
      if (bookings.length === 0) continue
      if (bookings.length > 1) multiBookings++
      const b = bookings[0]  // earliest in array; in practice rarely >1
      invToVoucher.set(r.given_number, {
        series: b.Series,
        number: b.Number,
        year:   b.Year,
        date:   r.invoice_date,
      })
    }
  }
  console.log(`    invoices resolved via raw_data.Vouchers (ReferenceType=SUPPLIERINVOICE):  ${invToVoucher.size}  (${(100*invToVoucher.size/distinctInvoices.length).toFixed(1)}%)`)
  console.log(`      M098 cache miss or raw_data missing: ${distinctInvoices.length - invToVoucher.size - missingRawData} not in cache + ${missingRawData} missing raw_data`)
  console.log(`      invoices with MULTIPLE SUPPLIERINVOICE bookings: ${multiBookings} (typically correction/credit note)`)

  // ── 2. Look up the actual voucher rows in fortnox_vouchers_cache ─
  // Pull every unique (series, number) batch
  const voucherKeys = [...new Set([...invToVoucher.values()]
    .filter(v => v.series && v.number != null)
    .map(v => `${v.series}|${v.number}`))]
  console.log(`    distinct (voucher_series, voucher_number) to fetch: ${voucherKeys.length}`)

  // Pulling all vouchers for this business (much fewer than invoices typically)
  const vouchersAll = await qPaged(
    `fortnox_vouchers_cache?select=voucher_series,voucher_number,transaction_date,rows,debit_total,credit_total` +
    `&business_id=eq.${biz.id}`
  )
  console.log(`    fortnox_vouchers_cache rows (all-time):  ${vouchersAll.length}`)
  const voucherIdx = new Map()
  for (const v of vouchersAll) {
    voucherIdx.set(`${v.voucher_series}|${v.voucher_number}`, v)
  }

  // Match (series, number) referenced by an invoice to a cache row
  const invoicesWithVoucher = []  // { given_number, voucher_rows }
  const invoicesNoCache = []
  const invoicesCachedNoVoucher = []
  for (const [givenNumber, ref] of invToVoucher.entries()) {
    if (!ref.series || ref.number == null) {
      invoicesCachedNoVoucher.push(givenNumber)
      continue
    }
    const v = voucherIdx.get(`${ref.series}|${ref.number}`)
    if (!v) {
      invoicesNoCache.push(givenNumber)
      continue
    }
    invoicesWithVoucher.push({ givenNumber, rows: v.rows ?? [], ref })
  }
  console.log(`    → voucher resolved for ${invoicesWithVoucher.length} invoices  (${(100*invoicesWithVoucher.length/distinctInvoices.length).toFixed(1)}% of all distinct invoices)`)
  console.log(`      M098 cache miss: ${distinctInvoices.length - invToVoucher.size} invoices`)
  console.log(`      M098 row but no voucher ref: ${invoicesCachedNoVoucher.length}`)
  console.log(`      M098 voucher ref but voucher cache miss: ${invoicesNoCache.length}`)

  // ── 3. Booking-shape characterisation: derive exclude list + expense accounts
  // Use the canonical Swedish BAS booking pattern:
  //   - 2440 Leverantörsskulder       (AP credit — credit side of the booking)
  //   - 2641/2642/2643/2645/2646/2647/2648/2649 Input VAT
  //   - 3740 Öres- och kronutjämning (rounding)
  //   - 7960/7980 FX-diff             (rare but possible)
  // Plus generally exclude:
  //   - 1xxx-2xxx (assets, liabilities, equity, VAT)
  //   - 8xxx (financial — interest/tax; unusual on a normal supplier invoice)
  //   - 9xxx (closing entries)

  const EXCLUDE_ACCOUNTS = new Set([
    2440, 2641, 2642, 2643, 2644, 2645, 2646, 2647, 2648, 2649,
    3740, 7960, 7980,
  ])
  function isExpenseAccount(acct) {
    if (acct == null || !Number.isFinite(acct)) return false
    if (EXCLUDE_ACCOUNTS.has(acct)) return false
    if (acct >= 1000 && acct < 3000) return false  // assets, liabilities
    if (acct >= 8000)                return false  // financial / tax / closing
    // 3xxx revenue — should not appear on a SUPPLIER invoice booking
    // (revenue from sale of inventory back to a supplier is a credit
    // note, separate path) — leave them out of the expense signal.
    if (acct >= 3000 && acct < 4000) return false
    return true
  }

  // ── 4. Per-invoice single-vs-multi expense-account split ─────────
  let singleAccount  = 0
  let multiAccount   = 0
  let zeroAccount    = 0
  const accountTallies = new Map()         // expense account → invoice count
  const singleAccountInvoices = new Set()  // given_numbers
  for (const inv of invoicesWithVoucher) {
    // Filter voucher rows to expense debit lines (Debit > 0 + account passes the filter)
    const exp = []
    for (const row of (inv.rows ?? [])) {
      const acct = Number(row.Account)
      const debit = Number(row.Debit ?? 0)
      if (debit > 0 && isExpenseAccount(acct)) exp.push({ acct, debit })
    }
    const distinct = new Set(exp.map(e => e.acct))
    if (distinct.size === 0)      zeroAccount++
    else if (distinct.size === 1) {
      singleAccount++
      singleAccountInvoices.add(inv.givenNumber)
      const a = [...distinct][0]
      accountTallies.set(a, (accountTallies.get(a) ?? 0) + 1)
    }
    else multiAccount++
  }
  const linesInSingleAccountInvoices = lines.filter(l => singleAccountInvoices.has(l.fortnox_invoice_number)).length

  console.log(`\n  Single-vs-multi expense-account split (THE COVERAGE CEILING):`)
  console.log(`    single-account invoices: ${singleAccount}  (${(100*singleAccount/invoicesWithVoucher.length).toFixed(1)}% of voucher-matched)`)
  console.log(`    multi-account invoices:  ${multiAccount}  (${(100*multiAccount/invoicesWithVoucher.length).toFixed(1)}%)`)
  console.log(`    zero-expense-account:    ${zeroAccount}  (${(100*zeroAccount/Math.max(1,invoicesWithVoucher.length)).toFixed(1)}%)`)
  console.log(`    → lines that would be backfilled: ${linesInSingleAccountInvoices}  (${(100*linesInSingleAccountInvoices/lines.length).toFixed(1)}% of all lines)`)

  // ── 5. Rebate cohort cross-check (owner refinement) ──────────────
  const REBATE = /(avtalsrabatt|^rabatt|\bpant\b|pantersättning|öresavrundning|faktureringsavg|inkassoarvode|påminnelseavg)/i
  const rebateLines = lines.filter(l => l.raw_description && REBATE.test(l.raw_description))
  const rebateLinesInSingleAcct = rebateLines.filter(l => singleAccountInvoices.has(l.fortnox_invoice_number))
  console.log(`\n  Rebate / Avtalsrabatt cohort cross-check (goal #1 — kill Gate-0 noise):`)
  console.log(`    rebate-pattern lines (all):                ${rebateLines.length}`)
  console.log(`    rebate lines in SINGLE-account invoices:   ${rebateLinesInSingleAcct.length}  (${rebateLines.length > 0 ? (100*rebateLinesInSingleAcct.length/rebateLines.length).toFixed(1) : '0.0'}% of rebate lines)`)
  // Show what account these rebates actually post to
  if (rebateLinesInSingleAcct.length > 0) {
    const rebateInvSet = new Set(rebateLinesInSingleAcct.map(l => l.fortnox_invoice_number))
    const rebateAccountTallies = new Map()
    for (const inv of invoicesWithVoucher) {
      if (!rebateInvSet.has(inv.givenNumber)) continue
      const exp = (inv.rows ?? []).filter(r => Number(r.Debit ?? 0) > 0 && isExpenseAccount(Number(r.Account)))
      const distinct = new Set(exp.map(e => Number(e.Account)))
      if (distinct.size === 1) {
        const a = [...distinct][0]
        rebateAccountTallies.set(a, (rebateAccountTallies.get(a) ?? 0) + 1)
      }
    }
    const sortedReb = [...rebateAccountTallies.entries()].sort((a,b)=>b[1]-a[1])
    console.log(`    expense accounts used by rebate single-account invoices:`)
    for (const [acct, n] of sortedReb.slice(0, 10)) {
      console.log(`      ${String(acct).padEnd(6)} appears in ${n} rebate invoice(s)`)
    }
  }

  // ── 6. Account → category sanity (which accounts will actually appear) ──
  console.log(`\n  Distinct expense accounts seen in single-account invoices (sanity check vs categories.ts):`)
  const sortedAccts = [...accountTallies.entries()].sort((a,b)=>b[1]-a[1])
  console.log(`    Top 25 (account / invoice count / lines covered):`)
  for (const [acct, n] of sortedAccts.slice(0, 25)) {
    // Quick local mirror of categoryForBasAccount logic (lib/inventory/categories.ts)
    const cat = categoryForBasLocal(acct)
    const linesUnder = lines.filter(l => {
      const inv = invToVoucher.get(l.fortnox_invoice_number)
      if (!inv) return false
      const v = voucherIdx.get(`${inv.series}|${inv.number}`)
      if (!v) return false
      const exp = (v.rows ?? []).filter(r => Number(r.Debit ?? 0) > 0 && isExpenseAccount(Number(r.Account)))
      const distinct = new Set(exp.map(e => Number(e.Account)))
      return distinct.size === 1 && [...distinct][0] === acct
    }).length
    console.log(`      ${String(acct).padEnd(6)} ${String(n).padStart(4)} inv  ${String(linesUnder).padStart(4)} lines  → ${cat ?? '(not_inventory)'}`)
  }

  // ── 7. needs_review subset — what fraction of the back-fill helps queue triage?
  const nrLines = lines.filter(l => l.match_status === 'needs_review')
  const nrInSingleAcct = nrLines.filter(l => singleAccountInvoices.has(l.fortnox_invoice_number))
  console.log(`\n  needs_review subset (Gate-0 re-route target for goal #2):`)
  console.log(`    needs_review lines (all):                   ${nrLines.length}`)
  console.log(`    needs_review lines in SINGLE-acct invoices: ${nrInSingleAcct.length}  (${nrLines.length > 0 ? (100*nrInSingleAcct.length/nrLines.length).toFixed(1) : '0.0'}%)`)

  summary.push({
    biz: biz.name,
    total_lines: lines.length,
    distinct_invoices: distinctInvoices.length,
    invoices_voucher_resolved: invoicesWithVoucher.length,
    voucher_match_rate_pct: 100 * invoicesWithVoucher.length / distinctInvoices.length,
    single_account_invoices: singleAccount,
    multi_account_invoices: multiAccount,
    zero_account_invoices: zeroAccount,
    single_account_coverage_pct_of_voucher_matched: invoicesWithVoucher.length === 0 ? 0 : 100 * singleAccount / invoicesWithVoucher.length,
    lines_backfilled: linesInSingleAccountInvoices,
    lines_backfilled_pct: 100 * linesInSingleAccountInvoices / lines.length,
    rebate_lines: rebateLines.length,
    rebate_in_single_acct: rebateLinesInSingleAcct.length,
    needs_review_lines: nrLines.length,
    needs_review_in_single_acct: nrInSingleAcct.length,
  })
}

// ── Cross-business summary table ─────────────────────────────────────
section('CROSS-BUSINESS SUMMARY — the numbers we decide on')
console.log(`
  Metric                                           Chicce      Vero
  ─────────────────────────────────────────────────────────────────────`)
const cols = (k, suffix = '') => {
  const c = summary.find(s => s.biz === 'Chicce Slotsgatan')?.[k] ?? '—'
  const v = summary.find(s => s.biz === 'Vero Italiano')?.[k]    ?? '—'
  const fmt = x => typeof x === 'number' ? (Number.isInteger(x) ? String(x) : x.toFixed(1)) : String(x)
  return `${fmt(c).padStart(10)}${suffix.padEnd(2)}  ${fmt(v).padStart(10)}${suffix.padEnd(2)}`
}
console.log(`  Total supplier_invoice_lines                    ${cols('total_lines')}`)
console.log(`  Distinct fortnox_invoice_number values          ${cols('distinct_invoices')}`)
console.log(`  Invoices with voucher resolved                  ${cols('invoices_voucher_resolved')}`)
console.log(`  Voucher match rate (of distinct invoices)       ${cols('voucher_match_rate_pct', '%')}`)
console.log(`  ─────────────────────────────────────────────────────────────`)
console.log(`  Single-expense-account invoices                 ${cols('single_account_invoices')}`)
console.log(`  Multi-expense-account invoices                  ${cols('multi_account_invoices')}`)
console.log(`  Zero-expense-account invoices                   ${cols('zero_account_invoices')}`)
console.log(`  Single-account coverage (of voucher-matched)    ${cols('single_account_coverage_pct_of_voucher_matched', '%')}`)
console.log(`  Lines back-filled (of all lines)                ${cols('lines_backfilled_pct', '%')}`)
console.log(`  ─────────────────────────────────────────────────────────────`)
console.log(`  Rebate/Avtalsrabatt lines (all)                 ${cols('rebate_lines')}`)
console.log(`  Rebate lines in single-acct invoices            ${cols('rebate_in_single_acct')}`)
console.log(`  ─────────────────────────────────────────────────────────────`)
console.log(`  needs_review lines (all)                        ${cols('needs_review_lines')}`)
console.log(`  needs_review lines in single-acct invoices      ${cols('needs_review_in_single_acct')}`)

console.log('\nDone. Read-only — no rows changed, no Fortnox calls, no writes.\n')

// ─────────────────────────────────────────────────────────────────────
// Local mirror of categoryForBasAccount (lib/inventory/categories.ts)
// so we can label accounts in the sanity check without importing TS.
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
  if (acct >= 4000 && acct < 5000) return 'food (default-include 4xxx rule)'
  return null  // = 'not_inventory' for Gate 0 purposes
}
