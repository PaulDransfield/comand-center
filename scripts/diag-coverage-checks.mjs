#!/usr/bin/env node
// READ-ONLY coverage check — two questions:
//
// 1) Chicce 23.6% BAS coverage: where IS the gap? Recipe-relevant
//    (food/inventory) or overhead (rent/services)? If food-relevant,
//    the recipe-cost foundation is shakier than we thought.
//
// 2) M&S no_pdf 452: characterise (dates, document types, suppliers)
//    + flag a sample of 20 representative invoices spanning the
//    date range for Fortnox-UI verification (we can't actually pull
//    Fortnox to confirm PDFs exist; we surface the sample and let
//    owner check).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
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
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }
async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: h })
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

console.log('═══════════════════════════════════════════════════════════════')
console.log(' CHECK 1 — Chicce BAS coverage gap: food vs overhead?')
console.log('═══════════════════════════════════════════════════════════════\n')

// Pull all Chicce lines with everything we need
const chicceLines = []
for (let from = 0; ; from += 1000) {
  const batch = await q(`supplier_invoice_lines?business_id=eq.${CHICCE}&select=raw_description,account_number,account_source,total_excl_vat,match_status,product_alias_id,supplier_name_snapshot,source&offset=${from}&limit=1000`)
  chicceLines.push(...batch)
  if (batch.length < 1000) break
  if (chicceLines.length > 50000) break
}
console.log(`Chicce SIL total: ${chicceLines.length}`)

const withBAS = chicceLines.filter(l => l.account_number != null)
const noBAS   = chicceLines.filter(l => l.account_number == null)
console.log(`  with BAS: ${withBAS.length} (${(100*withBAS.length/chicceLines.length).toFixed(1)}%)`)
console.log(`  no BAS:   ${noBAS.length} (${(100*noBAS.length/chicceLines.length).toFixed(1)}%)`)

// 1a — What's the BAS distribution on the lines that HAVE BAS?
const basRange = (acct) => {
  const n = parseInt(acct, 10)
  if (n >= 4000 && n <= 4999) return '40xx food/COGS'
  if (n >= 5000 && n <= 5999) return '50xx premises/utilities'
  if (n >= 6000 && n <= 6999) return '60xx admin/services'
  if (n >= 7000 && n <= 7999) return '70xx wages/depreciation'
  if (n >= 8000 && n <= 8999) return '80xx financial'
  return 'other'
}
const basByRange = {}
const spendByRange = {}
for (const l of withBAS) {
  const r = basRange(l.account_number)
  basByRange[r]   = (basByRange[r]   ?? 0) + 1
  spendByRange[r] = Math.round((spendByRange[r] ?? 0) + Math.abs(Number(l.total_excl_vat ?? 0)))
}
console.log(`\nChicce — lines WITH BAS account, by BAS range:`)
for (const [r, n] of Object.entries(basByRange).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${r.padEnd(28)} ${n.toString().padStart(4)} lines  ${(spendByRange[r]||0).toLocaleString().padStart(12)} SEK`)
}

// 1b — Of lines WITHOUT BAS, how many are product-matched?
// Product-matched = product_alias_id is not null = recipe-relevant
const noBASMatched   = noBAS.filter(l => l.product_alias_id != null)
const noBASUnmatched = noBAS.filter(l => l.product_alias_id == null)
console.log(`\nChicce — lines WITHOUT BAS (the ~76% gap):`)
console.log(`  ${noBAS.length} total, ${Math.round(noBAS.reduce((s,l)=>s+Math.abs(Number(l.total_excl_vat??0)),0)).toLocaleString()} SEK`)
console.log(`  matched to product (recipe-relevant): ${noBASMatched.length}  ${Math.round(noBASMatched.reduce((s,l)=>s+Math.abs(Number(l.total_excl_vat??0)),0)).toLocaleString()} SEK`)
console.log(`  unmatched:                            ${noBASUnmatched.length}  ${Math.round(noBASUnmatched.reduce((s,l)=>s+Math.abs(Number(l.total_excl_vat??0)),0)).toLocaleString()} SEK`)

// 1c — Of unmatched lines without BAS, what's the match_status distribution?
const statusDistNoBAS = {}
for (const l of noBASUnmatched) {
  statusDistNoBAS[l.match_status ?? 'null'] = (statusDistNoBAS[l.match_status ?? 'null'] ?? 0) + 1
}
console.log(`\n  Of the ${noBASUnmatched.length} unmatched no-BAS lines, match_status:`)
for (const [s, n] of Object.entries(statusDistNoBAS).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${s.padEnd(25)} ${n}`)
}

