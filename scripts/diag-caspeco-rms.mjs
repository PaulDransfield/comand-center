// Caspeco probe with the real headers Chicce uses
const PAT = `Comandcenter-2026-06-09-2094-06-09--${process.argv[2]}`
if (!process.argv[2]) { console.error('pass key part'); process.exit(1) }

const COMPANYID = 'db5a8731-bded-4bac-3667-08dc4981995d'

const BASE_RMS = 'https://rms.caspeco.se'
const BASE_CLOUD = 'https://cloud.caspeco.se'

const headers = {
  Authorization: `Bearer ${PAT}`,
  Accept:        'application/json',
  companyid:     COMPANYID,
  'x-csrf':      '1',
}

const targets = [
  // RMS endpoints
  { base: BASE_RMS, path: '/api/booking' },
  { base: BASE_RMS, path: '/api/booking/v1' },
  { base: BASE_RMS, path: '/api/booking/Bookings' },
  { base: BASE_RMS, path: '/api/booking/v1/Bookings' },
  { base: BASE_RMS, path: '/api/booking/Units' },
  { base: BASE_RMS, path: '/api/booking/Calendar' },
  { base: BASE_RMS, path: '/api/booking/me' },
  { base: BASE_RMS, path: '/api/booking/companies' },
  { base: BASE_RMS, path: '/api/companies' },
  { base: BASE_RMS, path: '/api/company' },
  { base: BASE_RMS, path: '/api/me' },
  { base: BASE_RMS, path: '/api/account' },
  // Cloud endpoints with companyid
  { base: BASE_CLOUD, path: '/api/v1/Booking/Bookings' },
  { base: BASE_CLOUD, path: '/api/v1/Booking/Units' },
  { base: BASE_CLOUD, path: '/api/v1/Booking/Tables' },
  { base: BASE_CLOUD, path: '/api/v1/Booking/Sources' },
  { base: BASE_CLOUD, path: '/api/v1/Account/Me' },
  { base: BASE_CLOUD, path: '/api/v1/Companies' },
  // Bookings with a date filter (next 14 days)
  { base: BASE_CLOUD, path: `/api/v1/Booking/Bookings?fromDate=${new Date().toISOString().slice(0,10)}&toDate=${new Date(Date.now()+14*86400000).toISOString().slice(0,10)}` },
  { base: BASE_CLOUD, path: `/api/v1/Booking/Calendar?fromDate=${new Date().toISOString().slice(0,10)}&toDate=${new Date(Date.now()+14*86400000).toISOString().slice(0,10)}` },
]

console.log()
console.log(`Probing with companyid=${COMPANYID}, x-csrf=1, Bearer PAT`)
console.log()
for (const t of targets) {
  try {
    const r = await fetch(t.base + t.path, { headers })
    if (r.status === 404) continue
    const ct = (r.headers.get('content-type') ?? '').slice(0, 28)
    let body = await r.text()
    body = body.replace(/\s+/g, ' ').slice(0, 280)
    console.log(`${String(r.status).padEnd(4)} ${(t.base.replace('https://','') + t.path).padEnd(78)} ct=${ct.padEnd(26)} ${body}`)
  } catch (e) {
    console.log(`ERR  ${t.base + t.path}  ${String(e?.message ?? e).slice(0, 60)}`)
  }
}
