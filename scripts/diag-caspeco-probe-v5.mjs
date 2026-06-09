// Caspeco probe v5 — try more hostnames + grep id.caspeco.se HTML for hints
const PAT = `Comandcenter-2026-06-09-2094-06-09--${process.argv[2]}`
if (!process.argv[2]) { console.error('pass key part'); process.exit(1) }

// Read id.caspeco.se's HTML to look for app/api URLs
console.log('── Step 1: scrape id.caspeco.se HTML for any hostnames it references ──')
const r0 = await fetch('https://id.caspeco.se/', { headers: { AuthKey: PAT } })
const html = await r0.text()
const hosts = new Set()
for (const m of html.matchAll(/https?:\/\/([a-z0-9.-]+\.caspeco\.[a-z]+)/gi)) hosts.add(m[1])
for (const m of html.matchAll(/([a-z0-9-]+\.caspeco\.[a-z]+)/gi)) hosts.add(m[1])
console.log('  Found caspeco hostnames in HTML:', [...hosts])

// Also grep for any api-looking paths
const pathHints = new Set()
for (const m of html.matchAll(/\/(api|booking|sales|report|external)[a-z0-9/_-]*/gi)) pathHints.add(m[0])
console.log('  Found api-looking paths in HTML:', [...pathHints].slice(0, 20))

console.log()
console.log('── Step 2: probe hostnames + extra candidates ──')
const baseUrls = [
  ...[...hosts].map(h => `https://${h}`),
  'https://booking.caspeco.cloud',
  'https://api.caspeco.cloud',
  'https://web.caspeco.cloud',
  'https://app.caspeco.cloud',
  'https://api.caspeco.com',
  'https://booking-api.caspeco.cloud',
  'https://salesexport-api.caspeco.cloud',
  'https://report-api.caspeco.cloud',
  'https://caspecoid.caspeco.se',
  'https://login.caspeco.se',
  'https://developer.caspeco.com',
  'https://developers.caspeco.com',
  'https://api.caspeco.se',
  'https://api2.caspeco.se',
  'https://api-prod.caspeco.com',
]
const paths = ['/', '/healthz', '/health', '/api', '/api/v1', '/booking', '/booking/v1', '/sales', '/report']
console.log()
console.log('Status | Base                                       | Path             | Content-type                  | Preview')
console.log('-'.repeat(150))
for (const base of baseUrls) {
  for (const path of paths) {
    try {
      const r = await fetch(base + path, { headers: { AuthKey: PAT, Accept: 'application/json' } })
      if (r.status === 404 || r.status === 0) continue
      const ct = (r.headers.get('content-type') ?? '').slice(0, 28)
      let body = await r.text()
      body = body.replace(/\s+/g, ' ').slice(0, 100)
      console.log(`${String(r.status).padEnd(7)}| ${base.padEnd(42)} | ${path.padEnd(16)} | ${ct.padEnd(28)} | ${body}`)
    } catch (e) {
      // skip
    }
  }
}
