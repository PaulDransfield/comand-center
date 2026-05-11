// Inspect what the bank-position endpoint actually computed for Vero.
// Reads the opening-balance cache that fetchBankAccountBalances writes.

import { readFileSync } from 'node:fs'
function parseEnv(p){try{return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))}catch{return{}}}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

const r = await fetch(`${URL}/rest/v1/overhead_drilldown_cache?business_id=eq.${VERO}&category=like.__bank_opening_*&select=period_year,category,payload,fetched_at&order=category`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
})
const rows = await r.json()
console.log(`bank-opening cache rows for Vero: ${rows.length}\n`)
for (const c of rows) {
  console.log(`  cache key: ${c.category}  (fyId=${c.period_year}, fetched ${c.fetched_at})`)
  console.log(`  payload: ${JSON.stringify(c.payload, null, 2)}`)
  console.log()
}

// Sum of opening balances per scope of fetch
let openSum = 0
for (const c of rows) openSum += Number(c.payload?.opening_balance ?? 0)
console.log(`Opening balance SUM across all cached bank accounts: ${openSum.toLocaleString('sv-SE')} kr\n`)

// 2026 net change from tracker_data
const td = await fetch(`${URL}/rest/v1/tracker_data?business_id=eq.${VERO}&period_year=eq.2026&bank_net_change=not.is.null&select=period_month,bank_net_change&order=period_month`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
}).then(r => r.json())
const ytdNet = td.reduce((s, m) => s + Number(m.bank_net_change ?? 0), 0)
console.log(`2026 YTD net change (Jan-May): ${ytdNet.toLocaleString('sv-SE')} kr`)
console.log(`per month:`)
for (const m of td) console.log(`  2026-${String(m.period_month).padStart(2,'0')}: ${Number(m.bank_net_change ?? 0).toLocaleString('sv-SE')} kr`)
console.log()

console.log(`Computed absolute = opening (${openSum.toLocaleString('sv-SE')}) + ytd (${ytdNet.toLocaleString('sv-SE')}) = ${(openSum + ytdNet).toLocaleString('sv-SE')} kr`)
