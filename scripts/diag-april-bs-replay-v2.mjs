// Test both fy7 (prior) and fy8 (current) IBs against same vouchers.
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Walk vouchers Sept 1, 2025 → April 30, 2026
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

function cls(n) {
  if (n >= 1000 && n <= 1999) return 'asset'
  if (n >= 2000 && n <= 2199) return 'equity'
  if (n >= 2200 && n <= 2399) return 'ltliab'
  if (n >= 2400 && n <= 2999) return 'curliab'
  return 'pl'
}

// Compute imbalance using a given IB source
function compute(label, openings) {
  let ytd = 0
  let assetsTotal = 0, eqDisp = 0, ltDisp = 0, curDisp = 0
  const allAccs = new Set([...acc.keys(), ...Object.keys(openings).map(Number)])
  const equityLines = []
  for (const n of allAccs) {
    const c = cls(n)
    if (c === 'pl') {
      const e = acc.get(n) ?? { d: 0, c: 0 }
      ytd += -((e.d - e.c))
      continue
    }
    const ob = openings[n] ?? 0
    const e = acc.get(n) ?? { d: 0, c: 0 }
    const closing = ob + (e.d - e.c)
    if (c === 'asset' && Math.abs(closing) >= 0.5) assetsTotal += closing
    else if (c === 'equity') {
      const v = -closing
      if (Math.abs(v) < 0.5) continue
      equityLines.push({ acc: n, amount: v })
    } else if (c === 'ltliab' && Math.abs(-closing) >= 0.5) ltDisp += -closing
    else if (c === 'curliab' && Math.abs(-closing) >= 0.5) curDisp += -closing
  }
  eqDisp = equityLines.reduce((s, l) => s + l.amount, 0)
  const has2099 = equityLines.some(l => l.acc === 2099 || l.acc === 2019)
  if (!has2099 && Math.abs(ytd) > 0.5) eqDisp += ytd
  const eqLiabYtd = eqDisp + ltDisp + curDisp
  const imb = assetsTotal - eqLiabYtd
  console.log(`\n── ${label} ──`)
  console.log(`  assets:    ${assetsTotal.toFixed(2)}`)
  console.log(`  equity:    ${eqDisp.toFixed(2)}  (incl YTD ${ytd.toFixed(2)})`)
  console.log(`  liab:      ${(ltDisp + curDisp).toFixed(2)}`)
  console.log(`  imbalance: ${imb.toFixed(2)}`)
}

// Get fy7 cache
const { data: fy7 } = await db.from('overhead_drilldown_cache').select('payload').eq('business_id', bizId).eq('category', '__accounts_list_fy7__').maybeSingle()
// Get fy8 cache
const { data: fy8 } = await db.from('overhead_drilldown_cache').select('payload').eq('business_id', bizId).eq('category', '__accounts_list_fy8__').maybeSingle()

const obFromCache = (cache) => {
  const out = {}
  for (const a of Object.values(cache.payload.accounts)) out[a.number] = Number(a.opening_balance ?? 0)
  return out
}

if (fy7) compute(`Using fy7 IBs (anchor Sept 1, 2024 — PRIOR FY)`, obFromCache(fy7))
if (fy8) compute(`Using fy8 IBs (anchor Sept 1, 2025 — CURRENT FY)`, obFromCache(fy8))

// Extra: enumerate PL accounts and their deltas to see where YTD comes from.
console.log('\n── PL account deltas (sorted desc by |delta|) ──')
const plDeltas = []
for (const [n, e] of acc) {
  if (n >= 3000 && n <= 8999) {
    plDeltas.push({ n, delta: e.d - e.c })
  }
}
plDeltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
let plSum = 0
for (const p of plDeltas.slice(0, 20)) {
  plSum += p.delta
  console.log(`  ${p.n}: ${p.delta.toFixed(2)}`)
}
const totalPlSum = plDeltas.reduce((s, p) => s + p.delta, 0)
console.log(`  ...`)
console.log(`  Total (all PL accounts): ${totalPlSum.toFixed(2)}`)
console.log(`  Top 20 sum:              ${plSum.toFixed(2)}`)

// What about accounts >=9000?
console.log('\n── 9xxx+ activity ──')
for (const [n, e] of acc) {
  if (n >= 9000) {
    console.log(`  ${n}: d=${e.d.toFixed(2)} c=${e.c.toFixed(2)} delta=${(e.d-e.c).toFixed(2)}`)
  }
}

// Account 2019 / 2099 movement
console.log('\n── 2019/2099/2098 (Årets resultat candidates) ──')
for (const [n, e] of acc) {
  if (n === 2019 || n === 2099 || n === 2098 || n === 2091) {
    console.log(`  ${n}: d=${e.d.toFixed(2)} c=${e.c.toFixed(2)} delta=${(e.d-e.c).toFixed(2)}`)
  }
}
