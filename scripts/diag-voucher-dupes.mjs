import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const k = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, k, { auth: { persistSession: false } })
const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

const { data: rows } = await db
  .from('fortnox_vouchers_cache')
  .select('voucher_series, voucher_number, transaction_date, period_year, period_month, rows')
  .eq('business_id', bizId)
  .gte('transaction_date', '2025-09-01')
  .lte('transaction_date', '2026-08-31')
  .range(0, 9999)

console.log(`Total rows: ${rows?.length}`)
const counts = new Map()
for (const r of rows ?? []) {
  const id = `${r.period_year}_${r.voucher_series}_${r.voucher_number}`
  counts.set(id, (counts.get(id) ?? 0) + 1)
}
const dupes = [...counts].filter(([_, c]) => c > 1)
console.log(`Unique keys: ${counts.size}, dupes: ${dupes.length}`)

// Dedup'd 1915 sum
const seen = new Set()
let d = 0, c = 0
for (const v of rows ?? []) {
  const id = `${v.period_year}_${v.voucher_series}_${v.voucher_number}`
  if (seen.has(id)) continue
  seen.add(id)
  for (const r of v.rows ?? []) {
    if (r.Removed) continue
    if (Number(r.Account) !== 1915) continue
    d += Number(r.Debit ?? 0)
    c += Number(r.Credit ?? 0)
  }
}
console.log(`1915 dedup'd: debit=${d.toFixed(2)} credit=${c.toFixed(2)} net=${(d-c).toFixed(2)}`)
