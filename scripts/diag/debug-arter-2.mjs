// Run the full auto-merge algorithm but only for ÄRTER GRÖNA, with verbose
// tracing.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

function jaccard(a, b) {
  const A = new Set(a.toLowerCase().replace(/[^\wåäöÅÄÖ]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 1))
  const B = new Set(b.toLowerCase().replace(/[^\wåäöÅÄÖ]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 1))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0; for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Get the orphan
const { data: orphanProd } = await db.from('products')
  .select('id, name, archived_at')
  .eq('business_id', CHICCE)
  .eq('name', 'ÄRTER GRÖNA 2,5KG, Nyckelhål;Från Sverige;')
  .maybeSingle()
console.log('Orphan product:', orphanProd)
if (!orphanProd) { console.log('NOT FOUND'); process.exit(0) }

// Check aliases
const { data: aliases } = await db.from('product_aliases')
  .select('id').eq('product_id', orphanProd.id).eq('is_active', true)
console.log(`Active aliases: ${aliases?.length ?? 0}`)

// Pull lines as the script does
const cutoff = new Date(Date.now() - 18 * 30 * 86400000).toISOString().slice(0, 10)
console.log('cutoff:', cutoff)
const allLines = []
let from = 0
while (true) {
  const { data } = await db.from('supplier_invoice_lines')
    .select('id, supplier_fortnox_number, article_number, raw_description, product_alias_id, invoice_date')
    .eq('business_id', CHICCE).gte('invoice_date', cutoff)
    .not('article_number','is',null).not('raw_description','is',null)
    .order('id').range(from, from + 999)
  if (!data?.length) break
  allLines.push(...data)
  if (data.length < 1000) break; from += 1000
  if (allLines.length > 100000) break
}
console.log(`Total lines pulled: ${allLines.length}`)

// Build candidates
const candidates = []
for (const l of allLines) {
  const sim = jaccard(orphanProd.name, l.raw_description)
  if (sim >= 0.5) candidates.push({ sim, line: l })
}
console.log(`Candidates (sim ≥ 0.5): ${candidates.length}`)

if (candidates.length >= 1) {
  const aliasIds = [...new Set(candidates.map(c => c.line.product_alias_id).filter(Boolean))]
  console.log(`Distinct candidate aliases: ${aliasIds.length}`, aliasIds.map(a => a.slice(0,8)))
  const { data: aliasRows } = await db.from('product_aliases').select('id, product_id').in('id', aliasIds).eq('is_active', true)
  console.log(`Active alias rows found: ${aliasRows?.length ?? 0}`)
  for (const ar of aliasRows ?? []) console.log(`  alias ${ar.id.slice(0,8)} → product ${ar.product_id.slice(0,8)}`)
  const ownerIds = new Set((aliasRows ?? []).map(a => a.product_id))
  console.log(`Distinct owners: ${ownerIds.size}`, [...ownerIds].map(o => o.slice(0,8)))
  if (ownerIds.size === 1) {
    const ownerId = [...ownerIds][0]
    const { count } = await db.from('supplier_invoice_lines').select('*', { count: 'exact', head: true }).in('product_alias_id', aliasIds)
    console.log(`Owner-aliases line count: ${count}`)
    if ((count ?? 0) >= 4) {
      console.log(`  ✓ ALL GATES PASS — should be eligible for merge into product ${ownerId.slice(0,8)}`)
    } else {
      console.log(`  ✗ Failed line-count gate (need ≥4, got ${count})`)
    }
  } else {
    console.log(`  ✗ Failed owner-count gate (need 1, got ${ownerIds.size})`)
  }
}
