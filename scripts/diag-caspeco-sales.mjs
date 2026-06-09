// Caspeco Sales Export — user clarified AuthKey is just "Comandcenter"
const KEY_PART = process.argv[2]
if (!KEY_PART) { console.error('pass key part'); process.exit(1) }
const PAT = `Comandcenter-2026-06-09-2094-06-09--${KEY_PART}`

const dates = ['2026-06-08', '2026-06-07', '2026-06-01', '2026-05-31']
const systems = ['Comandcenter', 'comandcenter', 'aglianico', 'chicce']

const authVariants = [
  { name: 'AuthKey: Comandcenter (per Paul)', header: { AuthKey: 'Comandcenter' } },
  { name: 'AuthKey: full PAT',                 header: { AuthKey: PAT } },
  { name: 'AuthKey + companyid',               header: { AuthKey: 'Comandcenter', companyid: 'db5a8731-bded-4bac-3667-08dc4981995d' } },
]

for (const date of dates) {
  for (const sys of systems) {
    for (const v of authVariants) {
      const url = `https://salesapi.caspeco.net/api/sales/${sys}/${date}`
      try {
        const r = await fetch(url, { headers: { ...v.header, Accept: 'application/json' } })
        if (r.status === 404 || r.status === 0) continue
        const ct = (r.headers.get('content-type') ?? '').slice(0, 28)
        let body = await r.text()
        body = body.replace(/\s+/g, ' ').slice(0, 150)
        console.log(`${String(r.status).padEnd(4)} sys=${sys.padEnd(15)} date=${date}  ${v.name.padEnd(36)}  ct=${ct.padEnd(28)}  ${body}`)
      } catch {}
    }
  }
}

// Also try the import-api/upload root for a clue on auth shape
console.log()
console.log('Import API root probe:')
for (const v of authVariants) {
  const r = await fetch('https://salesapi.caspeco.net/api/ImportApi/ValidatePayload', { method: 'POST', headers: { ...v.header, 'Content-Type': 'application/json' }, body: '{}' })
  let body = await r.text()
  body = body.replace(/\s+/g, ' ').slice(0, 150)
  console.log(`  ${r.status}  ${v.name.padEnd(36)}  ${body}`)
}
