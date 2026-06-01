#!/usr/bin/env node
// Trigger /api/admin/reextract-invoice on the Vero PDF backlog.
//
// Calls the prod endpoint in batches of 10 (the endpoint's max). Each
// batch waits for the previous to finish — sequential not parallel so
// we don't hit Fortnox rate limits.
//
// Reports per-invoice GOOD / INERT / REJECTED classification + totals.
// Same shape as the Marini/Rima re-extract script from earlier today.

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
const ADMIN_SECRET = env.ADMIN_SECRET
const PROD_URL = 'https://comandcenter.se'

if (!ADMIN_SECRET) {
  console.error('Missing ADMIN_SECRET in .env.production.local')
  process.exit(1)
}

const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }
async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: h })
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

// Pull the full backlog. Recoverable = status in (failed, pending) with
// pdf_file_id present.
console.log('Loading Vero backlog…')
const all = []
for (let from = 0; ; from += 1000) {
  const batch = await q(`invoice_pdf_extractions?business_id=eq.${VERO}&status=in.(failed,pending)&pdf_file_id=not.is.null&select=fortnox_invoice_number,status&offset=${from}&limit=1000`)
  all.push(...batch)
  if (batch.length < 1000) break
  if (all.length > 5000) break
}
console.log(`Recoverable invoices: ${all.length}`)
console.log(`  failed:  ${all.filter(r => r.status === 'failed').length}`)
console.log(`  pending: ${all.filter(r => r.status === 'pending').length}`)
console.log()

const invoices = all.map(r => ({ business_id: VERO, fortnox_invoice_number: r.fortnox_invoice_number }))

const BATCH_SIZE = 10
const results = []
let batchNum = 0
const startTime = Date.now()

for (let i = 0; i < invoices.length; i += BATCH_SIZE) {
  batchNum++
  const batch = invoices.slice(i, i + BATCH_SIZE)
  const batchStart = Date.now()
  console.log(`Batch ${batchNum}: invoices ${batch.map(b => b.fortnox_invoice_number).join(', ')}`)

  try {
    const r = await fetch(`${PROD_URL}/api/admin/reextract-invoice`, {
      method: 'POST',
      headers: {
        'content-type':   'application/json',
        'x-admin-secret': ADMIN_SECRET,
      },
      body: JSON.stringify({ invoices: batch }),
    })
    if (!r.ok) {
      console.log(`  ERROR ${r.status}: ${(await r.text()).slice(0, 200)}`)
      continue
    }
    const j = await r.json()
    const dur = ((Date.now() - batchStart) / 1000).toFixed(1)
    console.log(`  ${dur}s — summary: ${JSON.stringify(j.summary)}`)
    for (const res of j.results) {
      results.push(res)
      const tag = res.error
        ? `ERROR: ${res.error}`
        : `${res.classification} rows=${res.rows_extracted} total=${res.total_extracted} ai=${res.ai_model} $${res.cost_usd}`
      console.log(`    ${res.fortnox_invoice_number}: ${tag}`)
    }
  } catch (e) {
    console.log(`  ERROR: ${e?.message ?? e}`)
  }
  console.log()
}

console.log('\n\n=== FINAL TALLY ===')
const tally = {
  GOOD:             results.filter(r => r.classification === 'GOOD').length,
  INERT:            results.filter(r => r.classification === 'INERT').length,
  REJECTED:         results.filter(r => r.classification === 'REJECTED').length,
  OTHER_ACCEPTED:   results.filter(r => r.classification === 'OTHER_ACCEPTED').length,
  OTHER_BLOCKED:    results.filter(r => r.classification === 'OTHER_BLOCKED').length,
  ERROR:            results.filter(r => r.error).length,
}
console.log(JSON.stringify(tally, null, 2))
const totalCost = results.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0)
const totalDuration = ((Date.now() - startTime) / 1000).toFixed(0)
console.log(`\nTotal cost: $${totalCost.toFixed(4)}`)
console.log(`Total duration: ${totalDuration}s`)

if (!existsSync('tmp')) mkdirSync('tmp')
const out = `tmp/vero-pdf-retry-${Date.now()}.json`
writeFileSync(out, JSON.stringify({ ts: new Date().toISOString(), tally, totalCost, results }, null, 2))
console.log(`Detail: ${out}`)
