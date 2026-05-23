import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Pull all 2026 vouchers
const { data: vouchers, error } = await db
  .from('fortnox_vouchers_cache')
  .select('voucher_series, voucher_number, transaction_date, rows')
  .eq('business_id', bizId)
  .gte('transaction_date', '2026-01-01')
  .lte('transaction_date', '2026-12-31')
  .order('transaction_date', { ascending: true })
  .range(0, 1999)
if (error) { console.error(error); process.exit(1) }
console.log(`Pulled ${vouchers.length} vouchers (2026 YTD)\n`)

// Group by month
const months = {}
for (const v of vouchers) {
  const m = String(v.transaction_date).slice(0, 7)
  months[m] = (months[m] ?? 0) + 1
}
console.log('Vouchers per month:', months)

// Aggregate accounts (whole year)
const accAll = new Map()
const accFeb = new Map()
for (const v of vouchers) {
  const inFeb = String(v.transaction_date).startsWith('2026-02')
  for (const r of (v.rows ?? [])) {
    if (r.Removed) continue
    const n = Number(r.Account)
    if (!Number.isFinite(n)) continue
    for (const map of inFeb ? [accAll, accFeb] : [accAll]) {
      if (!map.has(n)) map.set(n, { debit: 0, credit: 0, desc: r.AccountDescription ?? '' })
      const e = map.get(n)
      e.debit  += Number(r.Debit)  || 0
      e.credit += Number(r.Credit) || 0
    }
  }
}

const print = (map, label) => {
  console.log(`\n══ ${label} ══`)
  const entries = [...map.entries()].sort((a, b) => a[0] - b[0])
  let curClass = -1
  for (const [n, e] of entries) {
    const cls = Math.floor(n / 1000) * 1000
    if (cls !== curClass) {
      console.log(`\n── ${cls}xxx ──`)
      curClass = cls
    }
    const net = e.debit - e.credit
    if (Math.abs(net) < 1 && Math.abs(e.debit) < 1 && Math.abs(e.credit) < 1) continue
    console.log(`  ${n}  ${(e.desc || '').slice(0, 40).padEnd(42)}  D=${e.debit.toFixed(0).padStart(12)}  C=${e.credit.toFixed(0).padStart(12)}  net=${(net >= 0 ? '+' : '−')}${Math.abs(net).toFixed(0).padStart(11)}`)
  }
}

print(accAll, 'WHOLE YEAR 2026 (Jan-Feb so far)')
// print(accFeb, 'FEBRUARY 2026 ONLY')

// VAT summary
const vatLine = (range, label) => {
  let cred = 0, deb = 0
  for (const [n, e] of accAll.entries()) {
    if (n >= range[0] && n <= range[1]) { cred += e.credit; deb += e.debit }
  }
  return `${label.padEnd(40)}  Σdebit=${deb.toFixed(2).padStart(15)}  Σcredit=${cred.toFixed(2).padStart(15)}  net=${(cred-deb).toFixed(2).padStart(15)}`
}

console.log('\n══ VAT + REVENUE SUMMARY (2026 YTD) ══')
console.log(vatLine([3000, 3999], 'All revenue 3xxx'))
console.log(vatLine([2610, 2619], 'Output VAT 2610-2619'))
console.log(vatLine([2620, 2629], 'Output VAT 2620-2629 (12%)'))
console.log(vatLine([2630, 2639], 'Output VAT 2630-2639 (6%)'))
console.log(vatLine([2640, 2649], 'Input  VAT 2640-2649'))
console.log(vatLine([2650, 2659], 'Moms-rapport 2650 (settlement)'))
