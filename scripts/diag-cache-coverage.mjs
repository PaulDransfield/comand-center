import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Count cached vouchers per month
const { data, error } = await db
  .from('fortnox_vouchers_cache')
  .select('transaction_date')
  .eq('business_id', bizId)
  .gte('transaction_date', '2025-09-01')
  .lte('transaction_date', '2026-08-31')
  .range(0, 4999)

if (error) { console.error(error); process.exit(1) }
const months = {}
for (const r of data) {
  const m = String(r.transaction_date).slice(0, 7)
  months[m] = (months[m] ?? 0) + 1
}

console.log('Vouchers in cache for Chicce FY 2025-09 → 2026-08:')
const keys = Object.keys(months).sort()
for (const k of keys) {
  console.log(`  ${k}: ${months[k]} vouchers`)
}
console.log(`\nMissing months (Sept-Dec 2025 + March 2026):`)
const expected = ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05']
for (const m of expected) {
  if (!months[m]) console.log(`  ${m}: ✗ not in cache`)
}
