#!/usr/bin/env node
// Show the residual at Chicce + Vero: needs_review + no alias, grouped
// by supplier, with sample descriptions per group. Reveals the actual
// shape of what's sneaking through current rules.

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
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }
async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: h })
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`)
  return r.json()
}

const BIZES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

for (const biz of BIZES) {
  console.log(`\n\n========== ${biz.name} ==========\n`)

  // Paginate so the 1000-cap doesn't truncate.
  const all = []
  for (let from = 0; ; from += 1000) {
    const batch = await q(`supplier_invoice_lines?business_id=eq.${biz.id}&match_status=eq.needs_review&product_alias_id=is.null&select=raw_description,supplier_name_snapshot,total_excl_vat,fortnox_invoice_number&offset=${from}&limit=1000`)
    all.push(...batch)
    if (batch.length < 1000) break
    if (all.length > 10000) break
  }
  console.log(`Total needs_review without alias: ${all.length}`)

  // Group by supplier.
  const bySupplier = new Map()
  for (const r of all) {
    const s = r.supplier_name_snapshot ?? '(none)'
    if (!bySupplier.has(s)) bySupplier.set(s, [])
    bySupplier.get(s).push(r)
  }
  const sorted = [...bySupplier.entries()].sort((a, b) => b[1].length - a[1].length)
  console.log(`Distinct suppliers: ${sorted.length}\n`)

  // Top 25 suppliers by line count. For each, sample 3 unique
  // descriptions to spot patterns.
  console.log('Top suppliers by line count (top 25):')
  for (const [supplier, rows] of sorted.slice(0, 25)) {
    const uniqueDesc = new Set()
    for (const r of rows) { uniqueDesc.add((r.raw_description ?? '').slice(0, 80)) }
    const invs = new Set(rows.map(r => r.fortnox_invoice_number).filter(Boolean))
    console.log(`\n  ${supplier.slice(0, 50).padEnd(50)} ${rows.length.toString().padStart(4)} lines · ${invs.size} invoices · unique descs: ${uniqueDesc.size}`)
    for (const d of [...uniqueDesc].slice(0, 3)) {
      console.log(`    "${d}"`)
    }
  }
}
