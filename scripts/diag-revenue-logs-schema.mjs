// Inspect revenue_logs columns and sample row
import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

const { data, error } = await db
  .from('revenue_logs')
  .select('*')
  .eq('business_id', VERO)
  .gte('revenue_date', '2026-05-01')
  .order('revenue_date', { ascending: false })
  .limit(3)

if (error) { console.error(error.message); process.exit(1) }
for (const r of data ?? []) {
  console.log(JSON.stringify(r, null, 2))
  console.log('---')
}
