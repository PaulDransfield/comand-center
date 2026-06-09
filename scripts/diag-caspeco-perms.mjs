// Probe what booking-related actions and systems this PAT can reach
const PAT = `Comandcenter-2026-06-09-2094-06-09--${process.argv[2]}`
if (!process.argv[2]) { console.error('pass key part'); process.exit(1) }

const BASE = 'https://cloud.caspeco.se'
const RMS  = 'https://rms.caspeco.se'

// Without system + with a system guess
const sysGuesses = [null, 'se__chicce', 'se__chicceslotsgatan', 'se__comandcenter', 'se__chicce_slottsgatan']

const targets = [
  // From the 403 we know this is the path. Try sister paths.
  { base: BASE, path: '/api/v1/Booking/Bookings', label: 'admin Bookings (got 403)' },
  { base: BASE, path: '/api/v1/Booking', label: 'Booking root' },
  { base: BASE, path: '/api/v1/Booking/Sources', label: 'Sources' },
  { base: BASE, path: '/api/v1/Booking/Units', label: 'Units' },
  { base: BASE, path: '/api/v1/Booking/Tables', label: 'Tables' },
  { base: BASE, path: '/api/v1/Booking/Customers', label: 'Customers' },
  { base: BASE, path: '/api/v1/Booking/Webbookings_getall', label: 'Webbookings_getall (from docs)' },
  { base: BASE, path: '/api/v1/Booking/ExternalBookingSettings', label: 'ExternalBookingSettings' },
  { base: BASE, path: '/api/v1/Booking/Embedding', label: 'Embedding script' },
  { base: BASE, path: '/api/v1/Booking/Calendar', label: 'Calendar' },
  { base: BASE, path: '/api/v1/Account', label: 'Account info' },
  { base: BASE, path: '/api/v1/Account/Me', label: 'Account.Me' },
  { base: BASE, path: '/api/v1/Me', label: 'Me' },
  { base: BASE, path: '/api/v1/User/Me', label: 'User.Me' },
  // RMS variants
  { base: RMS,  path: '/api/booking', label: 'rms.booking' },
  { base: RMS,  path: '/api/booking/v1/Bookings', label: 'rms v1.Bookings' },
  { base: RMS,  path: '/api/booking/Bookings', label: 'rms Bookings' },
]

for (const t of targets) {
  for (const sys of sysGuesses) {
    const h = { Authorization: `Bearer ${PAT}`, Accept: 'application/json' }
    if (sys) h['system'] = sys
    try {
      const r = await fetch(t.base + t.path, { headers: h })
      if (r.status === 404) continue
      const ct = (r.headers.get('content-type') ?? '').slice(0, 28)
      let body = await r.text()
      body = body.replace(/\s+/g, ' ').slice(0, 200)
      const sysLabel = sys ? `sys=${sys}` : 'no-sys '
      console.log(`${String(r.status).padEnd(4)} ${sysLabel.padEnd(28)} ${(t.base.replace('https://','') + t.path).padEnd(60)} ${body}`)
    } catch {}
  }
}
