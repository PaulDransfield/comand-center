import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

const CHICCE = '97187ef3-b816-4c41-9230-7551430784a7'

// Integration row
const { data: integ } = await db
  .from('integrations')
  .select('id, provider, status, business_id, org_id, last_sync_at, last_error, created_at')
  .eq('business_id', CHICCE)
  .eq('provider', 'caspeco')
  .maybeSingle()

console.log('Caspeco integration row for Chicce:')
console.log(integ ? JSON.stringify(integ, null, 2) : '  (none)')

// Any staff_logs rows from caspeco?
const { count: caspecoRows } = await db
  .from('staff_logs')
  .select('*', { count: 'exact', head: true })
  .eq('business_id', CHICCE)
  .like('pk_log_url', 'caspeco-%')
console.log()
console.log(`staff_logs rows with pk_log_url LIKE 'caspeco-%' for Chicce: ${caspecoRows ?? 0}`)

// Recent sync log entries
const { data: recentSync } = await db
  .from('sync_log')
  .select('integration_id, status, started_at, finished_at, summary, error')
  .order('started_at', { ascending: false })
  .limit(5)
console.log()
console.log('Last 5 sync_log rows:')
for (const r of recentSync ?? []) console.log(`  ${r.started_at?.slice(0,16)}  status=${r.status} integ=${r.integration_id?.slice(0,8)}  ${r.error ?? r.summary ?? ''}`)
