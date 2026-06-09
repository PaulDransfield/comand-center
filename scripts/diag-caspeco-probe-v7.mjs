// Caspeco probe v7 — using the documented base URLs and auth schemes
const PAT = `Comandcenter-2026-06-09-2094-06-09--${process.argv[2]}`
if (!process.argv[2]) { console.error('pass key part'); process.exit(1) }

// Sales Export API — uses AuthKey header
const SALES_BASE = 'https://salesapi.caspeco.net'
// Booking API — uses Bearer
const BOOKING_BASE = 'https://cloud.caspeco.se'

const today    = new Date().toISOString().slice(0, 10)
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

// Without a known `system` value, try a few common Caspeco patterns.
const systemCandidates = [
  // From Caspeco's docs example:
  'se__testbb',
  // Common patterns for "Comandcenter" customer:
  'se__comandcenter',
  'se__chicce',
  'se__chicceslotsgatan',
  'se__chicce_slotsgatan',
  'se_comandcenter',
  'se_chicce',
  'comandcenter',
  'chicce',
]

console.log()
console.log('── Step 1: Booking API smoke test (no system) ──')
console.log()
const bookingPaths = [
  '/api/v1/WebBooking/Webbookings_getall',
  '/api/v1/booking/ExternalBookingSettings',
  '/api/v1/booking/me',
  '/api/v1/booking',
  '/api/v1',
  '/api/v1/info',
  '/api/v1/health',
  '/health',
  '/',
]
for (const path of bookingPaths) {
  try {
    const r = await fetch(BOOKING_BASE + path, {
      headers: { Authorization: `Bearer ${PAT}`, Accept: 'application/json' },
    })
    let body = await r.text()
    body = body.replace(/\s+/g, ' ').slice(0, 160)
    console.log(`  ${String(r.status).padEnd(4)}  ${path.padEnd(48)}  ct=${(r.headers.get('content-type')??'').slice(0,28).padEnd(28)}  ${body}`)
  } catch (e) {
    console.log(`  ERR   ${path}  ${String(e?.message ?? e).slice(0, 60)}`)
  }
}

console.log()
console.log('── Step 2: Booking API with system header candidates ──')
console.log()
for (const sys of systemCandidates) {
  try {
    const r = await fetch(BOOKING_BASE + '/api/v1/WebBooking/Webbookings_getall', {
      headers: {
        Authorization: `Bearer ${PAT}`,
        Accept:        'application/json',
        system:        sys,
      },
    })
    let body = await r.text()
    body = body.replace(/\s+/g, ' ').slice(0, 160)
    console.log(`  ${String(r.status).padEnd(4)}  system=${sys.padEnd(28)}  ct=${(r.headers.get('content-type')??'').slice(0,24).padEnd(24)}  ${body}`)
  } catch (e) {
    console.log(`  ERR   system=${sys}  ${String(e?.message ?? e).slice(0, 60)}`)
  }
}

console.log()
console.log('── Step 3: Sales Export API ──')
console.log()
for (const sys of systemCandidates) {
  try {
    const r = await fetch(`${SALES_BASE}/api/sales/${sys}/${yesterday}`, {
      headers: { AuthKey: PAT, Accept: 'application/json' },
    })
    let body = await r.text()
    body = body.replace(/\s+/g, ' ').slice(0, 160)
    console.log(`  ${String(r.status).padEnd(4)}  /api/sales/${sys.padEnd(20)}/${yesterday}  ${body}`)
  } catch (e) {
    console.log(`  ERR   ${sys}  ${String(e?.message ?? e).slice(0, 60)}`)
  }
}

console.log()
console.log('── Step 4: Booking connection-test endpoint (no auth, should return "OK") ──')
try {
  const r = await fetch('http://cloud.caspeco.se', { redirect: 'manual' })
  const body = await r.text()
  console.log(`  ${r.status}  body=${body.slice(0, 100)}`)
} catch (e) {
  console.log(`  ERR ${String(e?.message ?? e)}`)
}
