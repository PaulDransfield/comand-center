// Direct test of the Caspeco sync against the live integration row,
// without going through the cron auth path. Calls testConnection +
// pulls Employees + Stations + probes gated endpoints.
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

const { data: integ } = await db.from('integrations').select('*').eq('business_id', CHICCE).eq('provider', 'caspeco').maybeSingle()
if (!integ) { console.error('No integration row'); process.exit(1) }

// Skip decrypt — re-use the PAT from CLI
const PAT_RAW = process.argv[2]
if (!PAT_RAW) { console.error('Pass the PAT key as arg 1 (the part after the --)'); process.exit(1) }
const PAT = `Comandcenter-2026-06-09-2094-06-09--${PAT_RAW}`
const companyid = integ.metadata.caspeco_company_id

const headers = { Authorization: `Bearer ${PAT}`, Accept: 'application/json', companyid, 'x-csrf': '1' }

const BASE = 'https://cloud.caspeco.se'
const today = new Date().toISOString().slice(0, 10)
const ahead = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)

async function probe(path) {
  const r = await fetch(BASE + path, { headers })
  const ct = r.headers.get('content-type') ?? ''
  if (r.status === 200) {
    const json = await r.json().catch(() => null)
    const n = Array.isArray(json) ? json.length : '?'
    return { ok: true, status: 200, n, sample: JSON.stringify(json?.[0] ?? json ?? '').slice(0, 120) }
  }
  const body = await r.text()
  const m = body.match(/action: ([a-zA-Z0-9_.]+)/)
  return { ok: false, status: r.status, perm: m?.[1] ?? null, body: body.slice(0, 200) }
}

const tests = [
  ['/api/v1/Employees',                                          'Employees'],
  ['/api/v1/Stations',                                           'Stations'],
  ['/api/v1/Articles',                                           'Articles'],
  [`/api/v1/Booking/Bookings?fromDate=${today}&toDate=${ahead}`, 'Bookings (next 14d)'],
  ['/api/v1/Booking/Units',                                      'Units'],
]
console.log()
for (const [path, label] of tests) {
  const r = await probe(path)
  if (r.ok) {
    console.log(`  ✓  ${label.padEnd(28)} status=200  n=${r.n}  sample=${r.sample.slice(0, 80)}`)
  } else if (r.status === 403) {
    console.log(`  ✗  ${label.padEnd(28)} 403 — need permission: ${r.perm}`)
  } else {
    console.log(`  ?  ${label.padEnd(28)} status=${r.status}  ${r.body.slice(0, 60)}`)
  }
}
