#!/usr/bin/env node
// Step 0 — characterise the enrichment target.
//
// For each business: of the tracker_line_items rows where subcategory IS
// NULL (or '?'), what BAS accounts do they carry? Cross-check against
// the real 19-account working chart from the prior investigation. This
// is the population the dictionary will resolve.
//
// Also: how often does a single source_upload have multiple BAS accounts
// across its line items? (Sizes the multi-bucket sub-line risk.)

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

const out = {}
for (const biz of BIZES) {
  console.log(`\n========== ${biz.name} ==========`)
  const all = []
  for (let from = 0; ; from += 1000) {
    const batch = await q(`tracker_line_items?business_id=eq.${biz.id}&select=id,category,subcategory,label_sv,amount,fortnox_account,source_upload_id,period_year,period_month&offset=${from}&limit=1000`)
    all.push(...batch)
    if (batch.length < 1000) break
    if (all.length > 20000) break
  }
  console.log(`Total tracker_line_items: ${all.length}`)

  // subcategory distribution by category
  const subDist = {}
  for (const r of all) {
    const k = `${r.category ?? '?'}|${r.subcategory ?? 'NULL'}`
    subDist[k] = (subDist[k] ?? 0) + 1
  }
  console.log(`Top 15 (category|subcategory):`)
  for (const [k, n] of Object.entries(subDist).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${k.padEnd(28)} ${n}`)
  }

  // Rows with subcategory = NULL — BAS distribution
  const nullRows = all.filter(r => !r.subcategory || r.subcategory === '?')
  console.log(`\nRows with NULL/'?' subcategory: ${nullRows.length} (${(100 * nullRows.length / all.length).toFixed(1)}%)`)
  const nullBasDist = {}
  let nullNoBas = 0
  for (const r of nullRows) {
    if (r.fortnox_account == null) { nullNoBas++; continue }
    const k = `${r.fortnox_account}`
    nullBasDist[k] = (nullBasDist[k] ?? 0) + 1
  }
  console.log(`  of those, ${nullRows.length - nullNoBas} have a BAS account (dictionary-resolvable)`)
  console.log(`  ${nullNoBas} have NO BAS account (stay uncategorised — honest-incomplete)`)
  console.log(`  Top 15 BAS accounts on NULL-subcategory rows:`)
  for (const [k, n] of Object.entries(nullBasDist).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`    ${k.padEnd(6)} ${n.toString().padStart(4)} rows`)
  }

  // ── Multi-bucket sub-line risk ──
  // For each source_upload_id, how many DISTINCT BAS accounts does its
  // line items use? If >1, that's a multi-bucket invoice.
  const bySrc = new Map()
  for (const r of all) {
    if (!r.source_upload_id || r.fortnox_account == null) continue
    if (!bySrc.has(r.source_upload_id)) bySrc.set(r.source_upload_id, new Set())
    bySrc.get(r.source_upload_id).add(String(r.fortnox_account))
  }
  const multi = [...bySrc.values()].filter(s => s.size > 1).length
  console.log(`\nSource uploads with >1 distinct BAS account (multi-bucket): ${multi} of ${bySrc.size}`)

  // Sample some multi-bucket uploads to see what they look like
  const multiSamples = []
  for (const [src, set] of bySrc) {
    if (set.size > 1) multiSamples.push({ src, accounts: [...set], count: all.filter(r => r.source_upload_id === src).length })
    if (multiSamples.length >= 5) break
  }
  console.log(`Sample multi-bucket uploads:`)
  for (const s of multiSamples) console.log(`  upload ${s.src.slice(0, 8)} — ${s.count} rows, accounts: [${s.accounts.join(', ')}]`)

  out[biz.name] = {
    total:                  all.length,
    null_subcategory_rows:  nullRows.length,
    null_with_bas:          nullRows.length - nullNoBas,
    null_no_bas:            nullNoBas,
    null_bas_dist:          nullBasDist,
    sub_dist_top15:         Object.entries(subDist).sort((a, b) => b[1] - a[1]).slice(0, 15),
    multi_bucket_count:     multi,
    multi_bucket_total:     bySrc.size,
  }
}

if (!existsSync('tmp')) mkdirSync('tmp')
const f = `tmp/bas-bucket-step0-${Date.now()}.json`
writeFileSync(f, JSON.stringify(out, null, 2))
console.log(`\n\nFull dump: ${f}`)
