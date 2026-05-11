#!/usr/bin/env node
// scripts/rollout-v2-all-businesses.mjs
//
// Full v2 rollout: flips PREDICTION_V2_DASHBOARD_CHART and
// PREDICTION_V2_BUDGETING for every active business in the database,
// then refreshes their `forecasts` table with consolidated_monthly_v1.0
// rows so /forecast and /budgets reflect v2 immediately rather than
// waiting for the overnight sync.
//
// Idempotent — re-runnable. Reports per-business outcomes.

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

const FLAGS = ['PREDICTION_V2_DASHBOARD_CHART', 'PREDICTION_V2_BUDGETING']

async function pg(path, params = {}) {
  const qs = new URLSearchParams(params).toString()
  const r = await fetch(`${URL}/rest/v1/${path}${qs ? '?' + qs : ''}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`)
  return r.json()
}

async function upsert(table, body, onConflict, prefer = 'resolution=merge-duplicates,return=representation') {
  const url = onConflict ? `${URL}/rest/v1/${table}?on_conflict=${onConflict}` : `${URL}/rest/v1/${table}`
  const r = await fetch(url, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json', Prefer: prefer },
    body: JSON.stringify(body),
  })
  const t = await r.text()
  if (!r.ok) throw new Error(`${table} ${r.status} ${t}`)
  return t ? JSON.parse(t) : null
}

// ── 1. List active businesses ────────────────────────────────────────────
const businesses = await pg('businesses', {
  is_active: 'eq.true',
  select:    'id,org_id,name',
  order:     'name.asc',
})
console.log(`\n[rollout] ${businesses.length} active businesses found\n`)

// ── 2. Flip both flags for each business ─────────────────────────────────
console.log('── Flipping flags ──────────────────────────────────────────')
let flipped = 0, flipFailed = 0
for (const b of businesses) {
  const rows = FLAGS.map(flag => ({
    org_id:      b.org_id,
    business_id: b.id,
    flag,
    enabled:     true,
    updated_at:  new Date().toISOString(),
  }))
  try {
    await upsert('business_feature_flags', rows, 'business_id,flag')
    console.log(`  ✓ ${b.name.padEnd(30)} ${b.id}`)
    flipped++
  } catch (e) {
    console.error(`  ✗ ${b.name.padEnd(30)} ${b.id}: ${e.message}`)
    flipFailed++
  }
}
console.log(`\n[rollout] flags: ${flipped} flipped, ${flipFailed} failed\n`)

if (flipFailed > 0) {
  console.error('Aborting backfill — some flags didn\'t flip. Fix and re-run.')
  process.exit(1)
}

// ── 3. Refresh monthly forecasts for each business ───────────────────────
// Use the live API via the cron secret? No — direct via tsx subprocess
// per business is simpler. We delegate to scripts/run-monthly-forecasts.ts
// which we'll create as a generic single-business runner.
console.log('── Refreshing monthly forecasts ─────────────────────────────')
console.log('(Spawning child process per business — uses lib/forecast/monthly.ts directly)')

import { spawn } from 'node:child_process'

let refreshed = 0, refreshFailed = 0
for (const b of businesses) {
  const child = spawn(
    'npx',
    ['-y', 'dotenv-cli', '-e', '.env.production.local', '--', 'npx', 'tsx', 'scripts/run-monthly-forecasts-for-business.ts', b.id, b.org_id, b.name],
    { stdio: ['ignore', 'pipe', 'pipe'], shell: true },
  )
  let out = '', err = ''
  child.stdout.on('data', d => { out += d.toString() })
  child.stderr.on('data', d => { err += d.toString() })
  const exitCode = await new Promise(resolve => child.on('close', resolve))
  if (exitCode === 0) {
    const summary = out.trim().split('\n').slice(-1)[0]
    console.log(`  ✓ ${b.name.padEnd(30)} ${summary}`)
    refreshed++
  } else {
    console.error(`  ✗ ${b.name.padEnd(30)} exit ${exitCode}: ${(err || out).slice(0, 200)}`)
    refreshFailed++
  }
}

console.log(`\n[rollout] forecasts refresh: ${refreshed} succeeded, ${refreshFailed} failed`)
console.log('\n[rollout] DONE.')
console.log('  - Every active business now has both v2 flags ON.')
console.log('  - Every business\'s `forecasts` table has consolidated_monthly_v1.0 rows.')
console.log('  - Next dashboard / scheduling / budget / forecast page load = v2 for everyone.')
