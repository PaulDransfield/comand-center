// Caspeco probe v2 — try multiple base URLs + auth schemes
const USER = process.env.CASPECO_USER ?? 'Comandcenter'
const KEY  = process.argv[2] ?? process.env.CASPECO_KEY
if (!KEY) { console.error('pass KEY as arg'); process.exit(1) }

const basicBoth = 'Basic ' + Buffer.from(`${USER}:${KEY}`).toString('base64')
const basicLongUser = 'Basic ' + Buffer.from(`${USER}-2026-06-09-2094-06-09:${KEY}`).toString('base64')
const bearer = `Bearer ${KEY}`

const baseUrls = [
  'https://api.caspeco.se',
  'https://api.caspeco.se/v1',
  'https://app.caspeco.se',
  'https://app.caspeco.se/api',
  'https://app.caspeco.se/api/v1',
  'https://api.caspeco.com',
  'https://api.caspeco.net',
  'https://restaurant.caspeco.net',
  'https://restaurant.caspeco.net/api',
  `https://${USER.toLowerCase()}.caspeco.net`,
  `https://${USER.toLowerCase()}.caspeco.net/api`,
]

// First: discovery — DNS + basic GET on root
console.log('── Step 1: which base URL responds at all? ──')
for (const b of baseUrls) {
  try {
    const r = await fetch(b + '/', { method: 'GET' })
    console.log(`  ${b}/    →  status ${r.status}  (${r.headers.get('content-type') ?? ''})`)
  } catch (e) {
    console.log(`  ${b}/    →  ERR  ${String(e?.cause?.code ?? e?.message ?? '').slice(0, 60)}`)
  }
}

// Then: against the survivors, try auth schemes on a likely endpoint
console.log()
console.log('── Step 2: auth probe on /employees (or similar) ──')
const probePaths = ['/employees', '/v1/employees', '/api/v1/employees', '/api/employees', '/auth/me', '/customers', '/me']
const authSchemes = [
  { name: 'Bearer',              header: bearer },
  { name: 'Basic user:key',      header: basicBoth },
  { name: 'Basic full-token:key', header: basicLongUser },
  { name: 'ApiKey raw',          header: KEY },
  { name: 'Token raw',           header: `Token ${KEY}` },
]

for (const base of baseUrls) {
  for (const path of probePaths) {
    for (const scheme of authSchemes) {
      const url = base + path
      try {
        const r = await fetch(url, {
          headers: {
            Authorization: scheme.header,
            Accept: 'application/json',
          },
        })
        if (r.status !== 404 && r.status !== 0 && r.status < 500) {
          const ct = r.headers.get('content-type') ?? ''
          let body = await r.text()
          body = body.length > 200 ? body.slice(0, 200) + '…' : body
          console.log(`  ${String(r.status).padEnd(4)} ${base}${path}  auth=${scheme.name.padEnd(22)}  ${body.replace(/\s+/g, ' ').slice(0, 140)}`)
        }
      } catch (e) {
        // skip noise
      }
    }
  }
}
