import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const { data, error } = await db.from('supplier_articles')
  .select('supplier_fortnox_number, article_number, official_name, image_cached_path, fetch_status, units_per_pack_label, country_origin, brand')
  .eq('source', 'systembolaget_scrape')
  .order('article_number')
if (error) { console.error(error.message); process.exit(1) }

console.log(`systembolaget_scrape rows: ${data.length}`)
for (const r of data) console.log(`  ${r.supplier_fortnox_number}|${r.article_number}  "${r.official_name}"  img=${r.image_cached_path}  status=${r.fetch_status}  label="${r.units_per_pack_label}"  country=${r.country_origin}`)

// Verify storage objects exist
const paths = data.filter(r => r.image_cached_path).map(r => r.image_cached_path)
const unique = [...new Set(paths)]
console.log(`\nUnique image paths: ${unique.length}`)
for (const p of unique) {
  const url = `${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/supplier-article-images/${p}`
  const resp = await fetch(url, { method: 'HEAD' })
  console.log(`  ${resp.status} ${p}`)
}
