import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local', 'utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const { data, error } = await db.from('products').select('id, name, pack_size, base_unit, invoice_unit, archived_at').ilike('name', '%olja rapsolja%').eq('business_id', '63ada0ac-18af-406a-8ad3-4acfd0379f2c')
console.log(JSON.stringify({ error, data }, null, 2))
