import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Show what we're about to delete
const { data: before } = await db
  .from('overhead_drilldown_cache')
  .select('category, fetched_at')
  .eq('business_id', bizId)
  .like('category', '__accounts_list_fy%')
  .order('fetched_at', { ascending: false })
console.log('Cache rows before:')
for (const r of before ?? []) console.log(`  ${r.category}  ${r.fetched_at}`)

// Delete
const { error } = await db
  .from('overhead_drilldown_cache')
  .delete()
  .eq('business_id', bizId)
  .like('category', '__accounts_list_fy%')
if (error) console.error('delete error:', error)
else console.log('\nDeleted accounts_list cache entries. Production will re-fetch on next request.')
