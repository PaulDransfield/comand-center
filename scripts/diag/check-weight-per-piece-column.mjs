import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const { data, error } = await db.from('products').select('id, weight_per_piece_g, weight_per_piece_source').limit(1)
if (error) {
  console.log('column missing — M122 NOT applied:', error.message)
} else {
  console.log('column exists — M122 IS applied. Sample row:', data?.[0])
  const { count: nonNull } = await db.from('products').select('*', { count: 'exact', head: true }).not('weight_per_piece_g','is',null)
  console.log(`products with weight_per_piece_g set: ${nonNull}`)
}
