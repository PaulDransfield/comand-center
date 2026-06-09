// Caspeco probe v6 — api.caspeco.com confirmed; find the right paths
const PAT = `Comandcenter-2026-06-09-2094-06-09--${process.argv[2]}`

// Lots of path candidates against api.caspeco.com
const paths = [
  // Booking API guesses
  '/booking', '/booking/v1', '/booking/api/v1',
  '/booking/v1/bookings', '/booking/v1/system', '/booking/v1/systems',
  '/booking/v1/units', '/booking/v1/me', '/booking/v1/info',
  '/api/booking', '/api/booking/v1',
  '/api/booking/v1/bookings', '/api/booking/v1/systems',
  // External / partner pattern
  '/external/booking', '/external/booking/v1',
  '/external/booking/v1/bookings',
  // Sales export
  '/salesexport', '/salesexport/v1', '/sales/export',
  '/salesexport/v1/sales', '/salesexport/v1/units',
  // Report
  '/report', '/report/v1',
  // Public docs
  '/openapi.json', '/openapi.yaml', '/swagger.json', '/swagger',
  '/docs', '/redoc',
  // Health/info pattern
  '/health', '/info', '/me',
  // Common entry endpoints with system query param
  '/booking/v1/bookings?system=se__test',
  '/booking?system=se__test',
]
console.log()
console.log('Path                                                 | Status | Content-type                  | Preview')
console.log('-'.repeat(160))
for (const path of paths) {
  try {
    const r = await fetch('https://api.caspeco.com' + path, { headers: { AuthKey: PAT, Accept: 'application/json' } })
    const ct = (r.headers.get('content-type') ?? '').slice(0, 28)
    let body = await r.text()
    body = body.replace(/\s+/g, ' ').slice(0, 120)
    console.log(`${path.padEnd(52)} | ${String(r.status).padEnd(6)} | ${ct.padEnd(28)} | ${body}`)
  } catch (e) {
    console.log(`${path.padEnd(52)} | ERR  | ${String(e?.message ?? e).slice(0, 60)}`)
  }
}
