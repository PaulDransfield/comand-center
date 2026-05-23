import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

const { data: row } = await db
  .from('tracker_data')
  .select('*')
  .eq('business_id', bizId)
  .limit(1)
  .maybeSingle()
console.log('Columns on tracker_data row:')
for (const k of Object.keys(row ?? {})) {
  console.log(`  ${k}: ${typeof row[k]} = ${JSON.stringify(row[k]).slice(0, 60)}`)
}

const { count: byDate } = await db.from('tracker_data').select('*', { count: 'exact', head: true })
  .eq('business_id', bizId)
  .gte('period_date', '2025-05-23')
console.log(`\ncount with .gte('period_date', '2025-05-23'): ${byDate}`)

const { count: byYearMonth } = await db.from('tracker_data').select('*', { count: 'exact', head: true })
  .eq('business_id', bizId)
  .gte('period_year', 2025)
console.log(`count with .gte('period_year', 2025): ${byYearMonth}`)
