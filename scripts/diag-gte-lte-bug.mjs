#!/usr/bin/env node
// scripts/diag-gte-lte-bug.mjs
//
// Definitively answer: does the .gte().lte() chain on a `date` column via
// Supabase JS client / PostgREST silently drop top-boundary rows, as
// claimed in CLAUDE.md §10b + FIXES §0?
//
// Original incident (2026-04-18):
//   .gte('revenue_date', from).lte('revenue_date', to) returned 406 rows
//   .gte('revenue_date', from)  → in-memory filter <= to returned 412 rows
//   Apr 17 (the top-boundary date) silently dropped — exactly 6 rows.
//
// External perf review (2026-04-26) pushed back: "more likely date-string
// format". This script tests it head-to-head against current production data.
//
// Run: node scripts/diag-gte-lte-bug.mjs
//
// Outputs three counts for the same date range against revenue_logs:
//   1. .gte().lte()  (Supabase JS client style, the suspect pattern)
//   2. .gte()        + JS in-memory filter <= to (the workaround in use)
//   3. raw SQL via /rest/v1/rpc — ground truth via PostgREST
//
// If counts 1, 2, 3 agree → bug not real → workaround can be dropped.
// If count 1 < counts 2 == 3 → bug confirmed → workaround stays + rule strengthens.

import { readFileSync } from 'node:fs'

function parseEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter(l => l.includes('=') && !l.trim().startsWith('#'))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
    )
  } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const ORG  = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    headers: {
      apikey:        KEY,
      Authorization: `Bearer ${KEY}`,
      Prefer:        'count=exact',
    },
  })
  const ct  = r.headers.get('content-range') ?? ''
  const tot = ct.split('/')[1]
  const rows = await r.json().catch(() => [])
  return { count: tot ? Number(tot) : (Array.isArray(rows) ? rows.length : 0), rows }
}

// Find the latest date that actually has rows so the boundary check is
// meaningful. Without this, picking "today" can give 0 rows on the
// boundary and the bug can't manifest.
const latestRes = await rest(
  `revenue_logs?org_id=eq.${ORG}&business_id=eq.${VERO}` +
  `&select=revenue_date&order=revenue_date.desc&limit=1`
)
const latestDate = latestRes.rows?.[0]?.revenue_date
if (!latestDate) {
  console.error('No revenue_logs rows for Vero — abort.')
  process.exit(1)
}
const TO   = latestDate
const FROM = new Date(new Date(latestDate).getTime() - 30 * 86400_000).toISOString().slice(0, 10)

console.log(`Testing range ${FROM} → ${TO} on revenue_logs for Vero (org ${ORG.slice(0, 8)}…)`)
console.log(`Top boundary intentionally aligned with latest row date so bug can manifest.\n`)

// ── Test 1: .gte().lte() chain — the suspect ────────────────────────────────
const res1 = await rest(
  `revenue_logs?org_id=eq.${ORG}&business_id=eq.${VERO}` +
  `&revenue_date=gte.${FROM}&revenue_date=lte.${TO}` +
  `&select=revenue_date,revenue&order=revenue_date.desc&limit=10000`
)
console.log(`1. .gte().lte() chain   → ${res1.count} rows`)

// ── Test 2: .gte() + in-memory filter — the workaround ──────────────────────
const res2 = await rest(
  `revenue_logs?org_id=eq.${ORG}&business_id=eq.${VERO}` +
  `&revenue_date=gte.${FROM}` +
  `&select=revenue_date,revenue&order=revenue_date.desc&limit=10000`
)
const filtered2 = (res2.rows ?? []).filter(r => r.revenue_date <= TO)
console.log(`2. .gte() + JS filter   → ${filtered2.length} rows (raw .gte returned ${res2.count})`)

// ── Test 3: range header version (alternative bound expression) ─────────────
//   PostgREST also supports "and(...)" group syntax as a sanity check.
const res3 = await rest(
  `revenue_logs?and=(org_id.eq.${ORG},business_id.eq.${VERO},revenue_date.gte.${FROM},revenue_date.lte.${TO})` +
  `&select=revenue_date,revenue&order=revenue_date.desc&limit=10000`
)
console.log(`3. and(...) group       → ${res3.count} rows`)

// ── Boundary check: how many rows are AT the top boundary? ──────────────────
const boundary = (res2.rows ?? []).filter(r => r.revenue_date === TO)
console.log(`\nRows ON top boundary date (${TO}): ${boundary.length}`)

// ── Verdict ─────────────────────────────────────────────────────────────────
console.log('\n— VERDICT —')
if (res1.count === filtered2.length && res1.count === res3.count) {
  console.log('✅ All three counts AGREE — the .gte().lte() bug does NOT reproduce on current data.')
  console.log('   Safe to drop the §10b workaround. Update CLAUDE.md to retire the rule.')
} else if (res1.count < filtered2.length) {
  const missing = filtered2.length - res1.count
  console.log(`❌ .gte().lte() returned ${missing} fewer rows than .gte() + JS filter.`)
  console.log('   Bug REPRODUCES. Keep the §10b workaround. Strengthen the rule with this evidence.')
  // Print the dates the chain dropped so we know exactly which boundary.
  const got1 = new Set((res1.rows ?? []).map(r => r.revenue_date))
  const dropped = [...new Set(filtered2.filter(r => !got1.has(r.revenue_date)).map(r => r.revenue_date))]
  console.log(`   Dropped dates: ${dropped.join(', ')}`)
} else {
  console.log(`⚠ Counts disagree in an unexpected way: chain=${res1.count} workaround=${filtered2.length} group=${res3.count}`)
  console.log('   Investigate manually.')
}
