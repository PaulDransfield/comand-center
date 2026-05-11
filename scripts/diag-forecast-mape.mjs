#!/usr/bin/env node
// scripts/diag-forecast-mape.mjs
//
// Direct read of v_forecast_mape_by_surface for Vero — what's the actual
// MAPE on each forecaster surface, side by side, for resolved (closed)
// forecasts only?
//
// Surfaces tracked:
//   - consolidated_daily        — Piece 2 (the new one we've been backtesting)
//   - scheduling_ai_revenue     — legacy ai-suggestion endpoint (powers dashboard)
//   - weather_demand            — legacy lib/weather/demand.ts (DemandOutlook)
//   - llm_adjusted              — Piece 4 LLM-adjusted (enrichment)
//
// The view groups by surface × prediction_horizon_days. We care about
// horizon=1 for an apples-to-apples comparison against today's backtest.

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

const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

async function pg(path, params = {}) {
  const qs = new URLSearchParams(params).toString()
  const r = await fetch(`${URL}/rest/v1/${path}${qs ? '?' + qs : ''}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  })
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`)
  return r.json()
}

console.log('── v_forecast_mape_by_surface for Vero ──\n')

const rows = await pg('v_forecast_mape_by_surface', {
  business_id: `eq.${VERO}`,
  order:       'surface.asc,prediction_horizon_days.asc',
})

if (rows.length === 0) {
  console.log('No rows in view. Either no resolved forecasts exist, or M065 view is missing.')
  process.exit(0)
}

// Pretty print
console.log('surface                    horizon  resolved  MAPE %   bias %    stddev %  earliest    latest')
console.log('--------------------------------------------------------------------------------------------')
for (const r of rows) {
  const surface = r.surface.padEnd(25)
  const horizon = String(r.prediction_horizon_days).padStart(7)
  const resolved = String(r.resolved_rows).padStart(9)
  const mape = (r.mape_pct?.toFixed(1) ?? 'null').padStart(8)
  const bias = (r.bias_pct?.toFixed(1) ?? 'null').padStart(8)
  const stddev = (r.error_stddev_pct?.toFixed(1) ?? 'null').padStart(9)
  console.log(`${surface}${horizon}${resolved}${mape}${bias}${stddev}  ${r.earliest_forecast?.slice(0,10) ?? '?'}  ${r.latest_forecast?.slice(0,10) ?? '?'}`)
}

console.log('\n── Resolved-forecast counts by surface (raw) ──\n')
const counts = await pg('daily_forecast_outcomes', {
  business_id:    `eq.${VERO}`,
  resolved_at:    'not.is.null',
  select:         'surface',
})
const tally = {}
for (const r of counts) tally[r.surface] = (tally[r.surface] ?? 0) + 1
for (const [s, n] of Object.entries(tally).sort()) console.log(`  ${s.padEnd(28)} ${n}`)
