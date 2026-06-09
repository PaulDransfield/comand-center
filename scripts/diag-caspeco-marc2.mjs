// Read the booking SPA HTML for embedded API URLs + try marc paths on cloud
const PAT = `Comandcenter-2026-06-09-2094-06-09--${process.argv[2]}`
if (!process.argv[2]) { console.error('pass key part'); process.exit(1) }

// 1) Grab the booking.caspeco.net SPA HTML and look at any embedded JS files
//    to scrape API URLs from them
console.log('── 1. Pull booking.caspeco.net SPA + scan for api URLs ──')
const html1 = await (await fetch('https://booking.caspeco.net/')).text()
const scriptUrls = [...html1.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1])
console.log('Scripts referenced:', scriptUrls.slice(0, 10))

// Pull a couple of those scripts and search for "/api/" or hostnames
for (const s of scriptUrls.slice(0, 6)) {
  const url = s.startsWith('http') ? s : `https://booking.caspeco.net${s}`
  try {
    const txt = await (await fetch(url)).text()
    const apiHits = new Set()
    for (const m of txt.matchAll(/https:\/\/[a-z0-9.-]*caspeco[a-z0-9.-]*\/[a-zA-Z0-9_/.\-]+/g)) apiHits.add(m[0])
    for (const m of txt.matchAll(/['"](\/api\/[a-zA-Z0-9_/.\-]+)['"]/g)) apiHits.add(m[1])
    if (apiHits.size > 0) {
      console.log(`  ${url.slice(0, 80)} ← URL hints:`)
      for (const h of [...apiHits].slice(0, 14)) console.log(`     ${h}`)
    }
  } catch {}
}

// 2) Try marc-shaped paths on cloud.caspeco.se with PAT
console.log()
console.log('── 2. Try marc paths on cloud.caspeco.se ──')
const paths = [
  '/marc',
  '/marc/api',
  '/marc/api/v1',
  '/marc/api/v1/systems',
  '/api/marc',
  '/api/marc/v1',
  '/api/marc/v1/systems',
  '/api/v1/marc',
  '/api/v1/marc/systems',
  '/api/v1/marc/bookings',
  '/api/v1/booking',
  '/api/v1/booking/systems',
  '/api/v1/booking/system',
  '/api/v1/Bookings',
  '/api/v1/Booking',
  '/api/v1/Booking/Bookings',
  '/api/v1/Booking/Webbookings_getall',
  '/api/v1/Booking/CreateEmbeddingScript',
  '/api/v1/Account',
  '/api/v1/Account/Systems',
  '/api/v1/User',
  '/api/v1/User/Me',
  '/api/v1/User/Systems',
  '/api/v1/Users/Me',
  '/api/v1/Users/Systems',
  '/api/v1/Systems',
]
for (const p of paths) {
  try {
    const r = await fetch('https://cloud.caspeco.se' + p, { headers: { Authorization: `Bearer ${PAT}`, Accept: 'application/json' } })
    if (r.status === 404) continue
    const ct = (r.headers.get('content-type') ?? '').slice(0, 28)
    let body = await r.text()
    body = body.replace(/\s+/g, ' ').slice(0, 200)
    console.log(`  ${String(r.status).padEnd(4)} ${p.padEnd(48)} ct=${ct.padEnd(28)} ${body}`)
  } catch {}
}
