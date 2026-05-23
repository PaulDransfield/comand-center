import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// What tracker_data rows does Chicce have, with their bank_accounts shape?
const { data: rows } = await db
  .from('tracker_data')
  .select('period_year, period_month, bank_net_change, bank_accounts, is_provisional')
  .eq('business_id', bizId)
  .not('bank_net_change', 'is', null)
  .order('period_year', { ascending: true })
  .order('period_month', { ascending: true })

console.log(`tracker_data rows with bank_net_change: ${rows?.length ?? 0}`)
for (const r of rows ?? []) {
  console.log(`  ${r.period_year}-${String(r.period_month).padStart(2,'0')}  net=${r.bank_net_change}  accounts=${r.bank_accounts ? JSON.stringify(r.bank_accounts).slice(0, 100) : 'null'}`)
}

// Get the accountsSeen set
const accountsSeen = new Set()
for (const r of rows ?? []) {
  if (r.bank_accounts) for (const a of Object.keys(r.bank_accounts)) accountsSeen.add(Number(a))
}
console.log(`\naccountsSeen from tracker_data: [${[...accountsSeen].sort().join(', ')}]`)

// Cached per-account balances
const { data: cached } = await db
  .from('overhead_drilldown_cache')
  .select('category, payload')
  .eq('business_id', bizId)
  .like('category', '__bank_balance_v2_%')
console.log(`\nCached per-account balances: ${cached?.length ?? 0}`)
let sumCurrent = 0
for (const r of cached ?? []) {
  const p = r.payload
  const acc = Number(p.account)
  if (acc >= 1900 && acc <= 1989) {
    console.log(`  ${acc} ${p.description.slice(0, 25).padEnd(28)} opening=${String(p.opening_balance).padStart(10)} current=${String(p.current_balance).padStart(10)}`)
    sumCurrent += Number(p.current_balance ?? 0)
  }
}
console.log(`\nSum of current balances on 1900-1989: ${sumCurrent}`)
