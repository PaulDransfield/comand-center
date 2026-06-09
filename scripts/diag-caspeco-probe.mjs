// scripts/diag-caspeco-probe.mjs
//
// Probe the Caspeco API with the provided key to discover:
//   1. Which entity defines a "restaurant" / "company" / "location"
//   2. Whether shifts and employees carry that entity's ID
//   3. What query parameters (if any) filter by that entity
//
// Pass the key as the first arg or via CASPECO_PROBE_KEY env.
// Read-only — no writes to our DB. Output to stdout only.

const KEY = process.argv[2] ?? process.env.CASPECO_PROBE_KEY
if (!KEY) {
  console.error('Usage: node scripts/diag-caspeco-probe.mjs <KEY>  OR set CASPECO_PROBE_KEY env')
  process.exit(1)
}

const BASE = 'https://api.caspeco.se/v1'

async function probe(path, { extraHeaders = {}, method = 'GET' } = {}) {
  const url = `${BASE}${path}`
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${KEY}`,
        Accept: 'application/json',
        ...extraHeaders,
      },
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return {
      path,
      status: res.status,
      ok: res.ok,
      content_type: res.headers.get('content-type') ?? '',
      // Show full body for small responses, otherwise just shape
      body_preview: text.length < 2000 ? text : text.slice(0, 800) + '… [truncated]',
      json_shape: json ? describeShape(json) : null,
    }
  } catch (e) {
    return { path, error: String(e?.message ?? e), cause: String(e?.cause?.message ?? e?.cause ?? '') }
  }
}

function describeShape(o, depth = 0) {
  if (depth > 3) return '…'
  if (o == null) return 'null'
  if (Array.isArray(o)) {
    if (o.length === 0) return 'array[0]'
    return `array[${o.length}] of ${describeShape(o[0], depth + 1)}`
  }
  if (typeof o === 'object') {
    const keys = Object.keys(o).slice(0, 14)
    const out = {}
    for (const k of keys) out[k] = describeShape(o[k], depth + 1)
    return out
  }
  return typeof o
}

const candidatePaths = [
  // Auth / account context
  '/me',
  '/account',
  '/user',
  '/users/me',

  // Entity discovery — what restaurants does this key reach?
  '/companies',
  '/customers',
  '/restaurants',
  '/units',
  '/locations',
  '/sites',
  '/businesses',
  '/organizations',
  '/organisations',
  '/departments',
  '/cost-centers',
  '/cost_centers',
  '/sections',
  '/branches',
  '/workplaces',

  // Known-to-work endpoints, look at field shapes
  '/employees',
  '/employees?limit=2',
  '/shifts?limit=2',
]

console.log()
console.log('Caspeco API probe — discovering multi-business structure')
console.log('Key prefix:', KEY.slice(0, 10) + '…')
console.log()

const results = []
for (const p of candidatePaths) {
  const r = await probe(p)
  results.push(r)
  const flag = r.error
    ? `ERR`
    : r.ok
      ? `${r.status} ✓`
      : `${r.status}`
  const shape = r.json_shape ? JSON.stringify(r.json_shape).slice(0, 200) : (r.body_preview ?? '').slice(0, 200)
  console.log(`${flag.padEnd(8)} ${p.padEnd(28)}  ${shape}`)
}

console.log()
console.log('═══ Detailed bodies of successful endpoints ═══')
for (const r of results) {
  if (r.ok) {
    console.log()
    console.log(`──── ${r.path} ────`)
    console.log(r.body_preview)
  }
}
