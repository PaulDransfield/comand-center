import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

const { data: row } = await db
  .from('overhead_drilldown_cache')
  .select('payload')
  .eq('business_id', bizId)
  .eq('category', '__accounts_list_fy8__')
  .maybeSingle()

const accounts = row?.payload?.accounts ?? {}
console.log('1900-1989 accounts from accounts_list cache (opening + current):')
let openSum = 0, curSum = 0, nonZeroOpen = 0
for (const a of Object.values(accounts)) {
  if (a.number < 1900 || a.number > 1989) continue
  const open = Number(a.opening_balance ?? 0)
  const cur  = Number(a.current_balance ?? 0)
  if (open !== 0 || cur !== 0) {
    console.log(`  ${a.number} ${(a.description||'').slice(0,30).padEnd(32)} open=${String(open).padStart(10)} current=${String(cur).padStart(10)}`)
    nonZeroOpen++
  }
  openSum += open
  curSum  += cur
}
console.log(`\nNon-zero accounts: ${nonZeroOpen}`)
console.log(`Σ opening: ${openSum}`)
console.log(`Σ current: ${curSum}`)

// Sum voucher delta for 1900-1989 from FY start to today
const { data: vouchers } = await db
  .from('fortnox_vouchers_cache')
  .select('rows')
  .eq('business_id', bizId)
  .gte('transaction_date', '2025-09-01')
  .lte('transaction_date', '2026-08-31')
  .range(0, 9999)

const deltaByAcc = new Map()
for (const v of vouchers ?? []) {
  for (const r of v.rows ?? []) {
    if (r.Removed) continue
    const n = Number(r.Account)
    if (n < 1900 || n > 1989) continue
    const d = Number(r.Debit ?? 0) - Number(r.Credit ?? 0)
    deltaByAcc.set(n, (deltaByAcc.get(n) ?? 0) + d)
  }
}
console.log('\nVoucher delta (debit - credit) per 19xx account from FY start to today:')
let deltaSum = 0
for (const [n, d] of [...deltaByAcc].sort((a,b) => a[0]-b[0])) {
  deltaSum += d
  const open = Number(accounts[n]?.opening_balance ?? 0)
  const closing = open + d
  console.log(`  ${n} open=${String(open).padStart(10)} Δ=${String(d.toFixed(0)).padStart(10)} closing=${String(closing.toFixed(0)).padStart(10)}`)
}
console.log(`\nΣ delta: ${deltaSum.toFixed(2)}`)
console.log(`Computed cash position (opening + delta): ${(openSum + deltaSum).toFixed(2)}`)
