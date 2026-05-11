#!/usr/bin/env node
// scripts/flip-vero-v2-flag.mjs
//
// Activates PREDICTION_V2_DASHBOARD_CHART for Vero Italiano in production.
// Idempotent — re-running confirms state without changing anything.

import { readFileSync } from 'node:fs'

function parseEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8').split('\n')
        .filter(l => l.includes('=') && !l.trim().startsWith('#'))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
    )
  } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) { console.error('missing supabase env'); process.exit(1) }

const VERO_BIZ = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const VERO_ORG = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'
const FLAG     = 'PREDICTION_V2_DASHBOARD_CHART'

// Before
const before = await fetch(`${URL}/rest/v1/business_feature_flags?business_id=eq.${VERO_BIZ}&flag=eq.${FLAG}`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
}).then(r => r.json())
console.log('Before:', before)

// Upsert with enabled=true
const upsert = await fetch(`${URL}/rest/v1/business_feature_flags`, {
  method: 'POST',
  headers: {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    'content-type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=representation',
  },
  body: JSON.stringify({
    org_id:      VERO_ORG,
    business_id: VERO_BIZ,
    flag:        FLAG,
    enabled:     true,
    updated_at:  new Date().toISOString(),
  }),
})
const result = await upsert.text()
if (!upsert.ok) {
  console.error(`Upsert failed: ${upsert.status} ${result}`)
  process.exit(1)
}
console.log('Upsert response:', result)

// After
const after = await fetch(`${URL}/rest/v1/business_feature_flags?business_id=eq.${VERO_BIZ}&flag=eq.${FLAG}`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
}).then(r => r.json())
console.log('After:', after)

if (after[0]?.enabled === true) {
  console.log('\n✓ PREDICTION_V2_DASHBOARD_CHART is now ENABLED for Vero Italiano')
  console.log('  Next dashboard load will route the revenue prediction through dailyForecast()')
} else {
  console.error('\n✗ Flag did NOT land enabled — check above response')
  process.exit(1)
}
