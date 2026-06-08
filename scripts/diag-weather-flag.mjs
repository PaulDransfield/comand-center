import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const today = '2026-06-08'
const { count: pastReal } = await db.from('weather_daily').select('*', { count: 'exact', head: true }).eq('business_id', VERO).eq('is_forecast', false).lt('date', today)
const { count: pastFc }   = await db.from('weather_daily').select('*', { count: 'exact', head: true }).eq('business_id', VERO).eq('is_forecast', true).lt('date', today)
const { count: futReal }  = await db.from('weather_daily').select('*', { count: 'exact', head: true }).eq('business_id', VERO).eq('is_forecast', false).gte('date', today)
const { count: futFc }    = await db.from('weather_daily').select('*', { count: 'exact', head: true }).eq('business_id', VERO).eq('is_forecast', true).gte('date', today)
console.log(`Past (< ${today})        is_forecast=false: ${pastReal}   true: ${pastFc}`)
console.log(`Future (>= ${today})     is_forecast=false: ${futReal}    true: ${futFc}`)
console.log(`(past rows should be false=observed; future rows should be true=forecast)`)
