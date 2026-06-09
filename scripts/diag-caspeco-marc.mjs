// Probe marc.caspeco.se / marcapi.caspeco.se for the booking API
const PAT = `Comandcenter-2026-06-09-2094-06-09--${process.argv[2]}`
if (!process.argv[2]) { console.error('pass key part'); process.exit(1) }

const bases = [
  'https://marc.caspeco.se',
  'https://marc.caspeco.com',
  'https://marc.caspeco.net',
  'https://marcapi.caspeco.se',
  'https://marcapi.caspeco.com',
  'https://marcapi.caspeco.net',
  'https://marc-api.caspeco.se',
  'https://api.marc.caspeco.se',
  'https://booking.caspeco.se',
  'https://booking.caspeco.com',
  'https://booking.caspeco.net',
  'https://booking-api.caspeco.se',
  'https://reservation.caspeco.se',
  'https://reservation.caspeco.com',
]
const paths = ['/', '/health', '/api/v1', '/api', '/me', '/systems', '/api/v1/systems', '/v1/systems', '/v1/bookings', '/bookings']

for (const base of bases) {
  for (const path of paths) {
    try {
      const r = await fetch(base + path, {
        headers: { Authorization: `Bearer ${PAT}`, Accept: 'application/json' },
      })
      if (r.status === 404 || r.status === 0) continue
      const ct = (r.headers.get('content-type') ?? '').slice(0, 28)
      let body = await r.text()
      body = body.replace(/\s+/g, ' ').slice(0, 200)
      console.log(`${String(r.status).padEnd(4)} ${base.padEnd(40)} ${path.padEnd(24)} ct=${ct.padEnd(28)} ${body}`)
    } catch {}
  }
}
