// What did the MS scrape actually capture for egg articles?
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const { data } = await db.from('supplier_articles')
  .select('article_number, official_name, unit, net_weight_g, brutto_weight_g, units_per_pack, units_per_pack_label, fetch_status')
  .eq('supplier_fortnox_number', '58264631')
  .or('official_name.ilike.%ägg%,official_name.ilike.%egg%,article_number.in.(435602,144433,573618,216655,101002,124480,144433,481911)')
  .limit(30)

for (const r of data ?? []) {
  console.log(`art=${r.article_number} "${r.official_name}"`)
  console.log(`  unit="${r.unit}" net_weight=${r.net_weight_g}g brutto=${r.brutto_weight_g}g units_per_pack=${r.units_per_pack} label="${r.units_per_pack_label}" status=${r.fetch_status}`)
}

// And a few count-based items I'd want to verify:
console.log('\n=== Other count-based or pack-format candidates ===')
const { data: pk } = await db.from('supplier_articles')
  .select('article_number, official_name, unit, net_weight_g, units_per_pack, units_per_pack_label, fetch_status')
  .eq('supplier_fortnox_number', '58264631')
  .or('article_number.in.(366738,453979,406197,464651,251777)')
  .limit(20)
for (const r of pk ?? []) {
  console.log(`art=${r.article_number} "${r.official_name}"`)
  console.log(`  unit="${r.unit}" net=${r.net_weight_g}g units_per_pack=${r.units_per_pack} label="${r.units_per_pack_label}"`)
}

// Get a sampling of the unit values that exist
console.log('\n=== Distinct unit values across all MS supplier_articles ===')
const { data: units } = await db.from('supplier_articles')
  .select('unit')
  .eq('supplier_fortnox_number', '58264631')
  .eq('fetch_status', 'ok')
  .not('unit', 'is', null)
  .limit(2000)
const counts = new Map()
for (const r of units ?? []) {
  const u = r.unit?.trim()?.toLowerCase() ?? '(null)'
  counts.set(u, (counts.get(u) ?? 0) + 1)
}
for (const [u, n] of [...counts.entries()].sort((a,b) => b[1] - a[1])) {
  console.log(`  ${n.toString().padStart(4)} × "${u}"`)
}
