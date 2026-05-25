// scripts/probe-pk-schedule-api.mjs
// Probes Personalkollen's API to fill in the unknowns for AI-SCHEDULING-PLAN.md §0.
// Uses Vero's stored PK creds (or first connected biz with a PK integration).
//
// Goals (yes/no + sample payload for each):
//   1. Shift templates — is there an endpoint listing the named slots
//      separately, or are they only embedded in /work-periods/?
//   2. Period names — what does period_name actually contain in real data?
//      Templates ("Kväll", "Kök") or shift descriptions ("Tisdag kväll")?
//   3. Costgroup — section/department, or pay-group, or something else?
//   4. Position / role per shift — anywhere in the payload?
//   5. Section colour — anywhere in the API or only in PK's web UI?
//   6. Availability / time-off requests — endpoint?
//   7. Write endpoints — does PK accept POST/PUT on /work-periods/?
//      Probe via OPTIONS (should return Allow: GET, POST, etc.)
//
// Run: node --env-file=.env.production.local scripts/probe-pk-schedule-api.mjs

import { createClient } from '@supabase/supabase-js'

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Find a connected PK integration to borrow creds from
const { data: integ, error: integErr } = await db
  .from('integrations')
  .select('id, business_id, credentials_enc, businesses(name)')
  .eq('provider', 'personalkollen')
  .in('status', ['connected', 'warning', 'error'])
  .limit(1)
  .maybeSingle()
if (integErr) { console.error('integration lookup failed:', integErr.message); process.exit(1) }
if (!integ) { console.error('No connected PK integration found'); process.exit(1) }

const { decrypt } = await import('../lib/integrations/encryption.ts')
const decoded = decrypt(integ.credentials_enc) ?? ''
// PK creds are sometimes a bare token string, sometimes a JSON envelope.
let token
try {
  const obj = JSON.parse(decoded)
  token = obj.access_token ?? obj.api_key ?? obj.token ?? obj
} catch {
  token = decoded   // bare token
}
if (!token || typeof token !== 'string') { console.error('Could not extract token. Decoded preview:', String(decoded).slice(0, 60)); process.exit(1) }
console.log(`Using PK creds from business: ${integ.businesses?.name ?? integ.business_id}\n`)

const BASE = 'https://personalkollen.se/api'
const auth = { 'Authorization': `Token ${token}`, 'Accept': 'application/json' }

async function probe(path, opts = {}) {
  const url = BASE + path
  try {
    const r = await fetch(url, { headers: auth, ...opts })
    const text = await r.text()
    let json
    try { json = JSON.parse(text) } catch { json = null }
    return { status: r.status, headers: Object.fromEntries(r.headers.entries()), text: text.slice(0, 500), json, jsonKeys: json?.results?.[0] ? Object.keys(json.results[0]) : (json && typeof json === 'object' ? Object.keys(json) : []) }
  } catch (e) {
    return { status: 0, error: e.message }
  }
}

console.log('=== PROBING PK ENDPOINTS ===\n')

const endpoints = [
  // Known-good baseline
  ['/staffs/?with_employments=true&page_size=1', 'Staff with employments'],
  ['/work-periods/?page_size=2&include_drafts=1', 'Work periods (existing scheduled shifts)'],
  ['/workplaces/?page_size=2', 'Workplaces'],

  // Candidate template / scheduling endpoints
  ['/shift-templates/?page_size=2', 'Shift templates?'],
  ['/period-templates/?page_size=2', 'Period templates?'],
  ['/work-period-templates/?page_size=2', 'Work period templates?'],
  ['/periods/?page_size=2', 'Periods?'],
  ['/templates/?page_size=2', 'Templates?'],
  ['/schedules/?page_size=2', 'Schedules?'],

  // Position / role endpoints
  ['/positions/?page_size=2', 'Positions?'],
  ['/work-positions/?page_size=2', 'Work positions?'],
  ['/roles/?page_size=2', 'Roles?'],
  ['/staff-positions/?page_size=2', 'Staff positions?'],

  // Sections / cost groups
  ['/costgroups/?page_size=2', 'Cost groups?'],
  ['/cost-groups/?page_size=2', 'Cost groups (dashed)?'],
  ['/sections/?page_size=2', 'Sections?'],
  ['/departments/?page_size=2', 'Departments?'],

  // Availability / time-off
  ['/availability/?page_size=2', 'Availability?'],
  ['/availabilities/?page_size=2', 'Availabilities?'],
  ['/time-off/?page_size=2', 'Time off?'],
  ['/leave-requests/?page_size=2', 'Leave requests?'],
  ['/vacation/?page_size=2', 'Vacation?'],
  ['/absences/?page_size=2', 'Absences?'],
  ['/staff-availabilities/?page_size=2', 'Staff availabilities?'],

  // Contracts (with_employments already on /staffs/ but is there a top-level?)
  ['/employments/?page_size=2', 'Employments (top-level)?'],
  ['/contracts/?page_size=2', 'Contracts?'],

  // Discovery
  ['/', 'API root (lists endpoints)?'],
  ['/?format=api', 'DRF browsable view?'],
]

for (const [path, label] of endpoints) {
  const r = await probe(path)
  const status = r.status === 200 ? 'OK ' : (r.status === 404 ? '404' : (r.status === 401 || r.status === 403 ? 'AUTH' : `${r.status}`))
  console.log(`[${status}] ${path}  — ${label}`)
  if (r.status === 200 && r.jsonKeys.length > 0) {
    console.log(`       keys: ${r.jsonKeys.slice(0, 15).join(', ')}${r.jsonKeys.length > 15 ? '...' : ''}`)
    if (r.json?.results?.[0]) {
      console.log(`       sample: ${JSON.stringify(r.json.results[0]).slice(0, 280)}`)
    } else if (r.json) {
      console.log(`       body:   ${JSON.stringify(r.json).slice(0, 280)}`)
    }
  }
  await new Promise(r => setTimeout(r, 80))   // be polite to PK
}

console.log('\n=== PROBING WRITE METHODS ON /work-periods/ ===\n')
const optsRes = await probe('/work-periods/', { method: 'OPTIONS' })
console.log('OPTIONS /work-periods/:', optsRes.status, optsRes.headers?.allow ?? '(no Allow header)')

// Also check OPTIONS on /staffs/ as a known-good baseline
const optsStaff = await probe('/staffs/', { method: 'OPTIONS' })
console.log('OPTIONS /staffs/:      ', optsStaff.status, optsStaff.headers?.allow ?? '(no Allow header)')

console.log('\n=== DEEP-DIVE ON /work-periods/ SAMPLE ===\n')
// Pull one shift with ALL fields visible
const deep = await probe('/work-periods/?page_size=3&include_drafts=1')
if (deep.json?.results) {
  for (const p of deep.json.results) {
    console.log('---')
    console.log(JSON.stringify(p, null, 2))
  }
}
