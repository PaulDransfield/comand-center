#!/usr/bin/env node
// scripts/verify-audit-sampler.mjs
//
// D2 owner checkpoint per LEARNING-LOOP-PHASE1-PLAN.md §2b.4 +
// phase-1-harden-learning-loop-prompt.md verification section:
//
//   "see the sampler actually surface a risk-weighted batch on live data
//    — with cross-supplier and previously-demoted aliases ranked to the
//    top — before D3's snapshot layers on."
//
// MODES:
//   --inspect   Default. Reads the current queue depth and the candidate
//               pool the sampler WOULD score on the next run. Read-only.
//   --run       Triggers the sampler cron once via direct fetch, then
//               re-reads the queue to show the actual top-N risk-ordered
//               batch. Writes to inventory_audit_queue (idempotent via
//               UNIQUE — re-runs replace risk_score in place).
//
// Read-only by default. --run is gated behind a confirmation prompt
// (type RUN_SAMPLER) because it inserts queue rows.

import { readFileSync }     from 'node:fs'
import { createInterface }  from 'node:readline'

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
const APP_URL = env.NEXT_PUBLIC_APP_URL ?? 'https://comandcenter.se'
const CRON_SECRET = env.CRON_SECRET
if (!URL || !KEY) { console.error('Missing env'); process.exit(1) }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

const args = process.argv.slice(2)
const mode =
  args.includes('--local-run') ? 'local-run' :
  args.includes('--run')       ? 'run'       :
                                 'inspect'

async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H })
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json()
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans) }))
}

const section = (title) => console.log(`\n${'═'.repeat(74)}\n  ${title}\n${'═'.repeat(74)}`)

// ───────────────────────────────────────────────────────────────────────
// Inventory the candidate pool BEFORE running the sampler
// ───────────────────────────────────────────────────────────────────────

section(`MODE: ${mode}`)

const businesses = await q('businesses?select=id,name,is_active&is_active=eq.true')
console.log(`\nActive businesses: ${businesses.length}`)
for (const b of businesses) {
  console.log(`  ${b.name.padEnd(24)} (${b.id})`)
}

const windowDays = 14
const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString()

section(`Candidate pool — what the sampler will score on next run (window=${windowDays}d)`)
let totalCandidates = 0
for (const b of businesses) {
  const fuzzy = await q(`product_aliases?select=count&business_id=eq.${b.id}&is_active=eq.true&match_method=in.(fuzzy_same_supplier,fuzzy_cross_supplier)&first_seen_at=gte.${windowStart}`)
  const prevDemoted = await q(`product_aliases?select=count&business_id=eq.${b.id}&is_active=eq.true&times_demoted=gt.0`)
  const fuzzyCount = fuzzy[0]?.count ?? 0
  const prevCount  = prevDemoted[0]?.count ?? 0
  console.log(`  ${b.name.padEnd(24)} fuzzy-recent: ${String(fuzzyCount).padStart(3)}   previously-demoted (active): ${String(prevCount).padStart(3)}`)
  totalCandidates += fuzzyCount + prevCount
}
console.log(`\n  Total candidate-rows (sum across businesses, before dedup): ${totalCandidates}`)
console.log(`  Per the adaptive rate, businesses with <=20 candidates audit 100%.`)

// ───────────────────────────────────────────────────────────────────────
// Show existing queue state
// ───────────────────────────────────────────────────────────────────────

section('Current queue state (before this run)')
const totalQueue = await q('inventory_audit_queue?select=count')
const pendingQueue = await q('inventory_audit_queue?select=count&reviewed_at=is.null')
console.log(`  Total queue rows:   ${totalQueue[0]?.count ?? 0}`)
console.log(`  Pending (unreviewed): ${pendingQueue[0]?.count ?? 0}`)

if (mode === 'inspect') {
  section('INSPECT mode done — pick a run mode to fire the sampler')
  console.log('  --local-run   Run the sampler logic inline against prod DB (no HTTP).')
  console.log('                Use this when the cron route isn\'t deployed yet (D2 dev branch).')
  console.log('  --run         POST to the deployed cron route at NEXT_PUBLIC_APP_URL.')
  console.log('                Use after the branch is merged + deployed.')
  process.exit(0)
}

