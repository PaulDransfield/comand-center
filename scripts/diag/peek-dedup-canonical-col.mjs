// Check whether products has a dedupe_canonical_id column populated
// for the archived products from today's dedup, which would let us
// repoint orphan aliases deterministically (no name-matching guess).
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const { data, error } = await db.from('products').select('id, name, archived_at, dedupe_canonical_id').not('archived_at','is',null).gte('archived_at','2026-06-03T00:00:00Z').limit(20)
if (error) { console.log('column missing or query error:', error.message); process.exit(0) }
console.log(`Sample of products archived today: ${data?.length}`)
let withCanonical = 0
for (const p of data ?? []) {
  if (p.dedupe_canonical_id) withCanonical++
  console.log(`  ${p.id.slice(0,8)} "${p.name?.slice(0,40)}"  canonical=${p.dedupe_canonical_id ?? '(none)'}`)
}
console.log(`\nWith dedupe_canonical_id set: ${withCanonical}/${data?.length}`)
