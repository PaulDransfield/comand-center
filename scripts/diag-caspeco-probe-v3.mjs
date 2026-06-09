// Caspeco probe v3 — base is api.caspeco.com; find the right path + auth
const USER = 'Comandcenter'
const KEY  = process.argv[2] ?? process.env.CASPECO_KEY
if (!KEY) { console.error('pass KEY as arg'); process.exit(1) }

const FULL_USER = `${USER}-2026-06-09-2094-06-09`
const BASE = 'https://api.caspeco.com'

const basicShort = 'Basic ' + Buffer.from(`${USER}:${KEY}`).toString('base64')
const basicFull  = 'Basic ' + Buffer.from(`${FULL_USER}:${KEY}`).toString('base64')

const authSchemes = [
  { name: 'Bearer',              header: `Bearer ${KEY}` },
  { name: 'Basic Comandcenter',  header: basicShort },
  { name: 'Basic full-token',    header: basicFull },
  { name: 'ApiKey',              header: `ApiKey ${KEY}` },
  { name: 'Custom Caspeco-Token',header: KEY, custom: 'Caspeco-Token' },
]

const paths = [
  '/',
  '/api',
  '/api/',
  '/api/v1',
  '/api/v1/',
  '/api/v1/employees',
  '/api/v1/customers',
  '/api/v1/companies',
  '/api/v1/restaurants',
  '/api/v1/units',
  '/api/v1/me',
  '/api/v1/auth',
  '/api/v1/users/me',
  '/v1/employees',
  '/v1/companies',
  '/v1/customers',
  '/v1/me',
  '/v1/units',
  '/external/employees',
  '/external/v1/employees',
  '/external/companies',
  '/external/customers',
  '/restaurants',
  '/units',
  '/employees',
  '/companies',
  '/customers',
  '/customer',
  '/me',
  '/info',
  '/swagger',
  '/swagger.json',
  '/openapi.json',
  '/.well-known/openid-configuration',
  '/docs',
]

console.log()
console.log(`Base ${BASE}, USER=${USER}, key prefix ${KEY.slice(0,8)}…`)
console.log()
console.log('Path                                          AuthScheme              Status  ContentType                          Preview')

for (const path of paths) {
  for (const scheme of authSchemes) {
    const headers = scheme.custom
      ? { [scheme.custom]: scheme.header, Accept: 'application/json' }
      : { Authorization: scheme.header, Accept: 'application/json' }
    try {
      const r = await fetch(BASE + path, { headers })
      if (r.status === 0 || r.status === 404) continue   // skip noise
      const ct = (r.headers.get('content-type') ?? '').slice(0, 36)
      let body = await r.text()
      body = body.replace(/\s+/g, ' ').slice(0, 140)
      console.log(`  ${path.padEnd(42)}  ${scheme.name.padEnd(22)}  ${String(r.status).padEnd(4)}  ${ct.padEnd(38)}  ${body}`)
    } catch {}
  }
}
