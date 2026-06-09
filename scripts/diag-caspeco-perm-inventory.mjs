// Probe a broad list of Caspeco endpoints to inventory which permissions
// our PAT-user account has vs lacks. Each 403 names the missing permission
// in plain text, so we can map them precisely.
const PAT = `Comandcenter-2026-06-09-2094-06-09--${process.argv[2]}`
if (!process.argv[2]) { console.error('pass key part'); process.exit(1) }

const COMPANYID = 'db5a8731-bded-4bac-3667-08dc4981995d'
const BASE = 'https://cloud.caspeco.se'

const headers = {
  Authorization: `Bearer ${PAT}`,
  Accept:        'application/json',
  companyid:     COMPANYID,
  'x-csrf':      '1',
}

const today = new Date().toISOString().slice(0, 10)
const futureDate = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)

// Broad sweep across the documented Caspeco API surfaces. Each path
// resolves into a Caspeco "action" name (visible in the 403 message).
// We'll deduplicate by action.
const probes = [
  // Booking
  '/api/v1/Booking/Bookings',
  '/api/v1/Booking/Bookings/{id}',
  '/api/v1/Booking/Units',
  '/api/v1/Booking/Units/{id}',
  '/api/v1/Booking/Tables',
  '/api/v1/Booking/Sources',
  '/api/v1/Booking/Sources/{id}',
  '/api/v1/Booking/Customers',
  '/api/v1/Booking/Customer',
  '/api/v1/Booking/Calendar',
  '/api/v1/Booking/Capacity',
  '/api/v1/Booking/Availability',
  '/api/v1/Booking/Status',
  '/api/v1/Booking/Settings',
  '/api/v1/Booking/Embedding',
  '/api/v1/Booking/ExternalBookingSettings',
  '/api/v1/Booking/Webbookings_getall',
  '/api/v1/WebBooking/Webbookings_getall',
  '/api/v1/Booking/Notes',
  '/api/v1/Booking/Holidays',
  '/api/v1/Booking/Sections',
  '/api/v1/Booking/Categories',
  '/api/v1/Booking/PaymentTypes',
  '/api/v1/Booking/Reports',
  '/api/v1/Booking/Statistics',

  // Account / User / Company
  '/api/v1/Account',
  '/api/v1/Account/Me',
  '/api/v1/Account/Companies',
  '/api/v1/User',
  '/api/v1/Users',
  '/api/v1/Companies',
  '/api/v1/Company',

  // Sales export
  '/api/v1/Sales',
  '/api/v1/Sales/Export',
  '/api/v1/SalesExport',

  // Staff / Scheduling
  '/api/v1/Schedule',
  '/api/v1/Shifts',
  '/api/v1/Employees',
  '/api/v1/Staff',

  // Payment / Order
  '/api/v1/Orders',
  '/api/v1/Payments',
  '/api/v1/Receipts',
  '/api/v1/Articles',
  '/api/v1/Products',
  '/api/v1/Reports',
]

const have = []
const lack = []
const errors = []
const empty404 = []
const seenActions = new Set()

for (const path of probes) {
  try {
    const r = await fetch(BASE + path, { headers })
    const ct = (r.headers.get('content-type') ?? '').slice(0, 28)
    let body = await r.text()
    if (r.status === 200) {
      have.push({ path, ct, body: body.slice(0, 80) })
    } else if (r.status === 403) {
      const m = body.match(/action: ([a-zA-Z0-9_.]+)/)
      const action = m ? m[1] : null
      if (action) seenActions.add(action)
      lack.push({ path, action, body: body.slice(0, 80) })
    } else if (r.status === 404) {
      empty404.push(path)
    } else {
      errors.push({ path, status: r.status, body: body.slice(0, 80) })
    }
  } catch (e) {
    errors.push({ path, status: 'NET', body: String(e?.message ?? e).slice(0, 80) })
  }
}

console.log()
console.log('═══ Permissions you HAVE (200 OK responses) ═══')
if (have.length === 0) console.log('  (none — every endpoint we probed returned an error)')
for (const h of have) console.log(`  ✓  ${h.path}`)

console.log()
console.log('═══ Permissions you LACK (403, named action) ═══')
const byAction = {}
for (const l of lack) {
  if (!l.action) continue
  if (!byAction[l.action]) byAction[l.action] = []
  byAction[l.action].push(l.path)
}
for (const [action, paths] of Object.entries(byAction).sort()) {
  console.log(`  ✗  ${action}`)
  for (const p of paths) console.log(`        ${p}`)
}

console.log()
console.log('═══ Endpoints that returned other errors (500, etc.) ═══')
for (const e of errors) console.log(`  ${e.status}  ${e.path}  ${e.body}`)

console.log()
console.log('═══ Endpoints that returned 404 (probably don\'t exist) ═══')
for (const p of empty404.slice(0, 20)) console.log(`     ${p}`)
console.log()
console.log(`Total: ${have.length} have, ${lack.length} lack, ${errors.length} err, ${empty404.length} not-found`)
console.log(`Distinct lacking permissions: ${seenActions.size}`)