// 1d — Chicce vs Vero structural difference
// Pull Vero distribution of account_source too
console.log(`\n\nChicce vs Vero — account_source structural comparison:`)
for (const [biz, bizId] of [['Chicce', CHICCE], ['Vero', VERO]]) {
  const counts = await q(`supplier_invoice_lines?business_id=eq.${bizId}&select=account_source&limit=1`)
    .then(async () => {
      const arr = []
      for (let from = 0; ; from += 1000) {
        const b = await q(`supplier_invoice_lines?business_id=eq.${bizId}&select=account_source,source&offset=${from}&limit=1000`)
        arr.push(...b)
        if (b.length < 1000) break
        if (arr.length > 50000) break
      }
      return arr
    })
  const bySrc = {}, bySource = {}
  for (const l of counts) {
    bySrc[l.account_source ?? 'null'] = (bySrc[l.account_source ?? 'null'] ?? 0) + 1
    bySource[l.source ?? 'null']       = (bySource[l.source ?? 'null']     ?? 0) + 1
  }
  console.log(`  ${biz}: account_source=${JSON.stringify(bySrc)}  source=${JSON.stringify(bySource)}`)
}

console.log('\n\n═══════════════════════════════════════════════════════════════')
console.log(' CHECK 2 — M&S no_pdf 452: characterise + sample')
console.log('═══════════════════════════════════════════════════════════════\n')

// Pull all Vero no_pdf invoices
const noPdf = []
for (let from = 0; ; from += 1000) {
  const batch = await q(`invoice_pdf_extractions?business_id=eq.${VERO}&status=eq.no_pdf&select=fortnox_invoice_number,invoice_date,supplier_name_snapshot,supplier_fortnox_number,total_header,error_message,attempts,created_at&offset=${from}&limit=1000`)
  noPdf.push(...batch)
  if (batch.length < 1000) break
  if (noPdf.length > 5000) break
}
console.log(`Vero no_pdf total: ${noPdf.length}`)

// 2a — date distribution
const byYear = {}
for (const r of noPdf) {
  const y = r.invoice_date ? r.invoice_date.slice(0, 4) : 'unknown'
  byYear[y] = (byYear[y] ?? 0) + 1
}
console.log(`\nBy invoice_date year:`)
for (const [y, n] of Object.entries(byYear).sort()) console.log(`  ${y}: ${n}`)

// 2b — supplier distribution (is this all M&S?)
const bySupplier = {}
for (const r of noPdf) {
  const s = r.supplier_name_snapshot ?? '(unknown)'
  bySupplier[s] = (bySupplier[s] ?? 0) + 1
}
console.log(`\nBy supplier (top 10):`)
for (const [s, n] of Object.entries(bySupplier).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${n.toString().padStart(4)}  ${s}`)
}

// 2c — total_header distribution: how many are 0 vs have a real header?
const nonZeroHeader = noPdf.filter(r => Number(r.total_header ?? 0) !== 0)
const zeroHeader    = noPdf.filter(r => Number(r.total_header ?? 0) === 0)
console.log(`\nHeader-total distribution:`)
console.log(`  zero/null header:   ${zeroHeader.length}  (likely manual journals / credits / no Fortnox header)`)
console.log(`  non-zero header:    ${nonZeroHeader.length}  (would be recoverable if PDF exists)`)

// 2d — error_message distribution — what kind of "no_pdf" status did we record?
const byError = {}
for (const r of noPdf) {
  const k = r.error_message ?? '(null)'
  byError[k] = (byError[k] ?? 0) + 1
}
console.log(`\nBy error_message:`)
for (const [e, n] of Object.entries(byError).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${n.toString().padStart(4)}  "${e.slice(0, 80)}"`)
}

// 2e — Sample 15-20 across the date range for owner Fortnox-UI check
const sorted = noPdf.slice().sort((a, b) => (a.invoice_date ?? '').localeCompare(b.invoice_date ?? ''))
const sampleN = 20
const step = Math.max(1, Math.floor(sorted.length / sampleN))
const sample = []
for (let i = 0; i < sorted.length && sample.length < sampleN; i += step) sample.push(sorted[i])
console.log(`\nSample of ${sample.length} no_pdf invoices spanning the date range (for owner Fortnox-UI check):`)
for (const r of sample) {
  console.log(`  inv ${(r.fortnox_invoice_number ?? '').padEnd(7)}  ${r.invoice_date ?? '?'}  hdr=${(r.total_header ?? 0).toString().padStart(8)} SEK  ${(r.supplier_name_snapshot ?? '?').slice(0, 35).padEnd(35)} attempts=${r.attempts ?? 0}`)
}

if (!existsSync('tmp')) mkdirSync('tmp')
const outFile = `tmp/coverage-checks-${Date.now()}.json`
writeFileSync(outFile, JSON.stringify({
  generated_at: new Date().toISOString(),
  chicce: {
    total_lines:      chicceLines.length,
    with_bas:         withBAS.length,
    no_bas:           noBAS.length,
    no_bas_matched:   noBASMatched.length,
    no_bas_unmatched: noBASUnmatched.length,
    bas_by_range:     basByRange,
    spend_by_range:   spendByRange,
    no_bas_status:    statusDistNoBAS,
  },
  ms_no_pdf: {
    total:           noPdf.length,
    by_year:         byYear,
    by_supplier:     bySupplier,
    zero_header:     zeroHeader.length,
    nonzero_header:  nonZeroHeader.length,
    by_error:        byError,
    sample:          sample,
  },
}, null, 2))
console.log(`\nFull dump: ${outFile}`)
