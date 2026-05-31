#!/usr/bin/env node
// scripts/diag-p20-paydown-step0.mjs
//
// P2.0 reliability paydown Step 0 — characterise (READ-ONLY).
// Per p20-reliability-paydown-prompt.md.
//
// Two tickets, one script:
//   Ticket 1 — Extract voucher_series + voucher_number into top-level
//              columns on fortnox_supplier_invoices. Columns ALREADY
//              exist (M098); they're 100% NULL because the sync cron
//              writes raw_data.Vouchers JSONB and never populates the
//              top-level cols. Count: rows where backfill would set
//              vs rows already populated vs rows with no Vouchers in
//              JSONB (genuinely unrecoverable).
//
//   Ticket 2 — Re-warm fortnox_vouchers_cache for older periods to
//              raise the back-fill join match rate (was 71% Chicce /
//              78% Vero). Per business: what period range does the
//              cache cover, and of supplier_invoice_lines currently
//              FAILING the voucher join, what % could re-warm rescue
//              vs are genuinely unmatched.
//
// No writes anywhere.

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

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

// ──────────────────────────────────────────────────────────────────────
// TICKET 1 — JSONB → columns characterisation
// ──────────────────────────────────────────────────────────────────────

console.log(`${'═'.repeat(78)}\n  TICKET 1 — Extract voucher_series + voucher_number from JSONB\n${'═'.repeat(78)}`)

// 1a. Count rows per business: total, with col populated, with col null
//     but JSONB has it (backfillable), with NO Vouchers in JSONB (unrecoverable).
console.log(`\n  1a. Per-business column population status`)
for (const [name, bid] of [['Chicce', CHICCE], ['Vero', VERO]]) {
  console.log(`\n    ── ${name} ──`)
  const all = await qPaged(`fortnox_supplier_invoices?select=id,voucher_series,voucher_number,raw_data&business_id=eq.${bid}`)
  let total = all.length, popCol = 0, jsonbHas = 0, neither = 0, jsonbButColNull = 0
  let sampleJsonbHas = null
  for (const row of all) {
    if (row.voucher_series != null) popCol += 1
    const vouchers = row.raw_data?.Vouchers
    const hasJsonb = Array.isArray(vouchers) && vouchers.length > 0
    if (hasJsonb) jsonbHas += 1
    if (hasJsonb && row.voucher_series == null) {
      jsonbButColNull += 1
      if (!sampleJsonbHas) sampleJsonbHas = { id: row.id, vouchers: vouchers.slice(0, 2) }
    }
    if (!hasJsonb && row.voucher_series == null) neither += 1
  }
  console.log(`      Total rows:                                 ${total}`)
  console.log(`      Column already populated:                   ${popCol}  (${(100*popCol/Math.max(1,total)).toFixed(1)}%)`)
  console.log(`      JSONB has Vouchers ANY:                     ${jsonbHas}  (${(100*jsonbHas/Math.max(1,total)).toFixed(1)}%)`)
  console.log(`      → JSONB has it but COLUMN is NULL           ${jsonbButColNull}  ← backfillable by Ticket 1`)
  console.log(`      JSONB has none AND column null:             ${neither}  ← genuinely unrecoverable`)
  if (sampleJsonbHas) {
    console.log(`      Sample JSONB Vouchers structure (first 2):`)
    console.log(`        ${JSON.stringify(sampleJsonbHas.vouchers, null, 2).split('\n').join('\n        ')}`)
  }
}

// 1b. Live JSONB-parsing sites? scan for ->'Vouchers' usage in src
//     (this script can't grep src; remind the reader where it's used).
console.log(`\n  1b. Known JSONB-parsing sites (consumers to repoint after column backfill)`)
console.log(`      - sql/p20-voucher-rebate-backfill-DRY.sql (one-time SQL; already ran)`)
console.log(`      - sql/p20-voucher-rebate-backfill-APPLY.sql (one-time SQL; already ran)`)
console.log(`      No live read path parses raw_data.Vouchers — Ticket 1 is pure plumbing`)
console.log(`      for future P2.0-style operations. No Phase D effect.`)

// ──────────────────────────────────────────────────────────────────────
// TICKET 2 — Cache coverage characterisation
// ──────────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(78)}\n  TICKET 2 — Re-warm fortnox_vouchers_cache for older periods\n${'═'.repeat(78)}`)

// 2a. Per business: what period range does the cache cover?
console.log(`\n  2a. Per-business cache coverage range`)
for (const [name, bid] of [['Chicce', CHICCE], ['Vero', VERO]]) {
  const rows = await qPaged(`fortnox_vouchers_cache?select=period_year,voucher_series&business_id=eq.${bid}`)
  if (rows.length === 0) {
    console.log(`\n    ── ${name}: 0 cached vouchers`)
    continue
  }
  const byYear = new Map()
  const seriesSet = new Set()
  for (const r of rows) {
    byYear.set(r.period_year, (byYear.get(r.period_year) ?? 0) + 1)
    if (r.voucher_series) seriesSet.add(r.voucher_series)
  }
  const years = [...byYear.keys()].sort()
  console.log(`\n    ── ${name} ──`)
  console.log(`      Total cached voucher headers: ${rows.length}`)
  console.log(`      Years covered:                ${years.join(', ')}`)
  console.log(`      Voucher series in cache:      ${[...seriesSet].sort().join(', ')}`)
  console.log(`      By year:`)
  for (const y of years) console.log(`        ${y}: ${byYear.get(y)} voucher headers`)
}

