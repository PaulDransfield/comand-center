// Trace the auto-merge algorithm against the ÄRTER GRÖNA orphan
// to find why it's not being caught.
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

const ORPHAN_NAME = 'ÄRTER GRÖNA 2,5KG, Nyckelhål;Från Sverige;'
const ORPHAN_ID   = '52c9a871'
const CHICCE      = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Token check
const A = new Set(ORPHAN_NAME.toLowerCase().replace(/[^\wåäöÅÄÖ]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 1))
console.log('Orphan tokens:', [...A])

const lines = [
  'ÄRTER GRÖNA 2,5KG',
  'ÄRTER GRÖNA 2,5KG, Nyckelhål;Från Sverige;',
  'ÄRTER GRÖNA 2,5KG, Nyckelhål;',
]
for (const l of lines) {
  const B = new Set(l.toLowerCase().replace(/[^\wåäöÅÄÖ]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 1))
  console.log(`  vs "${l}"  tokens=${[...B].join(',')}  sim=${jaccard(ORPHAN_NAME, l).toFixed(3)}`)
}

console.log('\n== Full algorithm replay ==')
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
console.log('Total lines:', allLines.length)

const candidates = []
for (const l of allLines) {
  const sim = jaccard(ORPHAN_NAME, l.raw_description)
  if (sim >= 0.5) candidates.push({ sim, line: l })
}
console.log(`Candidates with sim ≥ 0.5: ${candidates.length}`)
for (const c of candidates.slice(0, 10)) {
  console.log(`  sim=${c.sim.toFixed(3)} art=${c.line.article_number} alias=${c.line.product_alias_id?.slice(0,8)} "${c.line.raw_description.slice(0,50)}"`)
}

const articleNumbers = new Set(candidates.map(c => c.line.article_number))
console.log(`Distinct articles: ${articleNumbers.size}`, [...articleNumbers])

if (articleNumbers.size === 1) {
  const aliasIds = [...new Set(candidates.map(c => c.line.product_alias_id).filter(Boolean))]
  console.log(`Distinct aliases: ${aliasIds.length}`, aliasIds.map(a => a.slice(0,8)))
  const { data: aliasRows } = await db.from('product_aliases').select('id, product_id').in('id', aliasIds).eq('is_active', true)
  const ownerIds = new Set((aliasRows ?? []).map(a => a.product_id))
  console.log(`Distinct owner products: ${ownerIds.size}`, [...ownerIds].map(o => o.slice(0,8)))
  const { count: ownerLineCount } = await db.from('supplier_invoice_lines')
    .select('*', { count: 'exact', head: true })
    .in('product_alias_id', aliasIds)
  console.log(`Owner line count: ${ownerLineCount}`)
}
