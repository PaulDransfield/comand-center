import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local', 'utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const names = ['Kalamansi', 'Olio e.v.o.', 'Olja Rapsolja', 'Creme Fraiche', 'Citronjuice']
for (const n of names) {
  const { data } = await db.from('products').select('id, name, pack_size, base_unit, density_g_per_ml, density_source').ilike('name', `%${n}%`).eq('business_id', '63ada0ac-18af-406a-8ad3-4acfd0379f2c')
  for (const p of data ?? []) {
    console.log(`${p.name.padEnd(45)} pack=${p.pack_size} ${p.base_unit}  density=${p.density_g_per_ml} (${p.density_source})`)
  }
}