// 2b. Quantify the join-failure breakdown using fresh in-memory join
//     (mirrors p20 SQL but JSON->JS):
//      For each supplier_invoice_lines row that's needs_review/not_inventory
//      with account_number NULL (i.e. P2.0 didn't backfill it),
//      check whether the parent invoice has Vouchers and whether the cache
//      has that voucher.
console.log(`\n  2b. Supplier_invoice_lines without account_number — recoverable-by-rewarm vs genuinely-unmatched`)

for (const [name, bid] of [['Chicce', CHICCE], ['Vero', VERO]]) {
  console.log(`\n    ── ${name} ──`)

  // Pull all supplier_invoice_lines with account_number NULL
  const linesNullAcct = await qPaged(
    `supplier_invoice_lines?select=id,fortnox_invoice_number,match_status` +
    `&business_id=eq.${bid}&account_number=is.null`
  )
  console.log(`      Lines with NULL account_number: ${linesNullAcct.length}`)
  if (linesNullAcct.length === 0) {
    console.log(`      No work to characterise.`)
    continue
  }

  // Pull all supplier_invoices for this business (with their Vouchers JSONB)
  const invoices = await qPaged(
    `fortnox_supplier_invoices?select=given_number,raw_data&business_id=eq.${bid}`
  )
  const invoiceMap = new Map()
  for (const inv of invoices) {
    invoiceMap.set(String(inv.given_number ?? '').trim(), inv)
  }

  // Pull all cached voucher headers as a Set
  const cachedVouchers = await qPaged(
    `fortnox_vouchers_cache?select=voucher_series,voucher_number,period_year&business_id=eq.${bid}`
  )
  const cacheKeys = new Set(cachedVouchers.map(v => `${v.voucher_series}||${v.voucher_number}`))

  // Group lines by parent invoice
  const linesByInvoice = new Map()
  for (const l of linesNullAcct) {
    const k = String(l.fortnox_invoice_number ?? '').trim()
    const g = linesByInvoice.get(k) ?? []
    g.push(l)
    linesByInvoice.set(k, g)
  }
  console.log(`      Distinct parent invoices: ${linesByInvoice.size}`)

  let invoicesNoJsonb = 0, invoicesJsonbButCacheMiss = 0, invoicesCacheHit = 0
  const cacheMissByYear = new Map()
  let linesInCacheMiss = 0, linesCacheHit = 0, linesNoJsonb = 0
  for (const [givenNumber, lines] of linesByInvoice.entries()) {
    const inv = invoiceMap.get(givenNumber)
    if (!inv) {
      // Parent invoice not in cache (rare — orphan line)
      invoicesNoJsonb += 1
      linesNoJsonb += lines.length
      continue
    }
    const vouchers = inv.raw_data?.Vouchers
    if (!Array.isArray(vouchers) || vouchers.length === 0) {
      invoicesNoJsonb += 1
      linesNoJsonb += lines.length
      continue
    }
    // Filter to SUPPLIERINVOICE refs only
    const refs = vouchers.filter(v => v?.ReferenceType === 'SUPPLIERINVOICE')
    if (refs.length === 0) {
      invoicesNoJsonb += 1
      linesNoJsonb += lines.length
      continue
    }
    // Check if ANY ref is in the cache
    let anyHit = false
    for (const v of refs) {
      const k = `${v.Series}||${v.Number}`
      if (cacheKeys.has(k)) { anyHit = true; break }
    }
    if (anyHit) {
      invoicesCacheHit += 1
      linesCacheHit += lines.length
    } else {
      invoicesJsonbButCacheMiss += 1
      linesInCacheMiss += lines.length
      // Record the year of the first ref (period proxy)
      // We don't have the voucher's actual year, but the invoice's year approximates
      // — use voucher Number itself isn't time-tagged either. Skip year breakdown.
    }
  }

  console.log(`      Invoices: cache-hit (Op 1 just couldn't pin single-account):  ${invoicesCacheHit}`)
  console.log(`      Invoices: JSONB has refs but cache MISS (re-warm rescues):    ${invoicesJsonbButCacheMiss}  ← Ticket 2 target`)
  console.log(`      Invoices: no JSONB Vouchers (unrecoverable):                   ${invoicesNoJsonb}`)
  console.log(`      Lines breakdown:`)
  console.log(`        cache-hit / Op 1 just left NULL (multi-account):            ${linesCacheHit}`)
  console.log(`        cache-miss → recoverable by re-warm:                        ${linesInCacheMiss}  ← Ticket 2 lift target`)
  console.log(`        no JSONB Vouchers (genuinely unrecoverable):                ${linesNoJsonb}`)
  // What % of the supplier_invoice_lines.account_number gap is re-warm-rescuable?
  const lift = linesInCacheMiss / Math.max(1, linesNullAcct.length)
  console.log(`      Re-warm rescue ceiling: ${(100*lift).toFixed(1)}% of currently-NULL lines`)
}

console.log(`\nDone. Read-only — no writes.`)
