import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const { data } = await db.from('orphan_rescue_log')
  .select('*').eq('orphan_product_id', '2e23fd90-' /*prefix wildcard*/).limit(5)
// Need exact id — let me look up
const { data: p } = await db.from('products').select('id').ilike('id','2e23fd90-%').limit(1)
const pid = p?.[0]?.id
console.log(`Blåbär 2,5kg product_id: ${pid}`)
if (pid) {
  const { data: logs } = await db.from('orphan_rescue_log').select('*').eq('orphan_product_id', pid).order('created_at', { ascending: false })
  console.log(`Log entries: ${logs?.length}`)
  for (const l of logs ?? []) {
    console.log(`\n${l.created_at}  action=${l.action}`)
    console.log(`  candidate: "${l.canonical_name}"`)
    console.log(`  verdict=${l.verdict} conf=${l.confidence}`)
    console.log(`  reasoning: ${l.reasoning?.slice(0,200)}`)
  }
}
