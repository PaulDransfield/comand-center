import { readFileSync } from 'node:fs'
function parseEnv(path) {
  try { return Object.fromEntries(readFileSync(path, 'utf8').split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g, '')] })) } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY

const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const ROSALI = '97187ef3-b816-4c41-9230-7551430784a7'

const integResp = await fetch(`${URL}/rest/v1/integrations?provider=eq.fortnox&select=*&order=updated_at.desc`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
})
const integText = await integResp.text()
if (!integResp.ok) { console.error(`integrations query failed: ${integResp.status} ${integText}`); process.exit(1) }
const integ = JSON.parse(integText)
console.log('Total fortnox integration rows:', integ.length)
console.log('All fortnox integration rows:')
for (const i of integ) {
  const who = i.business_id === VERO ? 'VERO' : i.business_id === ROSALI ? 'ROSALI' : i.business_id ?? 'NULL'
  console.log(`  id=${i.id}`)
  console.log(`    business_id = ${who} (${i.business_id})`)
  console.log(`    status      = ${i.status}`)
  if (i.backfill_status) console.log(`    backfill    = ${i.backfill_status}`)
  if (i.token_expires_at) console.log(`    token_exp   = ${i.token_expires_at}`)
  if (i.last_error) console.log(`    last_error  = ${i.last_error}`)
  console.log()
}

// What's in each business's drilldown cache + tracker_data + fortnox_uploads
for (const [name, bizId] of [['VERO', VERO], ['ROSALI', ROSALI]]) {
  const cache = await fetch(`${URL}/rest/v1/overhead_drilldown_cache?business_id=eq.${bizId}&select=period_year,period_month,category,fetched_at&order=fetched_at.desc&limit=5`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }).then(r => r.json())
  const uploads = await fetch(`${URL}/rest/v1/fortnox_uploads?business_id=eq.${bizId}&select=id,period_year,period_month,status,created_at&order=created_at.desc&limit=5`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }).then(r => r.json())
  const tdApi = await fetch(`${URL}/rest/v1/tracker_data?business_id=eq.${bizId}&source=eq.fortnox_api&select=period_year,period_month,source,created_via,created_at&order=created_at.desc&limit=5`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }).then(r => r.json())
  console.log(`${name} (${bizId}):`)
  console.log(`  drilldown_cache: ${cache.length} rows`)
  if (cache.length) cache.forEach(c => console.log(`    ${c.period_year}-${String(c.period_month).padStart(2,'0')} ${c.category} (fetched ${c.fetched_at})`))
  console.log(`  fortnox_uploads: ${uploads.length} rows`)
  if (uploads.length) uploads.forEach(u => console.log(`    ${u.period_year}-${String(u.period_month).padStart(2,'0')} status=${u.status} created=${u.created_at}`))
  console.log(`  tracker_data (source=fortnox_api): ${tdApi.length} rows`)
  if (tdApi.length) tdApi.forEach(t => console.log(`    ${t.period_year}-${String(t.period_month).padStart(2,'0')} created_via=${t.created_via} created=${t.created_at}`))
  console.log()
}
