// How many supplier_articles actually have image_cached_path set vs
// missing? And does the public URL resolve?
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

console.log('=== supplier_articles coverage ===')
const { count: total } = await db.from('supplier_articles').select('*', { count: 'exact', head: true }).eq('fetch_status', 'ok')
const { count: withImg } = await db.from('supplier_articles').select('*', { count: 'exact', head: true })
  .eq('fetch_status', 'ok').not('image_cached_path', 'is', null)
console.log(`  fetch_status=ok total:           ${total}`)
console.log(`  with image_cached_path:         ${withImg}`)
console.log(`  missing image:                  ${(total ?? 0) - (withImg ?? 0)}`)
console.log(`  coverage %:                     ${(100 * (withImg ?? 0) / (total ?? 1)).toFixed(1)}%`)

// Spot-check a few with image
const { data: sample } = await db.from('supplier_articles')
  .select('article_number, official_name, image_cached_path')
  .eq('fetch_status', 'ok').not('image_cached_path', 'is', null).limit(5)
console.log('\nSample with image_cached_path:')
for (const r of sample ?? []) {
  const url = `${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/supplier-article-images/${r.image_cached_path}`
  console.log(`  ${r.article_number} "${r.official_name?.slice(0,40)}"`)
  console.log(`    path: ${r.image_cached_path}`)
  console.log(`    url:  ${url}`)
  try {
    const head = await fetch(url, { method: 'HEAD' })
    console.log(`    HEAD: ${head.status} ${head.headers.get('content-type') ?? ''} ${head.headers.get('content-length') ?? ''} bytes`)
  } catch (e) {
    console.log(`    HEAD failed: ${e.message}`)
  }
}

// Spot-check a few WITHOUT image — what does the row look like?
const { data: noImg } = await db.from('supplier_articles')
  .select('article_number, official_name, image_cached_path, fetch_status')
  .eq('fetch_status', 'ok').is('image_cached_path', null).limit(10)
console.log('\nSample WITHOUT image:')
for (const r of noImg ?? []) {
  console.log(`  ${r.article_number} "${r.official_name?.slice(0,50)}"`)
}
