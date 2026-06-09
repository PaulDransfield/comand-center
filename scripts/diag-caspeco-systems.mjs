// Find the systems list for this PAT user
const PAT = `Comandcenter-2026-06-09-2094-06-09--${process.argv[2]}`
if (!process.argv[2]) { console.error('pass key part'); process.exit(1) }
const USER_ID = '4c64b27a-675d-4c84-b25b-fa7cca8f8fca'

const targets = [
  // OpenID / IdentityServer conventions on id.caspeco.se
  'https://id.caspeco.se/connect/userinfo',
  'https://id.caspeco.se/.well-known/openid-configuration',
  'https://id.caspeco.se/api/users/me',
  'https://id.caspeco.se/api/v1/users/me',
  'https://id.caspeco.se/api/me',
  'https://id.caspeco.se/api/v1/me',
  'https://id.caspeco.se/api/v1/systems',
  'https://id.caspeco.se/api/systems',
  'https://id.caspeco.se/pat/me',
  'https://id.caspeco.se/api/v1/user',
  // Cloud — "list systems I can reach"
  'https://cloud.caspeco.se/api/v1/systems',
  'https://cloud.caspeco.se/api/v1/users/me',
  'https://cloud.caspeco.se/api/v1/users/me/systems',
  'https://cloud.caspeco.se/api/v1/me',
  'https://cloud.caspeco.se/api/v1/me/systems',
  'https://cloud.caspeco.se/api/systems',
  'https://cloud.caspeco.se/api/users/me',
  `https://cloud.caspeco.se/api/v1/users/${USER_ID}`,
  `https://cloud.caspeco.se/api/v1/users/${USER_ID}/systems`,
  // marc subdomain maybe
  'https://marc.caspeco.se/api/v1/systems',
  'https://marcapi.caspeco.se/api/v1/systems',
  'https://api.caspeco.se/marc',
  // Specifically the documented base, look for system-listing patterns
  'https://cloud.caspeco.se/api/v1/Account/Systems',
  'https://cloud.caspeco.se/api/v1/Booking/Systems',
  'https://cloud.caspeco.se/api/v1/booking/systems',
]
const headers = { Authorization: `Bearer ${PAT}`, Accept: 'application/json' }

for (const u of targets) {
  try {
    const r = await fetch(u, { headers })
    if (r.status === 404) continue
    const ct = (r.headers.get('content-type') ?? '').slice(0, 36)
    let body = await r.text()
    body = body.replace(/\s+/g, ' ').slice(0, 250)
    console.log(`${String(r.status).padEnd(4)} ${u.padEnd(70)} ct=${ct.padEnd(30)} ${body}`)
  } catch {}
}
