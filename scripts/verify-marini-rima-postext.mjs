#!/usr/bin/env node
// Check line creation timestamps + invoice_pdf_extractions update pattern.
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

async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

const BIZ = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const targets = ['3174', '2902', '2948', '2975', '3278']

console.log('--- newest supplier_invoice_line per invoice ---')
for (const inv of targets) {
  const rows = await q(`supplier_invoice_lines?business_id=eq.${BIZ}&fortnox_invoice_number=eq.${inv}&select=id,raw_description,quantity,unit,total_excl_vat,source,created_at&order=created_at.desc&limit=3`)
  console.log(`  ${inv}:`)
  for (const r of rows) console.log(`    ${r.created_at}  src=${r.source}  qty=${r.quantity}  total=${r.total_excl_vat}  ${r.raw_description?.slice(0, 40)}`)
}

console.log('\n--- per-source line counts ---')
for (const inv of targets) {
  const all = await q(`supplier_invoice_lines?business_id=eq.${BIZ}&fortnox_invoice_number=eq.${inv}&select=source`)
  const tally = {}
  for (const r of all) tally[r.source] = (tally[r.source] ?? 0) + 1
  console.log(`  ${inv}: ${JSON.stringify(tally)}`)
}
