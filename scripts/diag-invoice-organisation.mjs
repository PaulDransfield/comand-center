#!/usr/bin/env node
// READ-ONLY characterisation pass for the invoice-organisation
// investigation. Three sections matching the prompt:
//
//   1. What Fortnox already gives us — BAS coverage, real chart of
//      accounts by spend, supplier-provided categorisation hints,
//      voucher-cache backfill provenance distribution.
//   2. Data-integrity gap classes — sized by count + spend, ranked.
//   3. Tracker / overhead consumer surface check.
//
// No writes. Output is a structured JSON dump + readable summary.

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

const BIZES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

const out = { generated_at: new Date().toISOString(), businesses: {} }

for (const biz of BIZES) {
  console.log(`\n\n========== ${biz.name} ==========`)
  const B = {}
  out.businesses[biz.name] = B

  // ── Part 1 — Fortnox-side coverage ──────────────────────────────

  // Total supplier_invoice_lines + populated account_number count.
  const allLines = []
  for (let from = 0; ; from += 1000) {
    const batch = await q(`supplier_invoice_lines?business_id=eq.${biz.id}&select=account_number,account_source,total_excl_vat,supplier_fortnox_number,match_status&offset=${from}&limit=1000`)
    allLines.push(...batch)
    if (batch.length < 1000) break
    if (allLines.length > 50000) break
  }
  B.lines_total = allLines.length
  B.lines_with_account = allLines.filter(l => l.account_number != null).length
  B.account_source_dist = {}
  for (const l of allLines) {
    const src = l.account_source ?? 'null'
    B.account_source_dist[src] = (B.account_source_dist[src] ?? 0) + 1
  }
  const totalSpend = allLines.reduce((s, l) => s + Math.abs(Number(l.total_excl_vat ?? 0)), 0)
  B.total_spend = Math.round(totalSpend)
  B.spend_with_account = Math.round(allLines.filter(l => l.account_number != null).reduce((s, l) => s + Math.abs(Number(l.total_excl_vat ?? 0)), 0))
  console.log(`Lines: ${B.lines_total}, with account: ${B.lines_with_account} (${(100 * B.lines_with_account / B.lines_total).toFixed(1)}%)`)
  console.log(`Spend: ${B.total_spend.toLocaleString()} SEK; with BAS: ${B.spend_with_account.toLocaleString()} (${(100 * B.spend_with_account / B.total_spend).toFixed(1)}%)`)
  console.log(`Account source distribution: ${JSON.stringify(B.account_source_dist)}`)

  // Distinct BAS accounts + spend per. Top 20 by spend.
  const byAcct = new Map()
  for (const l of allLines) {
    if (l.account_number == null) continue
    const k = String(l.account_number)
    const cur = byAcct.get(k) ?? { account: k, spend: 0, lines: 0 }
    cur.spend += Math.abs(Number(l.total_excl_vat ?? 0))
    cur.lines += 1
    byAcct.set(k, cur)
  }
  const sortedAccounts = [...byAcct.values()].sort((a, b) => b.spend - a.spend)
  B.distinct_accounts = sortedAccounts.length
  B.top20_accounts_by_spend = sortedAccounts.slice(0, 20).map(a => ({ account: a.account, spend: Math.round(a.spend), lines: a.lines }))
  console.log(`Distinct BAS accounts in use: ${B.distinct_accounts}`)
  console.log(`Top 8 by spend:`)
  for (const a of sortedAccounts.slice(0, 8)) console.log(`  ${a.account.padEnd(6)} ${Math.round(a.spend).toLocaleString().padStart(12)} SEK  ${a.lines} lines`)

  // ── Part 2 — Data-integrity gap classes ─────────────────────────

  // Extraction status distribution.
  const extractions = []
  for (let from = 0; ; from += 1000) {
    const batch = await q(`invoice_pdf_extractions?business_id=eq.${biz.id}&select=status,total_header,validation_warnings&offset=${from}&limit=1000`)
    extractions.push(...batch)
    if (batch.length < 1000) break
    if (extractions.length > 20000) break
  }
  B.extractions_total = extractions.length
  B.extraction_status_dist = {}
  B.extraction_status_spend = {}
  for (const e of extractions) {
    B.extraction_status_dist[e.status] = (B.extraction_status_dist[e.status] ?? 0) + 1
    const spend = Math.abs(Number(e.total_header ?? 0))
    B.extraction_status_spend[e.status] = Math.round((B.extraction_status_spend[e.status] ?? 0) + spend)
  }
  console.log(`\nExtractions: ${B.extractions_total}`)
  for (const [s, n] of Object.entries(B.extraction_status_dist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(20)} ${n.toString().padStart(5)} (${B.extraction_status_spend[s].toLocaleString()} SEK)`)
  }

  // Validation warnings — count over_extraction / total_mismatch.
  let overExtractionCount = 0, totalMismatchCount = 0
  for (const e of extractions) {
    if (!Array.isArray(e.validation_warnings)) continue
    for (const w of e.validation_warnings) {
      if (w.code === 'over_extraction')  overExtractionCount++
      if (w.code === 'total_mismatch')   totalMismatchCount++
    }
  }
  B.over_extraction_count = overExtractionCount
  B.total_mismatch_count  = totalMismatchCount

  // Empty-line populations: lines with no raw_description from source.
  // source IS NOT NULL → ingested; null raw_description = blanks.
  const blankRaw = await q(`supplier_invoice_lines?business_id=eq.${biz.id}&raw_description=is.null&select=fortnox_invoice_number,source,total_excl_vat&limit=1000`)
  B.blank_raw_description_count = blankRaw.length
  B.blank_raw_description_spend = Math.round(blankRaw.reduce((s, l) => s + Math.abs(Number(l.total_excl_vat ?? 0)), 0))
  const blankBySource = {}
  for (const l of blankRaw) blankBySource[l.source ?? 'null'] = (blankBySource[l.source ?? 'null'] ?? 0) + 1
  B.blank_by_source = blankBySource
  console.log(`Blank raw_description lines: ${B.blank_raw_description_count} (${B.blank_raw_description_spend.toLocaleString()} SEK) — by source: ${JSON.stringify(blankBySource)}`)

  // ── Part 3 — Operator-cost-structure consumer surface check ───
  // We're checking IF tracker_line_items / monthly_metrics already have
  // operator-cost-structure data. Just the row counts + category dist.
  const tracker = await q(`tracker_line_items?business_id=eq.${biz.id}&select=category,subcategory,amount&limit=5000`)
  B.tracker_line_items_count = tracker.length
  const trackerCatDist = {}
  for (const t of tracker) {
    const k = `${t.category ?? '?'}/${t.subcategory ?? '?'}`
    trackerCatDist[k] = (trackerCatDist[k] ?? 0) + 1
  }
  B.tracker_category_combos = Object.keys(trackerCatDist).length
  B.tracker_top10_combos = Object.entries(trackerCatDist).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => ({ key: k, lines: n }))
  console.log(`\ntracker_line_items: ${B.tracker_line_items_count} rows, ${B.tracker_category_combos} distinct (category/subcategory) combos`)
}

if (!existsSync('tmp')) mkdirSync('tmp')
const f = `tmp/invoice-organisation-${Date.now()}.json`
writeFileSync(f, JSON.stringify(out, null, 2))
console.log(`\n\nFull dump: ${f}`)
