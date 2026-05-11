import { readFileSync } from 'node:fs'
function parseEnv(p){try{return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))}catch{return{}}}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

const resp = await fetch(`${URL}/rest/v1/tracker_data?business_id=eq.${VERO}&bank_net_change=not.is.null&select=period_year,period_month,bank_net_change,bank_accounts,source,created_via&order=period_year,period_month`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
})
const text = await resp.text()
if (!resp.ok) { console.error('query failed:', resp.status, text); process.exit(1) }
const rows = JSON.parse(text)

console.log('Vero rows with bank data:', rows.length)
for (const r of rows) {
  const accounts = r.bank_accounts ? Object.entries(r.bank_accounts).map(([a, v]) => `${a}: net=${v.net.toLocaleString('sv-SE')} (d=${v.debit.toLocaleString('sv-SE')} c=${v.credit.toLocaleString('sv-SE')})`).join(' | ') : '—'
  console.log(`  ${r.period_year}-${String(r.period_month).padStart(2,'0')}  net=${(r.bank_net_change ?? 0).toLocaleString('sv-SE').padStart(14)}  source=${r.source}`)
  console.log(`    ${accounts}`)
}

// Sum by fiscal year (assuming calendar-year fiscal year for Sweden — most common)
console.log('\nCumulative by fiscal year (calendar year):')
const byYear = {}
for (const r of rows) {
  byYear[r.period_year] = (byYear[r.period_year] ?? 0) + (r.bank_net_change ?? 0)
}
for (const [y, sum] of Object.entries(byYear).sort()) {
  console.log(`  ${y}: ${sum.toLocaleString('sv-SE')} kr`)
}

const totalSinceStart = rows.reduce((s, r) => s + (r.bank_net_change ?? 0), 0)
console.log(`\nTotal cumulative since tracking began: ${totalSinceStart.toLocaleString('sv-SE')} kr`)
