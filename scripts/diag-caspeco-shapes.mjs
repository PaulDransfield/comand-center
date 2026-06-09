const PAT = `Comandcenter-2026-06-09-2094-06-09--${process.argv[2]}`
const COMPANYID = 'db5a8731-bded-4bac-3667-08dc4981995d'
const headers = {
  Authorization: `Bearer ${PAT}`,
  Accept: 'application/json',
  companyid: COMPANYID,
  'x-csrf': '1',
}

for (const path of ['/api/v1/Employees', '/api/v1/Articles']) {
  const r = await fetch('https://cloud.caspeco.se' + path, { headers })
  const json = await r.json()
  const arr = Array.isArray(json) ? json : (json.data ?? json.items ?? [json])
  console.log(`── ${path}  (${arr.length} items) ──`)
  if (arr[0]) console.log(JSON.stringify(arr[0], null, 2).slice(0, 1200))
  console.log()
}

// Also try to find a Companies endpoint that lists ALL companies our PAT can reach
for (const path of ['/api/v1/Companies', '/api/v1/Company', '/api/v1/Account/Companies', '/api/v1/Employee/Companies', '/api/v1/Employees/Companies', '/api/v1/User/Companies']) {
  try {
    // Try without companyid first — to see if it lists everything
    const r = await fetch('https://cloud.caspeco.se' + path, { headers: { Authorization: `Bearer ${PAT}`, Accept: 'application/json' } })
    const ct = r.headers.get('content-type') ?? ''
    if (r.status === 404) continue
    const body = await r.text()
    console.log(`${r.status}  ${path}  ct=${ct}  ${body.slice(0, 200)}`)
  } catch {}
}
