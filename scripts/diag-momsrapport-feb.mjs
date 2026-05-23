import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

const { data: vouchers } = await db
  .from('fortnox_vouchers_cache')
  .select('transaction_date, rows')
  .eq('business_id', bizId)
  .gte('transaction_date', '2026-02-01')
  .lte('transaction_date', '2026-02-28')
  .range(0, 1999)

console.log(`Feb 2026 vouchers in cache: ${vouchers.length}`)

const acc = new Map()
for (const v of vouchers) {
  for (const r of (v.rows ?? [])) {
    if (r.Removed) continue
    const n = Number(r.Account)
    if (!Number.isFinite(n)) continue
    if (!acc.has(n)) acc.set(n, { debit: 0, credit: 0 })
    const e = acc.get(n)
    e.debit  += Number(r.Debit)  || 0
    e.credit += Number(r.Credit) || 0
  }
}

console.log('\n26xx accounts in Feb 2026:')
for (const [n, e] of [...acc.entries()].sort((a,b)=>a[0]-b[0])) {
  if (n >= 2600 && n <= 2699) {
    console.log(`  ${n}: debit=${e.debit.toFixed(2)} credit=${e.credit.toFixed(2)} net(C-D)=${(e.credit-e.debit).toFixed(2)}`)
  }
}

console.log('\n3xxx accounts in Feb 2026:')
for (const [n, e] of [...acc.entries()].sort((a,b)=>a[0]-b[0])) {
  if (n >= 3000 && n <= 3999) {
    console.log(`  ${n}: debit=${e.debit.toFixed(2)} credit=${e.credit.toFixed(2)} net(C-D)=${(e.credit-e.debit).toFixed(2)}`)
  }
}
