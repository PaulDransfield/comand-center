// Replicate computeBalanceSheet logic locally against production data.
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Read the cached accounts list payload
const { data: alRow } = await db
  .from('overhead_drilldown_cache')
  .select('payload')
  .eq('business_id', bizId)
  .like('category', '__accounts_list_fy%')
  .order('fetched_at', { ascending: false })
  .limit(1)
  .maybeSingle()

const al = alRow?.payload
if (!al) { console.error('no cached accounts list'); process.exit(1) }
console.log(`accounts list: ${al.total_accounts} accounts, FY ${al.fiscal_year_from} → ${al.fiscal_year_to}`)

// Build openings map
const openings = {}
for (const a of Object.values(al.accounts)) {
  openings[a.number] = Number(a.opening_balance ?? 0)
}

// IB sums by class
let ibAsset = 0, ibEq = 0, ibLT = 0, ibCur = 0
for (const [accStr, ob] of Object.entries(openings)) {
  const n = Number(accStr)
  if      (n >= 1000 && n <= 1999) ibAsset += ob
  else if (n >= 2000 && n <= 2199) ibEq    += ob
  else if (n >= 2200 && n <= 2399) ibLT    += ob
  else if (n >= 2400 && n <= 2999) ibCur   += ob
}
console.log(`IB sums:  asset=${ibAsset}  equity=${ibEq}  ltliab=${ibLT}  curliab=${ibCur}`)
console.log(`Σ IB across BS accounts: ${(ibAsset + ibEq + ibLT + ibCur).toFixed(2)}`)

// Walk vouchers Sept 1 → April 30
let all = []
let from = 0
while (true) {
  const { data } = await db
    .from('fortnox_vouchers_cache')
    .select('rows')
    .eq('business_id', bizId)
    .gte('transaction_date', '2025-09-01')
    .lte('transaction_date', '2026-04-30')
    .range(from, from + 999)
  if (!data || data.length === 0) break
  all.push(...data)
  if (data.length < 1000) break
  from += 1000
}
console.log(`vouchers: ${all.length}`)

const acc = new Map()
for (const v of all) {
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

// Compute closing per account, mirror computeBalanceSheet
function cls(n) {
  if (n >= 1000 && n <= 1999) return 'asset'
  if (n >= 2000 && n <= 2199) return 'equity'
  if (n >= 2200 && n <= 2399) return 'ltliab'
  if (n >= 2400 && n <= 2999) return 'curliab'
  return 'pl'
}

const closingByAcc = new Map()
const allAccs = new Set([...acc.keys(), ...Object.keys(openings).map(Number)])
let ytdResult = 0
for (const n of allAccs) {
  const c = cls(n)
  if (c === 'pl') {
    const e = acc.get(n) ?? { d: 0, c: 0 }
    ytdResult += -((e.d - e.c))
    continue
  }
  const opening = openings[n] ?? 0
  const e = acc.get(n) ?? { d: 0, c: 0 }
  closingByAcc.set(n, opening + (e.d - e.c))
}

console.log(`\nYTD result: ${ytdResult.toFixed(2)}`)

// Section totals (mirror computeBalanceSheet exactly)
let assetsTotal = 0
const equityLines = []
let ltTotal = 0, curTotal = 0
for (const [n, closing] of closingByAcc) {
  const c = cls(n)
  if (c === 'asset') {
    if (Math.abs(closing) < 0.5) continue
    assetsTotal += closing
  } else if (c === 'equity') {
    const v = -closing
    if (Math.abs(v) < 0.5) continue
    equityLines.push({ acc: n, amount: v })
  } else if (c === 'ltliab') {
    const v = -closing
    if (Math.abs(v) < 0.5) continue
    ltTotal += v
  } else if (c === 'curliab') {
    const v = -closing
    if (Math.abs(v) < 0.5) continue
    curTotal += v
  }
}

let equityTotal = equityLines.reduce((s, l) => s + l.amount, 0)
const has2099 = equityLines.some(l => l.acc === 2099 || l.acc === 2019)
if (!has2099 && Math.abs(ytdResult) > 0.5) {
  equityTotal += ytdResult
}

const liabTotal = ltTotal + curTotal
const eqLiabYtd = equityTotal + liabTotal
const imbalance = assetsTotal - eqLiabYtd

console.log(`\n── BALANCE SHEET (April 30, 2026) ──`)
console.log(`Assets total:        ${assetsTotal.toFixed(2)}`)
console.log(`Equity displayed:    ${equityTotal.toFixed(2)}`)
console.log(`  (incl. YTD result line: ${ytdResult.toFixed(2)})`)
console.log(`  Has 2099/2019 in vouchers? ${has2099}`)
console.log(`Liabilities total:   ${liabTotal.toFixed(2)}`)
console.log(`(EQ + LIAB) total:   ${eqLiabYtd.toFixed(2)}`)
console.log(`IMBALANCE:           ${imbalance.toFixed(2)}`)

// Show equity lines so we can see what's in 2099/2019/etc
console.log(`\nEquity lines (after flip):`)
for (const l of equityLines.sort((a,b)=>a.acc-b.acc)) {
  console.log(`  ${l.acc}: ${l.amount.toFixed(2)}`)
}

// Diagnose: what's the IB of P&L accounts?
let ibPl = 0
for (const [accStr, ob] of Object.entries(openings)) {
  const n = Number(accStr)
  if (n >= 3000 && n <= 8999 && Math.abs(ob) > 0.5) {
    ibPl += ob
    console.log(`\nP&L account with IB: ${n} = ${ob}`)
  }
}
console.log(`\nΣ P&L account IBs: ${ibPl.toFixed(2)}  ← should be 0 in clean Fortnox`)
