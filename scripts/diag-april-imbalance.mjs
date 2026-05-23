// Why does Chicce April 2026 balance sheet show -313,635 imbalance
// when the IB sum is clean?
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Pull vouchers Sept 1, 2025 -> April 30, 2026 (8 months)
let allVouchers = []
let from = 0
while (true) {
  const { data } = await db
    .from('fortnox_vouchers_cache')
    .select('voucher_series, voucher_number, transaction_date, rows')
    .eq('business_id', bizId)
    .gte('transaction_date', '2025-09-01')
    .lte('transaction_date', '2026-04-30')
    .order('transaction_date', { ascending: true })
    .range(from, from + 999)
  if (!data || data.length === 0) break
  allVouchers.push(...data)
  if (data.length < 1000) break
  from += 1000
}
console.log(`Pulled ${allVouchers.length} vouchers Sept 2025 → April 2026\n`)

// Check 1: per-voucher debit = credit
let unbalanced = 0
let totalDebit = 0, totalCredit = 0
for (const v of allVouchers) {
  let d = 0, c = 0
  for (const r of (v.rows ?? [])) {
    if (r.Removed) continue
    d += Number(r.Debit) || 0
    c += Number(r.Credit) || 0
  }
  totalDebit += d
  totalCredit += c
  if (Math.abs(d - c) > 0.5) {
    unbalanced++
    if (unbalanced <= 3) {
      console.log(`UNBALANCED voucher ${v.voucher_series}/${v.voucher_number} on ${v.transaction_date}: D=${d.toFixed(2)} C=${c.toFixed(2)} diff=${(d-c).toFixed(2)}`)
    }
  }
}
console.log(`\nUnbalanced vouchers: ${unbalanced} / ${allVouchers.length}`)
console.log(`Total debit:  ${totalDebit.toFixed(2)}`)
console.log(`Total credit: ${totalCredit.toFixed(2)}`)
console.log(`Σ (debit - credit) over all vouchers: ${(totalDebit - totalCredit).toFixed(2)}`)

// Sum delta per account class
const sumByClass = { asset: 0, equity: 0, ltliab: 0, curliab: 0, pl: 0, other: 0 }
const allAccounts = new Map()
for (const v of allVouchers) {
  for (const r of (v.rows ?? [])) {
    if (r.Removed) continue
    const n = Number(r.Account)
    if (!Number.isFinite(n)) continue
    const d = Number(r.Debit) || 0
    const c = Number(r.Credit) || 0
    if (!allAccounts.has(n)) allAccounts.set(n, { d: 0, c: 0 })
    const e = allAccounts.get(n)
    e.d += d; e.c += c
    let cls
    if (n >= 1000 && n <= 1999) cls = 'asset'
    else if (n >= 2000 && n <= 2199) cls = 'equity'
    else if (n >= 2200 && n <= 2399) cls = 'ltliab'
    else if (n >= 2400 && n <= 2999) cls = 'curliab'
    else if (n >= 3000 && n <= 8999) cls = 'pl'
    else cls = 'other'
    sumByClass[cls] += d - c
  }
}
console.log(`\n── Σ (debit - credit) per account class ──`)
for (const [k, v] of Object.entries(sumByClass)) {
  console.log(`  ${k.padEnd(8)}: ${v.toFixed(2)}`)
}
console.log(`  TOTAL:    ${Object.values(sumByClass).reduce((a,b)=>a+b,0).toFixed(2)}`)
console.log(`\nIf TOTAL ≠ 0, vouchers are unbalanced in the cache.`)
console.log(`If 'other' bucket has activity, accounts are outside 1000-8999 (e.g. 9xxx).`)
