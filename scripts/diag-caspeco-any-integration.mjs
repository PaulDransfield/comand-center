import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

const { data: integs } = await db
  .from('integrations')
  .select('id, provider, business_id, org_id, status, last_sync_at, last_error, created_at, metadata')
  .eq('provider', 'caspeco')
  .order('created_at', { ascending: false })

console.log(`Total caspeco integrations in DB: ${integs?.length ?? 0}`)
for (const i of integs ?? []) console.log(JSON.stringify(i, null, 2))
