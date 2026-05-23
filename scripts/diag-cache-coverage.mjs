import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Count via count(*) to bypass row-limits
const months = {}
for (let y = 2025; y <= 2026; y++) {
  for (let m = 1; m <= 12; m++) {
    const { count } = await db
      .from('fortnox_vouchers_cache')
      .select('*', { count: 'exact', head: true })
      .eq('business_id', bizId)
      .eq('period_year', y)
      .eq('period_month', m)
    if (count > 0) {
      months[`${y}-${String(m).padStart(2, '0')}`] = count
    }
  }
}
const keys = Object.keys(months).sort()
console.log('Vouchers in cache (per period_year/period_month):')
for (const k of keys) console.log(`  ${k}: ${months[k]} vouchers`)

const expected = ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05']
console.log('\nFor FY 2025-09 → 2026-08 the picture:')
for (const m of expected) {
  console.log(`  ${m}: ${months[m] ? `${months[m]} ✓` : '✗ MISSING'}`)
}
