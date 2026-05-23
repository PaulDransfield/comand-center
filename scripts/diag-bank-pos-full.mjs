// Simulate fetchBankAccountBalances against the production cache exactly.
import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

const accountsSeen = [1910, 1913, 1915, 1916, 1930]
const fyId = 8  // Chicce current FY

// What's the period_year on the cached rows?
const { data: cacheCheck } = await db
  .from('overhead_drilldown_cache')
  .select('category, period_year, period_month, fetched_at, payload')
  .eq('business_id', bizId)
  .in('category', accountsSeen.map(a => `__bank_balance_v2_${a}_fy${fyId}__`))

console.log(`Direct cache check for fy${fyId} keys:`)
for (const r of cacheCheck ?? []) {
  console.log(`  ${r.category}  period_year=${r.period_year}  period_month=${r.period_month}  current=${r.payload?.current_balance}`)
}

// Try the bulk lookup as the route does
const { data: bulkLookup } = await db
  .from('overhead_drilldown_cache')
  .select('category, payload, fetched_at')
  .eq('business_id', bizId)
  .eq('period_year', fyId)
  .eq('period_month', 0)
  .in('category', accountsSeen.map(a => `__bank_balance_v2_${a}_fy${fyId}__`))

console.log(`\nBulk lookup (period_year=${fyId}, period_month=0): ${bulkLookup?.length ?? 0} rows`)
for (const r of bulkLookup ?? []) {
  console.log(`  ${r.category}  current=${r.payload?.current_balance}`)
}

// Also: maybe the cache has period_year=fyId from a DIFFERENT integer
// because fyId was computed differently. List the unique period_year values.
const { data: distinctYears } = await db
  .from('overhead_drilldown_cache')
  .select('period_year, category')
  .eq('business_id', bizId)
  .like('category', '__bank_balance_v2_%')
const uniqYears = new Set(distinctYears?.map(r => r.period_year))
console.log(`\nDistinct period_year values on bank_balance_v2 rows: [${[...uniqYears].join(', ')}]`)
