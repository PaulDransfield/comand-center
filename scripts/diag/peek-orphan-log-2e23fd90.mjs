import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const { data: prods } = await db.from('products').select('id, name').eq('name', 'Blåbär 2,5kg').is('archived_at', null)
console.log(`Exact-name matches: ${prods?.length}`)
for (const p of prods ?? []) {
  console.log(`${p.id} "${p.name}"`)
  const { data: logs } = await db.from('orphan_rescue_log').select('*').eq('orphan_product_id', p.id).order('created_at', { ascending: false })
  console.log(`  log entries: ${logs?.length}`)
  for (const l of logs ?? []) {
    console.log(`    ${l.created_at}  action=${l.action} candidate_count=${l.candidate_count}`)
    console.log(`      → "${l.canonical_name}"  verdict=${l.verdict} conf=${l.confidence}`)
    console.log(`      reasoning: ${(l.reasoning ?? l.error_message ?? '').slice(0,200)}`)
  }
}
