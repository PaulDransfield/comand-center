import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const APPLY = process.argv.includes('--apply')

// Repoint alias 00b80bd8 from archived FRYST → unarchived canonical
const ALIAS_ID    = '00b80bd8-1ea3-474b-abe2-72ddb775870f'
const TARGET_PROD = '5bc4a519-208d-47e5-a414-f73f667843f2'

const { data: a } = await db.from('product_aliases').select('id, product_id').eq('id', ALIAS_ID)
console.log(`Before: ${JSON.stringify(a)}`)
if (!APPLY) { console.log('(DRY)'); process.exit(0) }

const { error } = await db.from('product_aliases').update({ product_id: TARGET_PROD }).eq('id', ALIAS_ID)
if (error) { console.error(error.message); process.exit(1) }
const { data: a2 } = await db.from('product_aliases').select('id, product_id').eq('id', ALIAS_ID)
console.log(`After:  ${JSON.stringify(a2)}`)
