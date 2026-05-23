import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Look at cached opening balances
const { data } = await db
  .from('overhead_drilldown_cache')
  .select('period_year, period_month, category, payload, fetched_at')
  .eq('business_id', bizId)
  .like('category', '__bank_balance_v2_%')
  .order('category')
  .range(0, 199)

console.log(`Cached opening balances: ${data?.length}`)
if (data) {
  for (const row of data) {
    const p = row.payload
    console.log(`  ${row.category.padEnd(36)}  open=${String(p?.opening_balance ?? 'null').padStart(12)}  current=${String(p?.current_balance ?? 'null').padStart(12)}  desc="${(p?.description ?? '').slice(0, 30)}"  fy=${p?.fiscal_year_from}/${p?.fiscal_year_to}`)
  }
}