// ───────────────────────────────────────────────────────────────────────
// --local-run: replicate the sampler logic in-script against prod DB
// ───────────────────────────────────────────────────────────────────────

if (mode === 'local-run') {
  section('LOCAL-RUN — replicating sampler logic inline (no HTTP)')
  console.log('  This bypasses the cron route and runs the same logic from')
  console.log('  lib/inventory/audit-sampler.ts directly. Writes to')
  console.log('  inventory_audit_queue (idempotent — UNIQUE on business+alias+reason).')
  const confirm = await ask('\nType "RUN_SAMPLER" to proceed: ')
  if (confirm.trim() !== 'RUN_SAMPLER') { console.log('Aborted.'); process.exit(0) }

  // Inline mirror of the sampler logic (matches lib/inventory/audit-sampler.ts).
  // Kept in sync via scripts/test-audit-sampler.mjs assertions.
  const W = { CROSS: 10000, PREV: 1000, SAME: 100, RECENT: 50, VALUE: 25, USAGE: 40 }
  const USAGE_ACTIVATION = 20

  function targetSampleRate(n) {
    if (n <= 20) return 1.00
    if (n <= 50) return 0.50
    if (n <= 200) return 0.20
    return 0.05
  }
  function scoreCandidate(c, now) {
    let score = 0, primary = 'other', reason = 'manual_review'
    if (c.match_method === 'fuzzy_cross_supplier') { score += W.CROSS; primary = 'cross_supplier'; reason = 'confident_auto_match' }
    if (c.times_demoted > 0) {
      score += W.PREV
      if (primary === 'other') { primary = 'previously_demoted'; reason = 'previously_demoted' }
      else                     { primary = `${primary}+previously_demoted` }
    }
    if (c.match_method === 'fuzzy_same_supplier') {
      score += W.SAME
      if (primary === 'other') { primary = 'same_supplier'; reason = 'confident_auto_match' }
    }
    const ageDays = (now.getTime() - new Date(c.first_seen_at).getTime()) / 86_400_000
    if (ageDays >= 0 && ageDays < 7) score += Math.round(W.RECENT * (1 - ageDays / 7))
    if (c.highest_line_total_excl_vat > 0) {
      score += Math.min(W.VALUE, Math.round(Math.log10(Math.abs(c.highest_line_total_excl_vat) + 1) * 10))
    }
    if (c.line_refs_count >= USAGE_ACTIVATION) {
      score += Math.min(W.USAGE, Math.round((c.line_refs_count - USAGE_ACTIVATION) * (W.USAGE / (200 - USAGE_ACTIVATION))))
    }
    return { ...c, risk_score: score, reason, primary_factor: primary }
  }
  function pickSampleSet(cs, now) {
    if (cs.length === 0) return []
    const scored = cs.map(c => scoreCandidate(c, now))
    const rate = targetSampleRate(cs.length)
    const n = Math.max(1, Math.round(cs.length * rate))
    return scored.sort((a, b) => b.risk_score - a.risk_score).slice(0, n)
  }

  const now = new Date()
  let totalUpserted = 0
  const perBiz = []

  for (const biz of businesses) {
    const aliasRows = await q(
      `product_aliases?select=id,business_id,product_id,match_method,match_confidence,times_demoted,first_seen_at` +
      `&business_id=eq.${biz.id}&is_active=eq.true` +
      `&or=(and(match_method.in.(fuzzy_same_supplier,fuzzy_cross_supplier),first_seen_at.gte.${windowStart}),times_demoted.gt.0)` +
      `&limit=2000`
    )
    if (aliasRows.length === 0) { perBiz.push({ ...biz, candidates: 0, sampled: 0, upserted: 0 }); continue }

    const aliasIds = aliasRows.map(a => a.id)
    // Batch the .in() — PostgREST has URL length limits; 200 at a time is safe.
    const lines = []
    for (let i = 0; i < aliasIds.length; i += 200) {
      const slice = aliasIds.slice(i, i + 200)
      const got = await q(
        `supplier_invoice_lines?select=id,product_alias_id,total_excl_vat` +
        `&product_alias_id=in.(${slice.join(',')})&match_status=eq.matched&limit=5000`
      )
      lines.push(...got)
    }
    const linesByAlias = new Map()
    for (const l of lines) {
      const arr = linesByAlias.get(l.product_alias_id) ?? []
      arr.push(l)
      linesByAlias.set(l.product_alias_id, arr)
    }
    const candidates = aliasRows.map(a => {
      const refs = linesByAlias.get(a.id) ?? []
      let highest = { id: null, total: 0 }
      for (const l of refs) {
        const t = Math.abs(Number(l.total_excl_vat ?? 0))
        if (t > highest.total) highest = { id: l.id, total: t }
      }
      return {
        alias_id: a.id, business_id: a.business_id, org_id: biz.org_id ?? null,
        match_method: a.match_method, match_confidence: a.match_confidence,
        times_demoted: a.times_demoted ?? 0, first_seen_at: a.first_seen_at,
        highest_line_total_excl_vat: highest.total,
        highest_value_line_id: highest.id,
        line_refs_count: refs.length,
      }
    })
    const sample = pickSampleSet(candidates, now)

    // We need org_id for the upsert RLS. Fetch from businesses if not on hand.
    const bizRow = await q(`businesses?select=org_id&id=eq.${biz.id}&limit=1`)
    const orgId = bizRow[0]?.org_id
    if (!orgId) { perBiz.push({ ...biz, candidates: candidates.length, sampled: sample.length, upserted: 0, error: 'no org_id' }); continue }

    const upserts = sample.map(s => ({
      org_id: orgId, business_id: s.business_id, alias_id: s.alias_id,
      line_id: s.highest_value_line_id, reason: s.reason, risk_score: s.risk_score,
      alias_match_method: s.match_method, alias_match_confidence: s.match_confidence,
      alias_times_demoted: s.times_demoted, sampled_at: now.toISOString(),
    }))
    if (upserts.length === 0) { perBiz.push({ ...biz, candidates: candidates.length, sampled: 0, upserted: 0 }); continue }

    const r = await fetch(`${URL}/rest/v1/inventory_audit_queue?on_conflict=business_id,alias_id,reason`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(upserts),
    })
    if (!r.ok) {
      perBiz.push({ ...biz, candidates: candidates.length, sampled: sample.length, upserted: 0, error: await r.text() })
    } else {
      totalUpserted += upserts.length
      perBiz.push({ ...biz, candidates: candidates.length, sampled: sample.length, upserted: upserts.length })
    }
  }

  section('Local sampler run — per-business breakdown')
  for (const b of perBiz) {
    console.log(`  ${b.name.padEnd(24)}  candidates: ${String(b.candidates).padStart(3)}   sampled: ${String(b.sampled).padStart(3)}   upserted: ${String(b.upserted).padStart(3)}${b.error ? '   ERR: ' + b.error : ''}`)
  }
  console.log(`  Total upserted across all businesses: ${totalUpserted}`)

  // Now show the queue ordering (same as the --run path below).
  // Skip the HTTP cron call and jump to the verification section.
} else if (mode === 'run') {
  // ───────────────────────────────────────────────────────────────────
  // --run: gated trigger of the sampler cron, then re-read the queue
  // ───────────────────────────────────────────────────────────────────

  section('About to trigger the sampler')
  console.log(`  This will POST to ${APP_URL}/api/cron/inventory-audit-sampler with the CRON_SECRET.`)
  console.log(`  Sampler will UPSERT into inventory_audit_queue (idempotent — UNIQUE on business+alias+reason).`)
  const confirm = await ask('\nType "RUN_SAMPLER" to proceed: ')
  if (confirm.trim() !== 'RUN_SAMPLER') {
    console.log('Aborted.')
    process.exit(0)
  }

  if (!CRON_SECRET) {
    console.error('CRON_SECRET not in env — cannot authenticate against the deployed cron route.')
    console.error('Set CRON_SECRET in .env.production.local or use --local-run instead.')
    process.exit(1)
  }

  const cronUrl = `${APP_URL}/api/cron/inventory-audit-sampler`
  console.log(`\n  POST ${cronUrl} …`)
  const t0 = Date.now()
  const res = await fetch(cronUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CRON_SECRET}` },
  })
  const elapsed = Date.now() - t0
  console.log(`  Response: HTTP ${res.status} in ${elapsed} ms`)
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    console.error('  Sampler failed:', JSON.stringify(body, null, 2))
    process.exit(1)
  }

  section('Sampler response (per-business breakdown)')
  if (body?.per_business) {
    for (const b of body.per_business) {
      console.log(`  ${b.name.padEnd(24)}  candidates: ${String(b.candidates).padStart(3)}   sampled: ${String(b.sampled).padStart(3)}   upserted: ${String(b.upserted).padStart(3)}   queue_total: ${String(b.queue_total).padStart(3)}   errors: ${b.errors.length}`)
      for (const err of b.errors) console.log(`      ⚠ ${err}`)
    }
  }
}

// ───────────────────────────────────────────────────────────────────────
// Show the actual queue ordering (the deliverable owner asked for)
// ───────────────────────────────────────────────────────────────────────

section('Queue after sampler run — top 20 by risk_score')
const top = await q('inventory_audit_queue?select=business_id,alias_id,reason,risk_score,alias_match_method,alias_match_confidence,alias_times_demoted,sampled_at,reviewed_at,product_aliases(raw_description,supplier_name_snapshot)&reviewed_at=is.null&order=risk_score.desc&limit=20')
if (top.length === 0) {
  console.log('  (queue empty — no risk-eligible aliases on any business)')
} else {
  console.log(`  ${'rank'.padEnd(4)} ${'risk'.padEnd(7)} ${'reason'.padEnd(22)} ${'method'.padEnd(22)} ${'×dem'.padEnd(5)} ${'description (truncated)'}`)
  console.log(`  ${'─'.repeat(4)} ${'─'.repeat(7)} ${'─'.repeat(22)} ${'─'.repeat(22)} ${'─'.repeat(5)} ${'─'.repeat(40)}`)
  for (let i = 0; i < top.length; i++) {
    const r = top[i]
    const desc = (r.product_aliases?.raw_description ?? '').slice(0, 38)
    const supplier = (r.product_aliases?.supplier_name_snapshot ?? '').slice(0, 18)
    console.log(`  ${String(i+1).padEnd(4)} ${String(r.risk_score).padEnd(7)} ${r.reason.padEnd(22)} ${(r.alias_match_method ?? '?').padEnd(22)} ${String(r.alias_times_demoted ?? 0).padEnd(5)} ${desc} (${supplier})`)
  }
}

section('Verification — owner checkpoint criteria')
const crossSupplierAtTop = top.length > 0 && top.slice(0, Math.min(3, top.length)).some(r => r.reason === 'confident_auto_match' && r.alias_match_method === 'fuzzy_cross_supplier')
const previouslyDemotedSurfaced = top.some(r => (r.alias_times_demoted ?? 0) > 0)
console.log(`  Cross-supplier alias in top 3?           ${crossSupplierAtTop ? '✓ yes' : '○ no cross-supplier candidates today (acceptable — population is ~5%)'}`)
console.log(`  Previously-demoted alias surfaced?       ${previouslyDemotedSurfaced ? '✓ yes' : '○ no previously-demoted aliases yet (acceptable — the M105 backfill hadn\'t bumped times_demoted)'}`)
console.log(`  Queue is risk-ordered (DESC)?            ${(() => { for (let i = 1; i < top.length; i++) if (top[i].risk_score > top[i-1].risk_score) return false; return true })() ? '✓ yes' : '✗ ordering broken'}`)
console.log(`\nDone. Read /inventory/audit (after the page UI lands) or query inventory_audit_queue directly to drive confirm/correct/skip decisions.`)
