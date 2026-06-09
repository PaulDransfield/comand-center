const PAT = `Comandcenter-2026-06-09-2094-06-09--${process.argv[2]}`
const COMPANYID = 'db5a8731-bded-4bac-3667-08dc4981995d'
const headers = {
  Authorization: `Bearer ${PAT}`,
  Accept: 'application/json',
  companyid: COMPANYID,
  'x-csrf': '1',
}

const today = new Date().toISOString().slice(0, 10)
const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
const monthAhead = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)

const paths = [
  '/api/v1/Schedule',
  '/api/v1/Schedules',
  '/api/v1/Schedule/Shifts',
  '/api/v1/Shifts',
  '/api/v1/Shift',
  '/api/v1/Schedule/Bookings',
  '/api/v1/Staffing',
  '/api/v1/Roster',
  '/api/v1/Stations',
  '/api/v1/Professions',
  '/api/v1/Contracts',
  '/api/v1/Locations',
  '/api/v1/Departments',
  `/api/v1/Schedule?from=${monthAgo}&to=${today}`,
  `/api/v1/Shifts?from=${monthAgo}&to=${today}`,
  `/api/v1/Schedule?fromDate=${monthAgo}&toDate=${today}`,
  `/api/v1/Shifts?fromDate=${monthAgo}&toDate=${today}`,
  // Variations of casing
  '/api/v1/Booking', // root
  '/api/v1/Sales',
  '/api/v1/SalesData',
  // Try v2/v3
  '/api/v2/Schedule',
  '/api/v3/Schedule',
]

const have = [], lack = [], err = [], notFound = []
for (const path of paths) {
  try {
    const r = await fetch('https://cloud.caspeco.se' + path, { headers })
    const ct = (r.headers.get('content-type') ?? '').slice(0, 28)
    const body = await r.text()
    if (r.status === 200) {
      let count = '?'
      try { const j = JSON.parse(body); count = Array.isArray(j) ? j.length : (j.data?.length ?? '1') } catch {}
      have.push({ path, ct, count, sample: body.slice(0, 120) })
    } else if (r.status === 403) {
      const m = body.match(/action: ([a-zA-Z0-9_.]+)/)
      lack.push({ path, action: m?.[1] ?? null })
    } else if (r.status === 404) {
      notFound.push(path)
    } else {
      err.push({ path, status: r.status, body: body.slice(0, 80) })
    }
  } catch (e) {
    err.push({ path, status: 'NET', body: String(e?.message ?? e).slice(0, 60) })
  }
}

console.log('═══ HAVE ═══')
for (const h of have) console.log(`  ✓ ${h.path}  (n=${h.count})  ${h.sample.slice(0, 80)}`)
console.log()
console.log('═══ LACK (permission) ═══')
for (const l of lack) console.log(`  ✗ ${l.path}  needs: ${l.action}`)
console.log()
console.log('═══ Other errors ═══')
for (const e of err) console.log(`  ${e.status}  ${e.path}  ${e.body}`)
console.log()
console.log(`HAVE=${have.length}  LACK=${lack.length}  ERR=${err.length}  404=${notFound.length}`)
