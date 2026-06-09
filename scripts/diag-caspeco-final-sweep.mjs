// Final sweep — try every plausible Caspeco endpoint to make sure we
// haven't missed any readable data source. Each 403 also names the
// missing permission, useful as a complete picture.
const PAT = `Comandcenter-2026-06-09-2094-06-09--${process.argv[2]}`
const COMPANYID = 'db5a8731-bded-4bac-3667-08dc4981995d'
const headers = { Authorization: `Bearer ${PAT}`, Accept: 'application/json', companyid: COMPANYID, 'x-csrf': '1' }

// Broad endpoint sweep across Caspeco's known modules
const paths = [
  // Personnel & employment
  '/api/v1/Employees',
  '/api/v1/Employee',
  '/api/v1/Employments',
  '/api/v1/Employment',
  '/api/v1/Personnel',
  '/api/v1/Staff',
  '/api/v1/Contracts',
  '/api/v1/Contract',
  '/api/v1/Professions',
  '/api/v1/Profession',
  '/api/v1/Roles',
  '/api/v1/Permissions',
  '/api/v1/UserGroups',
  // Locations / org
  '/api/v1/Stations',
  '/api/v1/Station',
  '/api/v1/Departments',
  '/api/v1/Department',
  '/api/v1/Companies',
  '/api/v1/Company',
  '/api/v1/Sites',
  '/api/v1/Site',
  // Catalog / POS
  '/api/v1/Articles',
  '/api/v1/Article',
  '/api/v1/Categories',
  '/api/v1/Products',
  '/api/v1/Menus',
  '/api/v1/Menu',
  // Time / Scheduling
  '/api/v1/Shifts',
  '/api/v1/Schedule',
  '/api/v1/Schedules',
  '/api/v1/Roster',
  '/api/v1/Attendance',
  '/api/v1/TimeReports',
  '/api/v1/TimePunches',
  '/api/v1/Timesheets',
  '/api/v1/WorkTime',
  '/api/v1/Absences',
  '/api/v1/Absence',
  // Financial / Sales
  '/api/v1/Sales',
  '/api/v1/Revenue',
  '/api/v1/Reports',
  '/api/v1/Reports/Sales',
  '/api/v1/Payroll',
  '/api/v1/Wages',
  '/api/v1/Salaries',
  '/api/v1/Costs',
  // Booking-adjacent
  '/api/v1/Booking/Bookings',
  '/api/v1/Booking/Customers',
  '/api/v1/Booking/Tables',
  '/api/v1/Booking/Sources',
  '/api/v1/Booking/Holidays',
  // Settings / config
  '/api/v1/Settings',
  '/api/v1/Config',
  '/api/v1/Templates',
  // Other modules
  '/api/v1/RawMaterials',
  '/api/v1/Inventory',
  '/api/v1/Items',
  '/api/v1/Notifications',
  '/api/v1/Events',
  '/api/v1/AuditLog',
  '/api/v1/Webhooks',
]

const have = []
const lackByAction = {}
const notFound = []
const err = []

for (const path of paths) {
  try {
    const r = await fetch('https://cloud.caspeco.se' + path, { headers })
    const body = await r.text()
    if (r.status === 200) {
      let count
      try { const j = JSON.parse(body); count = Array.isArray(j) ? j.length : (j?.data?.length ?? '?') } catch { count = '?' }
      have.push({ path, count, sample: body.slice(0, 100) })
    } else if (r.status === 403) {
      const m = body.match(/action: ([a-zA-Z0-9_.]+)/)
      const action = m?.[1] ?? 'unknown'
      if (!lackByAction[action]) lackByAction[action] = []
      lackByAction[action].push(path)
    } else if (r.status === 404) {
      notFound.push(path)
    } else {
      err.push({ path, status: r.status, body: body.slice(0, 100) })
    }
  } catch (e) {
    err.push({ path, status: 'NET', body: String(e?.message ?? e).slice(0, 60) })
  }
}

console.log()
console.log(`═══ READABLE (200) — ${have.length} endpoints ═══`)
for (const h of have) console.log(`  ✓  ${h.path.padEnd(36)} n=${h.count}`)

console.log()
console.log(`═══ BLOCKED on permission — ${Object.keys(lackByAction).length} distinct permissions ═══`)
for (const [action, paths] of Object.entries(lackByAction).sort()) {
  console.log(`  ✗  ${action}`)
  for (const p of paths) console.log(`        ${p}`)
}

console.log()
console.log(`═══ Other errors — ${err.length} ═══`)
for (const e of err) console.log(`  ${e.status}  ${e.path}  ${e.body}`)

console.log()
console.log(`═══ 404 (not found) — ${notFound.length} ═══`)
for (const p of notFound) console.log(`     ${p}`)
