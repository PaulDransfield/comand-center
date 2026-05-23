import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

const { error, count } = await db
  .from('overhead_drilldown_cache')
  .delete({ count: 'exact' })
  .eq('business_id', bizId)
  .like('category', '__recent_invoices_%')
console.log(`Deleted recent_invoices cache rows: ${count}, error: ${error?.message ?? 'none'}`)
