// Q1: what does Spendrups carry in supplier_invoice_lines.article_number?
// 7-digit Spendrups codes, EAN/GTIN, or a mix?
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Find Spendrups supplier fortnox_number(s)
const { data: lines } = await db.from('supplier_invoice_lines')
  .select('supplier_fortnox_number, supplier_name_snapshot, article_number, raw_description')
  .ilike('supplier_name_snapshot', '%spendrups%')
  .not('article_number','is',null)
  .limit(200)

console.log(`Spendrups lines sampled: ${lines?.length ?? 0}`)
const supNumbers = new Set((lines ?? []).map(l => l.supplier_fortnox_number))
console.log(`Distinct supplier_fortnox_number: ${[...supNumbers].join(', ')}`)

// Categorise article_number by shape
const buckets = { ean13: [], ean8: [], spendrups7: [], spendrups6: [], spendrups8: [], other: [] }
for (const l of lines ?? []) {
  const a = String(l.article_number ?? '').trim()
  if (/^\d{13}$/.test(a)) buckets.ean13.push(l)
  else if (/^\d{8}$/.test(a)) buckets.ean8.push(l)
  else if (/^\d{7}$/.test(a)) buckets.spendrups7.push(l)
  else if (/^\d{6}$/.test(a)) buckets.spendrups6.push(l)
  else buckets.other.push(l)
}
for (const [name, list] of Object.entries(buckets)) {
  if (list.length === 0) continue
  console.log(`\n  ${name}: ${list.length}`)
  for (const l of list.slice(0, 5)) {
    console.log(`    ${l.article_number}  "${l.raw_description?.slice(0,60)}"`)
  }
}

// Try to find EANs in raw_description as fallback
console.log(`\nEANs (13-digit) appearing in raw_description:`)
let withEan = 0
for (const l of lines ?? []) {
  const m = String(l.raw_description ?? '').match(/\b(\d{13})\b/)
  if (m) { withEan++; if (withEan <= 5) console.log(`    ${m[1]}  in  "${l.raw_description?.slice(0,60)}"`) }
}
console.log(`  Total: ${withEan} / ${lines?.length}`)
