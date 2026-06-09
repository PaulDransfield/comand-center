// Caspeco probe v4 — correct AuthKey header, full PAT
const SHORTNAME_AND_DATES = 'Comandcenter-2026-06-09-2094-06-09'
const KEY_PART = process.argv[2] ?? process.env.CASPECO_KEY
if (!KEY_PART) { console.error('pass key part'); process.exit(1) }

const PAT = `${SHORTNAME_AND_DATES}--${KEY_PART}`
console.log('Full PAT prefix:', PAT.slice(0, 60) + '…')

const baseUrls = [
  'https://api.caspeco.com',
  'https://api.caspeco.se',
  'https://id.caspeco.se',
  'https://id.caspeco.se/api',
  'https://booking.caspeco.com',
  'https://booking.caspeco.se',
  'https://booking-api.caspeco.com',
  'https://salesexport.caspeco.com',
  'https://report.caspeco.com',
  'https://sales-export.caspeco.com',
  'https://api.caspeco.com/booking',
  'https://api.caspeco.com/booking/v1',
  'https://api.caspeco.com/salesexport',
  'https://api.caspeco.com/salesexport/v1',
  'https://api.caspeco.com/report',
  'https://api.caspeco.com/report/v1',
]

const paths = [
  '/',
  '/me',
  '/systems',
  '/companies',
  '/booking',
  '/booking/v1',
  '/booking/v1/systems',
  '/booking/v1/me',
  '/v1/systems',
  '/v1/me',
  '/v1/booking',
  '/sales',
  '/sales/v1',
  '/report',
  '/report/v1',
  '/openapi',
  '/swagger',
  '/swagger.json',
  '/openapi.json',
  '/docs',
]

console.log()
console.log('Path                                    | Base                                | Status | Content-type                  | Preview')
console.log('-'.repeat(160))

const hits = []
for (const base of baseUrls) {
  for (const path of paths) {
    const url = base + path
    try {
      const r = await fetch(url, {
        headers: {
          AuthKey: PAT,
          Accept:  'application/json',
        },
      })
      if (r.status === 404 || r.status === 0) continue
      const ct = (r.headers.get('content-type') ?? '').slice(0, 28)
      let body = await r.text()
      body = body.replace(/\s+/g, ' ').slice(0, 100)
      console.log(`${path.padEnd(40)}| ${base.padEnd(36)}| ${String(r.status).padEnd(6)} | ${ct.padEnd(28)} | ${body}`)
      if (r.status >= 200 && r.status < 400) hits.push({ base, path, status: r.status, ct, body })
    } catch {}
  }
}

console.log()
console.log(`Total non-404 responses: ${hits.length}`)
