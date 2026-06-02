// READ-ONLY. Where are the burrata supplier lines at Chicce + Vero, and
// why isn't the link-search picker showing them?
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)
  const { data: lines, error } = await db.from('supplier_invoice_lines')
    .select('id, raw_description, supplier_name_snapshot, match_status, product_alias_id, total_excl_vat, quantity, invoice_date')
    .eq('business_id', biz.id)
    .ilike('raw_description', '%burrata%')
    .order('invoice_date', { ascending: false })
    .limit(50)
  if (error) { console.error(error.message); continue }
  console.log(`  ${lines?.length ?? 0} supplier_invoice_lines containing 'burrata'`)
  // Bucket by match_status × has_alias
  const buckets = new Map()
  for (const l of lines ?? []) {
    const key = `${l.match_status ?? '∅'} / alias=${l.product_alias_id ? 'yes' : 'no'}`
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  console.log(`  Buckets:`)
  for (const [k, n] of buckets) console.log(`    ${k}: ${n}`)
  console.log(`  Sample lines (up to 10):`)
  for (const l of (lines ?? []).slice(0, 10)) {
    console.log(`    • "${l.raw_description}" — ${l.supplier_name_snapshot} — ms=${l.match_status} alias=${l.product_alias_id ?? '∅'}`)
  }
  // If lines are matched, what product are they pointing at?
  const aliasIds = [...new Set((lines ?? []).map(l => l.product_alias_id).filter(Boolean))]
  if (aliasIds.length > 0) {
    const { data: aliases } = await db.from('product_aliases')
      .select('id, product_id, match_method')
      .in('id', aliasIds.slice(0, 100))
    const productIds = [...new Set((aliases ?? []).map(a => a.product_id).filter(Boolean))]
    if (productIds.length > 0) {
      const { data: products } = await db.from('products')
        .select('id, name, category')
        .in('id', productIds.slice(0, 100))
      console.log(`  ↳ Existing burrata lines are linked to these products:`)
      for (const p of products ?? []) {
        console.log(`    • "${p.name}" (${p.category})  id=${p.id}`)
      }
    }
  }
}
console.log('\ndone')
