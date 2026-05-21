// scripts/probe-pk-write-capability.mjs
//
// Probe Personalkollen API for write capability — does our token have
// PUT / PATCH / POST / DELETE access on the shift endpoints?
//
// Strictly read-only: only OPTIONS requests are made (the HTTP method
// designed for capability discovery). Django REST Framework responds
// with an Allow header listing the methods our auth scope permits.
//
// Gating question for the roster write-back feature:
//   - Allow: GET, HEAD, OPTIONS                        → read-only, dead end
//   - Allow: GET, HEAD, OPTIONS, POST                  → create only
//   - Allow: GET, HEAD, OPTIONS, PUT, PATCH, DELETE    → full write — green light
//
// Endpoints probed (the ones relevant to roster cuts):
//   /work-periods/         — list endpoint (POST would create new shift)
//   /work-periods/<id>/    — detail endpoint (PATCH would update existing)
//
// Run: node scripts/probe-pk-write-capability.mjs

import { createClient } from '@supabase/supabase-js'
import { createDecipheriv } from 'crypto'
import dotenv from 'dotenv'
// Load production credentials first (real Supabase + encryption key live
// there), then overlay any local overrides.
dotenv.config({ path: '.env.production.local' })
dotenv.config({ path: '.env.local', override: false })

const VERO_BUSINESS_ID = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const VERO_ORG_ID      = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const encKey = process.env.CREDENTIAL_ENCRYPTION_KEY
if (!url || !key || !encKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CREDENTIAL_ENCRYPTION_KEY in .env.local')
  process.exit(1)
}

const db = createClient(url, key)

// Mirror lib/integrations/encryption.ts decrypt() so the script stays
// dependency-free.
function decrypt(b64) {
  if (!b64) return null
  const packed = Buffer.from(b64, 'base64')
  const iv         = packed.subarray(0, 12)
  const authTag    = packed.subarray(packed.length - 16)
  const ciphertext = packed.subarray(12, packed.length - 16)
  const k          = Buffer.from(encKey, 'hex')
  const decipher   = createDecipheriv('aes-256-gcm', k, iv, { authTagLength: 16 })
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

console.log('═══ Personalkollen write-capability probe ═══\n')

// 1. Get PK token for Vero
const { data: ints, error: intErr } = await db
  .from('integrations')
  .select('id, provider, credentials_enc, status')
  .or(`business_id.eq.${VERO_BUSINESS_ID},and(org_id.eq.${VERO_ORG_ID},business_id.is.null)`)
  .ilike('provider', 'personalkollen%')

if (intErr) {
  console.error('Failed to read integrations:', intErr.message)
  process.exit(1)
}
if (!ints || ints.length === 0) {
  console.error('No Personalkollen integration found for Vero')
  process.exit(1)
}

console.log(`Found ${ints.length} PK integration(s):`)
for (const i of ints) console.log(`  - ${i.provider} (status=${i.status}, id=${i.id.slice(-8)})`)
console.log()

const pkInt = ints[0]
const token = decrypt(pkInt.credentials_enc)
if (!token) {
  console.error('Failed to decrypt token')
  process.exit(1)
}
console.log(`Token decrypted (length ${token.length})\n`)

// 2. Fetch one work-period so we have a real ID for the detail-endpoint probe
console.log('── Fetching a sample work-period for the detail probe ──')
const listRes = await fetch('https://personalkollen.se/api/work-periods/?page_size=1', {
  headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
})
console.log(`GET /work-periods/?page_size=1 → ${listRes.status}`)
console.log(`Response Allow header: ${listRes.headers.get('allow') ?? '(not set)'}`)

if (!listRes.ok) {
  console.error('Cannot list work-periods — token may be invalid or expired')
  process.exit(1)
}

const listBody = await listRes.json()
const sample = listBody.results?.[0]
if (!sample) {
  console.log('No work-periods in the database to probe detail endpoint against. Will probe list endpoint only.\n')
} else {
  console.log(`Sample work-period: ${sample.url ?? sample.id ?? '(no url)'}\n`)
}

// 3. OPTIONS on list endpoint
console.log('── OPTIONS /work-periods/ (list endpoint) ──')
const opt1 = await fetch('https://personalkollen.se/api/work-periods/', {
  method: 'OPTIONS',
  headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
})
console.log(`Status: ${opt1.status}`)
console.log(`Allow header: ${opt1.headers.get('allow') ?? '(not set)'}`)
const opt1Body = await opt1.text()
if (opt1Body && opt1Body.length < 2000) {
  console.log('Body:')
  console.log(opt1Body.slice(0, 1500))
}
console.log()

// 4. OPTIONS on detail endpoint (if we have a sample)
if (sample?.url) {
  console.log(`── OPTIONS ${sample.url} (detail endpoint) ──`)
  const opt2 = await fetch(sample.url, {
    method: 'OPTIONS',
    headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
  })
  console.log(`Status: ${opt2.status}`)
  console.log(`Allow header: ${opt2.headers.get('allow') ?? '(not set)'}`)
  const opt2Body = await opt2.text()
  if (opt2Body && opt2Body.length < 2000) {
    console.log('Body:')
    console.log(opt2Body.slice(0, 1500))
  }
  console.log()
}

// 5. Also probe /logged-times/ and /shifts/ for completeness
for (const ep of ['/logged-times/', '/shifts/', '/absences/']) {
  console.log(`── OPTIONS ${ep} ──`)
  const r = await fetch(`https://personalkollen.se/api${ep}`, {
    method: 'OPTIONS',
    headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
  })
  console.log(`  Status: ${r.status}`)
  console.log(`  Allow header: ${r.headers.get('allow') ?? '(not set)'}`)
}

console.log('\n═══ Probe complete ═══')
console.log('Interpretation:')
console.log('  Allow: GET, HEAD, OPTIONS                      → READ-ONLY (dead end for write-back)')
console.log('  + PATCH or PUT                                  → can update existing shifts (CUT path enabled)')
console.log('  + POST                                          → can create new shifts (ADD path enabled)')
console.log('  + DELETE                                        → can remove shifts')
console.log('\nIf nothing beyond GET/HEAD/OPTIONS appears, the next step is emailing support@personalkollen.se')
console.log('asking about partner write access for the /work-periods/ endpoint.')
