// Manual end-to-end sync test: pulls Employees from Caspeco, upserts
// into caspeco_employees, reports counts. Mirrors the production
// sync's mapping logic exactly.
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error('missing env'); process.exit(1) }
const db = createClient(url, key, { auth: { persistSession: false } })

const KEY_PART = process.argv[2]
if (!KEY_PART) { console.error('pass the key part as arg 1'); process.exit(1) }
const PAT = `Comandcenter-2026-06-09-2094-06-09--${KEY_PART}`

const { data: integ } = await db
  .from('integrations')
  .select('id, org_id, business_id, metadata, status')
  .eq('provider', 'caspeco')
  .maybeSingle()
if (!integ) { console.error('No Caspeco integration row in DB'); process.exit(1) }

const companyid = integ.metadata?.caspeco_company_id
console.log(`Found Caspeco integration: business_id=${integ.business_id}, companyid=${companyid}`)

// Check table exists
try {
  const { count, error } = await db.from('caspeco_employees').select('id', { count: 'exact', head: true })
  if (error) { console.error('caspeco_employees check failed:', error.message); process.exit(1) }
  console.log(`caspeco_employees table OK. Pre-sync row count: ${count ?? 0}`)
} catch (e) { console.error(e.message); process.exit(1) }

// Pull employees from Caspeco
const r = await fetch('https://cloud.caspeco.se/api/v1/Employees', {
  headers: { Authorization: `Bearer ${PAT}`, Accept: 'application/json', companyid, 'x-csrf': '1' },
})
if (!r.ok) { console.error(`Caspeco GET failed: ${r.status} ${await r.text()}`); process.exit(1) }
const employees = await r.json()
console.log(`Caspeco returned ${employees.length} employees`)

// Map to caspeco_employees rows (exact match to syncCaspeco)
const rows = employees.map(e => {
  const employmentsByEnd = (e.employments ?? []).slice().sort((a, b) => {
    const ae = a.endDate ?? '9999-12-31'
    const be = b.endDate ?? '9999-12-31'
    return be.localeCompare(ae)
  })
  const current = employmentsByEnd[0] ?? null
  const latestChange = (current?.changePoints ?? []).slice().sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? ''))[0] ?? null
  return {
    org_id:                  integ.org_id,
    business_id:             integ.business_id,
    caspeco_employee_id:     e.id,
    caspeco_company_id:      companyid,
    caspeco_employee_number: e.employeeNumber ?? null,
    first_name:              e.firstName ?? null,
    last_name:               e.lastName  ?? null,
    personal_identity:       e.personalIdentity ?? null,
    email:                   e.email ?? null,
    current_employment_id:   current?.id ?? null,
    current_contract_id:     current?.contractId ?? null,
    current_profession_id:   latestChange?.localProfessionId ?? null,
    current_station_id:      latestChange?.defaultStationId  ?? null,
    employment_start_date:   current?.startDate ?? null,
    employment_end_date:     current?.endDate   ?? null,
    is_active:               current ? current.endDate == null : false,
    raw_payload:             e,
    last_synced_at:          new Date().toISOString(),
  }
})

// Upsert in batches
let upserted = 0
const BATCH = 50
for (let i = 0; i < rows.length; i += BATCH) {
  const slice = rows.slice(i, i + BATCH)
  const { error } = await db.from('caspeco_employees').upsert(slice, { onConflict: 'business_id,caspeco_employee_id' })
  if (error) {
    console.error(`Upsert failed at batch ${i}:`, error.message)
    process.exit(1)
  }
  upserted += slice.length
}
console.log(`Upserted ${upserted} rows`)

// Also pin station info
const sr = await fetch('https://cloud.caspeco.se/api/v1/Stations', {
  headers: { Authorization: `Bearer ${PAT}`, Accept: 'application/json', companyid, 'x-csrf': '1' },
})
if (sr.ok) {
  const stations = await sr.json()
  if (stations.length > 0) {
    const station = stations[0]
    const newMeta = { ...(integ.metadata ?? {}), caspeco_station_id: station.id, caspeco_station_name: station.name }
    await db.from('integrations').update({ metadata: newMeta }).eq('id', integ.id)
    console.log(`Pinned station metadata: ${station.name} (id=${station.id})`)
  }
}

// Verify
const { count: postCount } = await db.from('caspeco_employees').select('id', { count: 'exact', head: true })
console.log(`Post-sync caspeco_employees row count: ${postCount}`)

// Sample a row
const { data: sample } = await db.from('caspeco_employees').select('caspeco_employee_id, first_name, last_name, current_station_id, current_profession_id, is_active, employment_start_date').limit(5)
console.log()
console.log('Sample rows:')
for (const s of sample ?? []) console.log(' ', s)
