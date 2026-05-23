// Query Fortnox directly for Chicce's fiscal years.
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Trigger the in-app token refresh via the existing endpoint? We don't
// have direct access. Read credentials_enc and use the access_token raw
// for diagnostic only.
const { data: i } = await db
  .from('integrations')
  .select('credentials_enc, encryption_iv')
  .eq('business_id', bizId)
  .eq('provider', 'fortnox')
  .maybeSingle()

// Try server-side helper via dynamic import — won't work due to env, skip.
// Instead just inspect cached accounts list entries by key.

const { data: cacheRows } = await db
  .from('overhead_drilldown_cache')
  .select('category, fetched_at, payload')
  .eq('business_id', bizId)
  .like('category', '__accounts_list_fy%')
  .order('fetched_at', { ascending: false })

console.log(`Cached accounts_list entries: ${cacheRows?.length ?? 0}\n`)
for (const r of cacheRows ?? []) {
  const p = r.payload
  console.log(`  category=${r.category}`)
  console.log(`    fetched: ${r.fetched_at}`)
  console.log(`    fy:      ${p?.fiscal_year_from} → ${p?.fiscal_year_to}  (id=${p?.fiscal_year_id})`)
  console.log(`    total:   ${p?.total_accounts} accounts`)
  console.log('')
}

// Also check bank balance cache (legacy per-account)
const { data: bbRows } = await db
  .from('overhead_drilldown_cache')
  .select('category, payload')
  .eq('business_id', bizId)
  .like('category', '__bank_balance_v2_%')
  .limit(3)
console.log(`Sample per-account balance cache:`)
for (const r of bbRows ?? []) {
  const p = r.payload
  console.log(`  ${r.category}  fy=${p?.fiscal_year_from}→${p?.fiscal_year_to} open=${p?.opening_balance} cur=${p?.current_balance}`)
}
