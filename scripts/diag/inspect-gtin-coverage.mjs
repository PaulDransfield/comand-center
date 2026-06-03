// What EAN/GTIN data do we already have, and on which tables?
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Counts of supplier_articles with gtin
console.log('=== supplier_articles ===')
{
  const { count: total } = await db.from('supplier_articles').select('*', { count: 'exact', head: true })
  const { count: withGtin } = await db.from('supplier_articles').select('*', { count: 'exact', head: true }).not('gtin','is',null)
  console.log(`  total: ${total}`)
  console.log(`  with gtin: ${withGtin}`)
}

// Sample of supplier_articles rows that have a GTIN
const { data: samples } = await db.from('supplier_articles')
  .select('supplier_fortnox_number, article_number, official_name, gtin, source')
  .not('gtin','is',null)
  .limit(15)
console.log('\nSample with GTIN:')
for (const r of samples ?? []) {
  console.log(`  ${r.supplier_fortnox_number}|${r.article_number}  GTIN=${r.gtin}  source=${r.source}  "${r.official_name?.slice(0,45)}"`)
}

// Distribution by source
{
  const { data: all } = await db.from('supplier_articles').select('source, gtin').limit(10000)
  const bySource = new Map()
  for (const r of all ?? []) {
    const k = r.source ?? 'null'
    const cur = bySource.get(k) ?? { total: 0, withGtin: 0 }
    cur.total++
    if (r.gtin) cur.withGtin++
    bySource.set(k, cur)
  }
  console.log('\nBy source (first 10k rows):')
  for (const [k, v] of bySource) console.log(`  ${k}: ${v.total} total, ${v.withGtin} with gtin (${(v.withGtin/v.total*100).toFixed(1)}%)`)
}

// Check if products table has its own gtin/ean column
console.log('\n=== products columns ===')
{
  const { data, error } = await db.from('products').select('*').limit(1)
  if (data?.[0]) {
    const cols = Object.keys(data[0])
    const gtinish = cols.filter(c => /gtin|ean|barcode|upc/i.test(c))
    console.log(`  columns matching gtin/ean/barcode: ${gtinish.length ? gtinish.join(', ') : '(none)'}`)
  }
}

// Check supplier_invoice_lines for raw_description containing potential barcodes
console.log('\n=== potential barcodes in raw_description ===')
{
  const { count } = await db.from('supplier_invoice_lines')
    .select('*', { count: 'exact', head: true })
    .or('raw_description.like.%7%,raw_description.like.%5%')   // dummy — too broad
  // Better: just look at descriptions for the EAN-13 shape
  const { data: lines } = await db.from('supplier_invoice_lines')
    .select('raw_description')
    .not('raw_description','is',null)
    .limit(3000)
  let withBarcode = 0
  const samples2 = []
  for (const l of lines ?? []) {
    const m = l.raw_description?.match(/\b(\d{12,13})\b/)
    if (m) {
      withBarcode++
      if (samples2.length < 6) samples2.push({ desc: l.raw_description, ean: m[1] })
    }
  }
  console.log(`  invoice lines with EAN-shaped digits (12-13 digits, sample of 3000): ${withBarcode}`)
  for (const s of samples2) console.log(`    ${s.ean}  "${s.desc.slice(0,55)}"`)
}
