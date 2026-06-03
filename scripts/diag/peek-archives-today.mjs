import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const { data } = await db.from('products').select('id, name, archived_at').gte('archived_at', '2026-06-03T15:00:00Z').order('archived_at', { ascending: false })
console.log(`Archived since 15:00 UTC today: ${data?.length}`)
for (const p of data ?? []) console.log(`  ${String(p.archived_at).slice(11,19)}  ${p.id.slice(0,8)}  "${p.name}"`)
