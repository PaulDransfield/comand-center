#!/usr/bin/env node
// scripts/rollback-vero-v2-dashboard-flag.mjs
//
// Rolls back PREDICTION_V2_DASHBOARD_CHART for Vero Italiano. Phase 0
// measurement (2026-05-19) showed legacy scheduling_ai_revenue at 28.8 %
// MAPE on h=7 — better than consolidated_v1.5.0 at h=1 medium (39.3 %).
// Until we have forward-horizon resolved-row data on consolidated_daily,
// the dashboard chart should route through the proven legacy path.
//
// Idempotent — re-running confirms state.

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

const before = await fetch(`${URL}/rest/v1/business_feature_flags?business_id=eq.${VERO_BIZ}&flag=eq.${FLAG}`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
}).then(r => r.json())
console.log('Before:', before)

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
    enabled:     false,
    updated_at:  new Date().toISOString(),
  }),
})
const result = await upsert.text()
if (!upsert.ok) {
  console.error(`Upsert failed: ${upsert.status} ${result}`)
  process.exit(1)
}
console.log('Upsert response:', result)

const after = await fetch(`${URL}/rest/v1/business_feature_flags?business_id=eq.${VERO_BIZ}&flag=eq.${FLAG}`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
}).then(r => r.json())
console.log('After:', after)

if (after[0]?.enabled === false) {
  console.log('\n✓ PREDICTION_V2_DASHBOARD_CHART is now DISABLED for Vero Italiano')
  console.log('  Dashboard chart and scheduling AI revert to legacy scheduling_ai_revenue.')
  console.log('  Consolidated_daily continues to run in shadow mode (after capture-gap fix lands).')
} else {
  console.error('\n✗ Flag did NOT land disabled — check above response')
  process.exit(1)
}
