// Replay the batch endpoint's OR-filter against supplier_articles exactly
// as the production code does. See whether the row IS returned.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Combos to test — these all came back from diag-missing-thumbs as
// having a valid supplier_articles row with image_cached_path.
const combos = [
  '58264631|647065',   // Ägg Hel Flyt 5kg
  '58264631|181610',   // Kalvhögrev Rose Nl 5kg
  '58264631|151738',   // Kalvytterfile Rose Mk
  '58264631|125435',   // Lök Silver
  '58264631|440222',   // Mascarpone 2 kg variant a
  '58264631|379952',   // Mascarpone 2 kg variant b
  '58264631|328476',   // Blåbär 2,5kg
  '58264631|M/S3092',  // Ägg secondary
  '58264631|SER132450',// Kalvhögrev secondary
]

// Single direct .eq query — should hit
console.log('== A. Direct .eq query (one at a time) ==')
for (const c of combos) {
  const [sup, art] = c.split('|')
  const { data } = await db.from('supplier_articles')
    .select('article_number, image_cached_path, fetch_status')
    .eq('supplier_fortnox_number', sup)
    .eq('article_number', art)
    .maybeSingle()
  console.log(`  ${c} → ${data ? `status=${data.fetch_status} img=${data.image_cached_path ? 'YES' : 'NO'}` : 'NULL'}`)
}

// Replicate exact OR-filter format
console.log('\n== B. OR-filter exactly as API uses ==')
const orParts = combos.map(k => {
  const [sup, art] = k.split('|')
  return `and(supplier_fortnox_number.eq.${sup},article_number.eq.${art})`
})
const orStr = orParts.join(',')
console.log('Filter length:', orStr.length, 'chars')
console.log('First few parts:', orParts.slice(0,3))
const { data, error } = await db.from('supplier_articles')
  .select('supplier_fortnox_number, article_number, image_cached_path, fetch_status')
  .or(orStr)
  .eq('fetch_status', 'ok')
console.log('  error:', error)
console.log('  returned rows:', data?.length ?? 0)
const got = new Set((data ?? []).map(r => `${r.supplier_fortnox_number}|${r.article_number}`))
for (const c of combos) {
  console.log(`  ${c} → ${got.has(c) ? 'IN response' : 'MISSING from response'}`)
}

// Try without the M/S row (suspect special char)
console.log('\n== C. OR-filter WITHOUT slash-containing combos ==')
const safe = combos.filter(c => !c.includes('/'))
const safeParts = safe.map(k => {
  const [sup, art] = k.split('|')
  return `and(supplier_fortnox_number.eq.${sup},article_number.eq.${art})`
})
const { data: data2, error: err2 } = await db.from('supplier_articles')
  .select('supplier_fortnox_number, article_number, image_cached_path')
  .or(safeParts.join(','))
  .eq('fetch_status', 'ok')
console.log('  error:', err2)
console.log('  returned rows:', data2?.length ?? 0)
const got2 = new Set((data2 ?? []).map(r => `${r.supplier_fortnox_number}|${r.article_number}`))
for (const c of safe) {
  console.log(`  ${c} → ${got2.has(c) ? 'IN response' : 'MISSING from response'}`)
}
