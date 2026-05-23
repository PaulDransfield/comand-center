// Verify the new balance-sheet logic against Chicce Feb 2026.
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Pull Chicce's full FY vouchers
const { data: vouchers } = await db
  .from('fortnox_vouchers_cache')
  .select('transaction_date, rows')
  .eq('business_id', bizId)
  .gte('transaction_date', '2025-09-01')
  .lte('transaction_date', '2026-02-28')
  .order('transaction_date', { ascending: true })
  .range(0, 9999)

console.log(`FY-to-Feb-end vouchers: ${vouchers.length}`)

// Accumulate (debit, credit) per account
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

// Pull cached opening balances from overhead_drilldown_cache
const { data: obRows } = await db
  .from('overhead_drilldown_cache')
  .select('category, payload')
  .eq('business_id', bizId)
  .like('category', '__bank_balance_v2_%')

const openings = new Map()
for (const r of obRows ?? []) {
  const p = r.payload
  if (!p) continue
  openings.set(p.account, Math.round(Number(p.opening_balance ?? 0)))
}

// Compute closing for 1xxx-2xxx using opening + delta
let totAssets = 0, totEquity = 0, totLiabLT = 0, totLiabCur = 0, totalIBSum = 0
const allKeys = new Set([...acc.keys(), ...openings.keys()])
console.log('\n── Closing balance per balance-sheet account ──')
for (const n of [...allKeys].sort((a,b)=>a-b)) {
  let cls
  if (n >= 1000 && n <= 1999) cls = 'asset'
  else if (n >= 2000 && n <= 2199) cls = 'equity'
  else if (n >= 2200 && n <= 2399) cls = 'ltliab'
  else if (n >= 2400 && n <= 2999) cls = 'curliab'
  else continue
  const e = acc.get(n) ?? { debit: 0, credit: 0 }
  const opening = openings.get(n) ?? 0
  const closing = opening + (e.debit - e.credit)
  totalIBSum += opening
  if (Math.abs(closing) < 0.5) continue
  console.log(`  ${n}  ${cls.padEnd(7)}  IB=${opening.toString().padStart(11)}  Δ=${(e.debit-e.credit).toString().padStart(11)}  UB=${closing.toString().padStart(11)}`)
  if      (cls === 'asset')   totAssets += closing
  else if (cls === 'equity')  totEquity += -closing  // flip for display
  else if (cls === 'ltliab')  totLiabLT += -closing
  else if (cls === 'curliab') totLiabCur += -closing
}

let ytd = 0
for (const [n, e] of acc.entries()) {
  if (n >= 3000 && n <= 8999) ytd += -(e.debit - e.credit)
}

console.log('\n── Totals ──')
console.log(`Assets:         ${totAssets.toFixed(2)}`)
console.log(`Equity:         ${totEquity.toFixed(2)}`)
console.log(`Long-term liab: ${totLiabLT.toFixed(2)}`)
console.log(`Current liab:   ${totLiabCur.toFixed(2)}`)
console.log(`YTD result:     ${ytd.toFixed(2)}`)
console.log(`Equity+Liab+YTD: ${(totEquity + totLiabLT + totLiabCur + ytd).toFixed(2)}`)
console.log(`Imbalance:      ${(totAssets - (totEquity + totLiabLT + totLiabCur + ytd)).toFixed(2)}`)
console.log(`\nSum of all IBs (1xxx-2xxx): ${totalIBSum} — should be ~0 if Fortnox IB is clean`)
