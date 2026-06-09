import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

// Cron run log for the new weather-sync
const { data: cronRows } = await db
  .from('cron_run_log')
  .select('cron_name, started_at, finished_at, status, error, meta')
  .eq('cron_name', 'weather-sync')
  .order('started_at', { ascending: false })
  .limit(3)

console.log('weather-sync runs:')
for (const r of cronRows ?? []) {
  console.log(`  ${r.started_at?.slice(0,16)}  status=${r.status}  ${r.error ? 'err='+r.error.slice(0,60) : ''}`)
  if (r.meta) console.log(`    meta:`, JSON.stringify(r.meta).slice(0, 300))
}

// Vero future weather coverage
const today = new Date().toISOString().slice(0, 10)
const { count: futReal } = await db.from('weather_daily').select('*', { count: 'exact', head: true }).eq('business_id', VERO).eq('is_forecast', false).gte('date', today)
const { count: futFc }   = await db.from('weather_daily').select('*', { count: 'exact', head: true }).eq('business_id', VERO).eq('is_forecast', true).gte('date', today)
const { data: futLatest } = await db.from('weather_daily').select('date, temp_max, weather_code, summary, is_forecast').eq('business_id', VERO).gte('date', today).order('date').limit(20)

console.log()
console.log(`Vero future weather rows (>= ${today}):  observed=${futReal}  forecast=${futFc}`)
console.log('Future days covered:')
for (const r of futLatest ?? []) console.log(`  ${r.date}  ${r.temp_max}°  ${r.summary}  fc=${r.is_forecast}`)
