// Single clean balance sheet replay with proper pagination.
import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Use MONTHLY pagination matching voucher-cache.ts readCachedMonths
const months = []
for (const ym of ['2025-09','2025-10','2025-11','2025-12','2026-01','2026-02','2026-03','2026-04']) {
  const [y, m] = ym.split('-').map(Number)
  let from = 0
  while (true) {
    const { data } = await db
      .from('fortnox_vouchers_cache')
      .select('rows, transaction_date')
      .eq('business_id', bizId)
      .eq('period_year', y)
      .eq('period_month', m)
      .order('transaction_date', { ascending: true })
      .range(from, from + 999)
    if (!data || data.length === 0) break
    months.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
}
console.log(`Total vouchers (monthly paginated, ordered): ${months.length}`)

const acc = new Map()
for (const v of months) {
  for (const r of (v.rows ?? [])) {
    if (r.Removed) continue
    const n = Number(r.Account)
    if (!Number.isFinite(n)) continue
    if (!acc.has(n)) acc.set(n, { d: 0, c: 0 })
    const e = acc.get(n)
    e.d += Number(r.Debit) || 0
    e.c += Number(r.Credit) || 0
  }
}

let assetD = 0, eqD = 0, ltD = 0, curD = 0, plD = 0
for (const [n, e] of acc) {
  const d = e.d - e.c
  if      (n >= 1000 && n <= 1999) assetD += d
  else if (n >= 2000 && n <= 2199) eqD    += d
  else if (n >= 2200 && n <= 2399) ltD    += d
  else if (n >= 2400 && n <= 2999) curD   += d
  else                              plD    += d
}
console.log(`asset Δ:   ${assetD.toFixed(2)}`)
console.log(`equity Δ:  ${eqD.toFixed(2)}`)
console.log(`ltliab Δ:  ${ltD.toFixed(2)}`)
console.log(`curliab Δ: ${curD.toFixed(2)}`)
console.log(`pl Δ:      ${plD.toFixed(2)}`)
console.log(`TOTAL:     ${(assetD + eqD + ltD + curD + plD).toFixed(2)}  ← must be 0`)

// Now do balance sheet with fy8 IBs
const { data: fy8 } = await db.from('overhead_drilldown_cache').select('payload').eq('business_id', bizId).eq('category', '__accounts_list_fy8__').maybeSingle()
const openings = {}
for (const a of Object.values(fy8.payload.accounts)) openings[a.number] = Number(a.opening_balance ?? 0)

let ibA = 0, ibE = 0, ibL = 0
for (const [n, ob] of Object.entries(openings)) {
  const num = Number(n)
  if      (num >= 1000 && num <= 1999) ibA += ob
  else if (num >= 2000 && num <= 2199) ibE += ob
  else if (num >= 2200 && num <= 2999) ibL += ob
}
console.log(`\nIBs (fy8):  asset=${ibA}  equity=${ibE}  liab=${ibL}  sum=${ibA+ibE+ibL}`)

const assetsTotal = ibA + assetD
const eqTotal     = -(ibE + eqD) + (-plD)   // flip equity, add YTD = -plDelta
const liabTotal   = -(ibL + ltD + curD)
const imbalance   = assetsTotal - (eqTotal + liabTotal)
console.log(`\nAssets:   ${assetsTotal.toFixed(2)}`)
console.log(`Equity:   ${eqTotal.toFixed(2)}  (incl YTD ${(-plD).toFixed(2)})`)
console.log(`Liab:     ${liabTotal.toFixed(2)}`)
console.log(`Imbalance: ${imbalance.toFixed(2)}  ← should be ~0`)
