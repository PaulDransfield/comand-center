// scripts/diag-vero-weather-signal.mjs
//
// Is the weather lift signal actually firing for Vero? Check three things:
//   1. Does weather_daily have rows for recent Vero dates?
//   2. Does it have historical rows (to compute bucket lifts)?
//   3. For a recent forecast, does the bucket subset have enough samples?

import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

const { count: total } = await db.from('weather_daily').select('*', { count: 'exact', head: true }).eq('business_id', VERO)
const { data: latest } = await db.from('weather_daily').select('date, temp_max, precip_mm, weather_code, summary, is_forecast').eq('business_id', VERO).order('date', { ascending: false }).limit(5)
const { data: earliest } = await db.from('weather_daily').select('date').eq('business_id', VERO).order('date', { ascending: true }).limit(1).maybeSingle()
const { data: forecastRows } = await db.from('weather_daily').select('date').eq('business_id', VERO).eq('is_forecast', true).order('date').limit(20)
const { count: histCount } = await db.from('weather_daily').select('*', { count: 'exact', head: true }).eq('business_id', VERO).eq('is_forecast', false)

console.log()
console.log(`Vero weather_daily total rows:           ${total}`)
console.log(`Vero weather_daily history rows:         ${histCount}`)
console.log(`Earliest weather row:                    ${earliest?.date ?? '—'}`)
console.log()
console.log('Latest 5 weather rows:')
for (const r of latest ?? []) console.log(`  ${r.date}  temp_max ${r.temp_max} precip ${r.precip_mm} code ${r.weather_code} fc=${r.is_forecast} (${r.summary})`)
console.log()
console.log(`Forecast rows (is_forecast=true): ${forecastRows?.length ?? 0}`)
for (const r of (forecastRows ?? []).slice(0, 10)) console.log(`  ${r.date}`)
