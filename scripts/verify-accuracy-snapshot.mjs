#!/usr/bin/env node
// scripts/verify-accuracy-snapshot.mjs
//
// D3 checkpoint per LEARNING-LOOP-PHASE1-PLAN.md §3b.4. Owner-locked:
//
//   "the synthetic-regression test is the D3 equivalent of the demotion
//    round-trip — it's the proof the monitor actually monitors."
//
// MODES:
//   --inspect      Default. Read-only. Shows what's in
//                  inventory_accuracy_snapshots today + previews what
//                  the next cron run would compute (counts only, no DB
//                  writes).
//   --local-run    Replicates the cron inline against prod DB. Writes
//                  today's snapshot rows for each (org, business + global).
//                  Idempotent (UPSERT on the natural key).
//   --synthetic    The verdict-locking matrix. Runs the §7.1 floor
//                  logic in-script against five synthetic scenarios:
//                    1. 12pp drop, ≥50 outcomes  → expect 'hard'
//                    2. 6pp  drop, ≥50 outcomes  → expect 'soft'
//                    3. 12pp drop, <50 outcomes  → expect quiet (null)
//                    4. no drop                  → expect quiet
//                    5. during warm-up           → expect 'informational'
//                  Reads nothing from prod; writes nothing.

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
if (!URL || !KEY) { console.error('Missing env'); process.exit(1) }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

const args = process.argv.slice(2)
const mode =
  args.includes('--synthetic') ? 'synthetic' :
  args.includes('--local-run') ? 'local-run' :
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

// ═══════════════════════════════════════════════════════════════════════
// SYNTHETIC MODE — the verdict-locking matrix (no DB)
// ═══════════════════════════════════════════════════════════════════════

if (mode === 'synthetic') {
  section('SYNTHETIC — §7.1 floor logic matrix (no DB I/O)')

  // Mirror of accuracy-floor.ts (kept in sync via test-accuracy.mjs shape checks)
  const BASELINE_ANCHOR_DATE = '2026-05-30'
  const WARMUP_DAYS = 30
  const MIN_OUTCOMES_FOR_ALERT = 50
  const SOFT_RELATIVE_DROP_PP = 5
  const HARD_RELATIVE_DROP_PP = 10
  const SOFT_ABSOLUTE_FLOOR_PCT = 55
  const HARD_ABSOLUTE_FLOOR_PCT = 50

  const round1 = n => Math.round(n * 10) / 10
  function isInWarmup(d) {
    const t = new Date(d + 'T00:00:00Z').getTime()
    const s = new Date(BASELINE_ANCHOR_DATE + 'T00:00:00Z').getTime()
    return t >= s && t < s + WARMUP_DAYS * 86_400_000
  }
  function checkAgreementFloor({ snapshot_date: d, needs_review_agreement_pct: today, needs_review_outcomes_total: outcomes, baseline_pct: baseline }) {
    if (today == null || outcomes < MIN_OUTCOMES_FOR_ALERT) {
      return { alert_level: null, alert_reason: `insufficient sample (${outcomes})` }
    }
    let level = null, reason = null
    const delta = baseline == null ? null : round1(today - baseline)
    if (delta != null) {
      if (delta <= -HARD_RELATIVE_DROP_PP) { level = 'hard'; reason = `relative drop ${-delta}pp` }
      else if (delta <= -SOFT_RELATIVE_DROP_PP) { level = 'soft'; reason = `relative drop ${-delta}pp` }
    }
    if (today < HARD_ABSOLUTE_FLOOR_PCT && level !== 'hard') { level = 'hard'; reason = `below absolute ${HARD_ABSOLUTE_FLOOR_PCT}%` }
    else if (today < SOFT_ABSOLUTE_FLOOR_PCT && level == null) { level = 'soft'; reason = `below absolute ${SOFT_ABSOLUTE_FLOOR_PCT}%` }
    if (level && isInWarmup(d)) return { alert_level: 'informational', alert_reason: `[WARMUP] ${reason}` }
    return { alert_level: level, alert_reason: reason }
  }

  const POST_WARMUP = '2026-07-15'
  const WARMUP_DATE = '2026-06-10'
  const cases = [
    { name: '12pp drop, 100 outcomes, post-warmup', input: { snapshot_date: POST_WARMUP, needs_review_agreement_pct: 49.3, needs_review_outcomes_total: 100, baseline_pct: 61.3 }, expect: 'hard' },
    { name: '6pp drop, 100 outcomes, post-warmup',  input: { snapshot_date: POST_WARMUP, needs_review_agreement_pct: 55.3, needs_review_outcomes_total: 100, baseline_pct: 61.3 }, expect: 'soft' },
    { name: '12pp drop, 40 outcomes (below sample guard)', input: { snapshot_date: POST_WARMUP, needs_review_agreement_pct: 49.3, needs_review_outcomes_total: 40, baseline_pct: 61.3 }, expect: null },
    { name: 'No drop (within 2pp), 100 outcomes',   input: { snapshot_date: POST_WARMUP, needs_review_agreement_pct: 60.8, needs_review_outcomes_total: 100, baseline_pct: 61.3 }, expect: null },
    { name: 'Improvement (above baseline)',         input: { snapshot_date: POST_WARMUP, needs_review_agreement_pct: 70.0, needs_review_outcomes_total: 100, baseline_pct: 61.3 }, expect: null },
    { name: 'WARMUP — 12pp drop downgraded',        input: { snapshot_date: WARMUP_DATE, needs_review_agreement_pct: 49.3, needs_review_outcomes_total: 100, baseline_pct: 61.3 }, expect: 'informational' },
    { name: 'WARMUP — 6pp drop downgraded',         input: { snapshot_date: WARMUP_DATE, needs_review_agreement_pct: 55.3, needs_review_outcomes_total: 100, baseline_pct: 61.3 }, expect: 'informational' },
    { name: 'WARMUP — no-drop stays quiet',         input: { snapshot_date: WARMUP_DATE, needs_review_agreement_pct: 61.0, needs_review_outcomes_total: 100, baseline_pct: 61.3 }, expect: null },
    { name: 'Absolute hard floor (49%, no baseline)', input: { snapshot_date: POST_WARMUP, needs_review_agreement_pct: 49.0, needs_review_outcomes_total: 200, baseline_pct: null }, expect: 'hard' },
    { name: 'Absolute soft floor (54%, no baseline)', input: { snapshot_date: POST_WARMUP, needs_review_agreement_pct: 54.0, needs_review_outcomes_total: 200, baseline_pct: null }, expect: 'soft' },
    { name: 'Escalation: 4.5pp soft drop + below absolute 50%', input: { snapshot_date: POST_WARMUP, needs_review_agreement_pct: 49.5, needs_review_outcomes_total: 200, baseline_pct: 54.0 }, expect: 'hard' },
  ]

  let pass = 0, fail = 0
  console.log(`\n${'case'.padEnd(56)} ${'today%'.padStart(7)} ${'base%'.padStart(7)} ${'n'.padStart(4)} ${'expect'.padEnd(14)} ${'got'.padEnd(14)}  reason`)
  console.log('  ' + '─'.repeat(112))
  for (const c of cases) {
    const r = checkAgreementFloor(c.input)
    const ok = (r.alert_level ?? null) === (c.expect ?? null)
    if (ok) pass++; else fail++
    const today  = c.input.needs_review_agreement_pct == null ? 'n/a' : String(c.input.needs_review_agreement_pct)
    const base   = c.input.baseline_pct == null ? 'n/a' : String(c.input.baseline_pct)
    console.log(`  ${(ok ? 'PASS ' : 'FAIL ')}${c.name.padEnd(50)} ${today.padStart(7)} ${base.padStart(7)} ${String(c.input.needs_review_outcomes_total).padStart(4)} ${String(c.expect ?? 'null').padEnd(14)} ${String(r.alert_level ?? 'null').padEnd(14)}  ${r.alert_reason ?? ''}`)
  }
  console.log(`\n  ${pass} passed, ${fail} failed.`)
  process.exit(fail === 0 ? 0 : 1)
}

// ═══════════════════════════════════════════════════════════════════════
// INSPECT / LOCAL-RUN — talk to prod
// ═══════════════════════════════════════════════════════════════════════

section(`MODE: ${mode}`)

// Show current state
const existing = await q('inventory_accuracy_snapshots?select=count')
console.log(`\nCurrent inventory_accuracy_snapshots rows: ${existing[0]?.count ?? 0}`)

if (mode === 'inspect') {
  // Preview the count inputs the cron would use today (any business).
  // Pick Chicce (the only business with non-trivial data right now).
  const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
  const windowStartIso = new Date(Date.now() - 30 * 86_400_000).toISOString()
  console.log(`\nPreview — what would be computed for Chicce (window=${windowStartIso.slice(0,10)} → today):`)

  const counts = {}
  // needs_review outcomes
  const nr = await q(`inventory_review_outcomes?select=agreed,owner_action,ai_action&business_id=eq.${CHICCE}&context=eq.needs_review&created_at=gte.${windowStartIso}&limit=5000`)
  counts.nr_total  = nr.length
  counts.nr_agreed = nr.filter(r => r.agreed === true).length
  counts.owner_create_new = nr.filter(r => r.owner_action === 'create_new').length
  counts.ai_create_new_on_reviewed = nr.filter(r => r.ai_action === 'create_new').length
  // audit_sample outcomes
  const ao = await q(`inventory_review_outcomes?select=agreed&business_id=eq.${CHICCE}&context=eq.audit_sample&created_at=gte.${windowStartIso}&limit=5000`)
  counts.as_total  = ao.length
  counts.as_agreed = ao.filter(r => r.agreed === true).length
  // audit queue reviewed
  const aq = await q(`inventory_audit_queue?select=reviewer_decision&business_id=eq.${CHICCE}&reviewed_at=gte.${windowStartIso}&reviewed_at=not.is.null&limit=5000`)
  counts.as_confirms    = aq.filter(r => r.reviewer_decision === 'confirm').length
  counts.as_corrections = aq.filter(r => r.reviewer_decision === 'correct').length
  // supplier_invoice_lines
  const sil = await q(`supplier_invoice_lines?select=match_status&business_id=eq.${CHICCE}&created_at=gte.${windowStartIso}&limit=10000`)
  counts.total_lines  = sil.length
  counts.needs_review_lines = sil.filter(r => r.match_status === 'needs_review').length
  // demotions
  const dem = await q(`product_aliases?select=id&business_id=eq.${CHICCE}&deactivated_at=gte.${windowStartIso}&limit=5000`)
  counts.demotions = dem.length
  // rebate noise
  const descs = await q(`product_aliases?select=raw_description&business_id=eq.${CHICCE}&first_seen_at=gte.${windowStartIso}&limit=5000`)
  const REBATE = /(avtalsrabatt|^rabatt|\bpant\b|pantersättning|öresavrundning|faktureringsavg|inkassoarvode|påminnelseavg)/i
  counts.rebate_noise = descs.filter(r => r.raw_description && REBATE.test(r.raw_description)).length

  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(28)} ${v}`)
  }

  console.log('\n  To write today\'s snapshot: node scripts/verify-accuracy-snapshot.mjs --local-run')
  console.log('  To prove floor logic:      node scripts/verify-accuracy-snapshot.mjs --synthetic')
  process.exit(0)
}

// ── LOCAL-RUN ──
section('LOCAL-RUN — about to compute + write today\'s snapshot for every business')
const confirm = await ask('Type "RUN_SNAPSHOT" to proceed: ')
if (confirm.trim() !== 'RUN_SNAPSHOT') { console.log('Aborted.'); process.exit(0) }

// Inline the cron's logic (mirrors app/api/cron/inventory-accuracy-snapshot/route.ts).
const BASELINE_ANCHOR_DATE = '2026-05-30'
const WARMUP_DAYS = 30
const MIN_SAMPLE = 50
const round1 = n => Math.round(n * 10) / 10
const today = new Date()
const todayIso = today.toISOString().slice(0, 10)
const windowStartIso = new Date(today.getTime() - 30 * 86_400_000).toISOString()

function agreementPct(a, t) { return t < MIN_SAMPLE ? null : round1((a / t) * 100) }
function precisionPct(c, k) { const d = c + k; return d < MIN_SAMPLE ? null : round1((c / d) * 100) }
function pct(n, d) { return d <= 0 ? null : round1((n / d) * 100) }
function createNewDiv(ai, ow) { return ai < 5 ? null : round1(((ai - ow) / ai) * 100) }
const REBATE = /(avtalsrabatt|^rabatt|\bpant\b|pantersättning|öresavrundning|faktureringsavg|inkassoarvode|påminnelseavg)/i
function countRebate(arr) { let n = 0; for (const s of arr) if (s && REBATE.test(s)) n++; return n }
function isInWarmup(d) { const t = new Date(d + 'T00:00:00Z').getTime(); const s = new Date(BASELINE_ANCHOR_DATE + 'T00:00:00Z').getTime(); return t >= s && t < s + WARMUP_DAYS * 86_400_000 }
function checkFloor({ snapshot_date: d, needs_review_agreement_pct: today, needs_review_outcomes_total: out, baseline_pct: base }) {
  if (today == null || out < MIN_SAMPLE) return { alert_level: null, alert_reason: `insufficient sample (${out})`, baseline_needs_review_pct: base, delta_vs_baseline_pp: null }
  let level = null, reason = null
  const delta = base == null ? null : round1(today - base)
  if (delta != null) {
    if (delta <= -10) { level = 'hard'; reason = `relative drop ${-delta}pp` }
    else if (delta <= -5) { level = 'soft'; reason = `relative drop ${-delta}pp` }
  }
  if (today < 50 && level !== 'hard') { level = 'hard'; reason = `below absolute 50%` }
  else if (today < 55 && level == null) { level = 'soft'; reason = `below absolute 55%` }
  if (level && isInWarmup(d)) return { alert_level: 'informational', alert_reason: `[WARMUP] ${reason}`, baseline_needs_review_pct: base, delta_vs_baseline_pp: delta }
  return { alert_level: level, alert_reason: reason, baseline_needs_review_pct: base, delta_vs_baseline_pp: delta }
}

const orgs = await q('organisations?select=id,name')
let written = 0
const summary = []
for (const org of orgs) {
  const bizs = await q(`businesses?select=id,name,is_active&org_id=eq.${org.id}&is_active=eq.true`)
  const perBiz = []
  for (const b of bizs) {
    const counts = await collectFor(b.id)
    perBiz.push({ business_id: b.id, name: b.name, counts })
  }
  // Global rollup = sum across per-business counts
  const global = perBiz.reduce((acc, p) => {
    for (const k of Object.keys(acc)) acc[k] = (acc[k] ?? 0) + (p.counts[k] ?? 0)
    return acc
  }, { nr_total: 0, nr_agreed: 0, as_total: 0, as_agreed: 0, as_confirms: 0, as_corrections: 0, total_lines: 0, needs_review_lines: 0, demotions: 0, active_start: 0, ai_create_new: 0, owner_create_new: 0, rebate_noise: 0 })

  const targets = [
    ...perBiz.map(p => ({ business_id: p.business_id, name: p.name, counts: p.counts })),
    { business_id: null, name: `${org.name} (global)`, counts: global },
  ]

  for (const tgt of targets) {
    // baseline = median of prior post-anchor needs_review_agreement_pct for this scope
    const priorsQ = tgt.business_id == null
      ? `inventory_accuracy_snapshots?select=needs_review_agreement_pct&org_id=eq.${org.id}&business_id=is.null&snapshot_date=gte.${BASELINE_ANCHOR_DATE}&snapshot_date=lt.${todayIso}&needs_review_agreement_pct=not.is.null&order=snapshot_date.desc&limit=30`
      : `inventory_accuracy_snapshots?select=needs_review_agreement_pct&org_id=eq.${org.id}&business_id=eq.${tgt.business_id}&snapshot_date=gte.${BASELINE_ANCHOR_DATE}&snapshot_date=lt.${todayIso}&needs_review_agreement_pct=not.is.null&order=snapshot_date.desc&limit=30`
    const priors = await q(priorsQ)
    const baselineNums = priors.map(r => Number(r.needs_review_agreement_pct)).filter(Number.isFinite).sort((a, b) => a - b)
    const baseline = baselineNums.length === 0 ? null : (baselineNums.length % 2 === 0 ? round1((baselineNums[baselineNums.length/2 - 1] + baselineNums[baselineNums.length/2]) / 2) : baselineNums[Math.floor(baselineNums.length/2)])

    const c = tgt.counts
    const nrPct = agreementPct(c.nr_agreed, c.nr_total)
    const asPct = agreementPct(c.as_agreed, c.as_total)
    const asPrecPct = precisionPct(c.as_confirms, c.as_corrections)
    const floor = checkFloor({ snapshot_date: todayIso, needs_review_agreement_pct: nrPct, needs_review_outcomes_total: c.nr_total, baseline_pct: baseline })

    const snapshot = {
      org_id:                       org.id,
      business_id:                  tgt.business_id,
      snapshot_date:                todayIso,
      window_days:                  30,
      needs_review_outcomes_total:  c.nr_total,
      needs_review_outcomes_agreed: c.nr_agreed,
      needs_review_agreement_pct:   nrPct,
      audit_sample_outcomes_total:  c.as_total,
      audit_sample_outcomes_agreed: c.as_agreed,
      audit_sample_agreement_pct:   asPct,
      audit_sample_confirmations:   c.as_confirms,
      audit_sample_corrections:     c.as_corrections,
      audit_sample_precision_pct:   asPrecPct,
      needs_review_lines_count:     c.needs_review_lines,
      total_lines_in_window:        c.total_lines,
      needs_review_rate_pct:        pct(c.needs_review_lines, c.total_lines),
      demotions_in_window:          c.demotions,
      active_aliases_window_start:  c.active_start,
      demotion_rate_pct:            pct(c.demotions, c.active_start),
      ai_create_new_count:          c.ai_create_new,
      owner_create_new_count:       c.owner_create_new,
      create_new_divergence_pct:    createNewDiv(c.ai_create_new, c.owner_create_new),
      rebate_noise_count:           c.rebate_noise,
      alert_level:                  floor.alert_level,
      alert_reason:                 floor.alert_reason,
      baseline_needs_review_pct:    floor.baseline_needs_review_pct,
      delta_vs_baseline_pp:         floor.delta_vs_baseline_pp,
    }

    const r = await fetch(`${URL}/rest/v1/inventory_accuracy_snapshots?on_conflict=org_id,business_id,snapshot_date,window_days`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(snapshot),
    })
    if (!r.ok) {
      summary.push({ scope: tgt.name, error: await r.text().catch(() => '?') })
    } else {
      written++
      summary.push({ scope: tgt.name, nr_pct: nrPct, as_pct: asPct, baseline, alert: floor.alert_level, in_warmup: isInWarmup(todayIso) })
    }
  }
}

section(`Wrote ${written} snapshot rows`)
for (const s of summary) {
  if (s.error) console.log(`  ${s.scope.padEnd(28)}  ERROR: ${s.error.slice(0, 80)}`)
  else        console.log(`  ${s.scope.padEnd(28)}  nr=${String(s.nr_pct ?? '—').padStart(6)}%  as=${String(s.as_pct ?? '—').padStart(6)}%  base=${String(s.baseline ?? '—').padStart(6)}  alert=${s.alert ?? 'quiet'}${s.in_warmup ? '  [warmup]' : ''}`)
}
console.log(`\n  Run with --synthetic to prove the floor logic matrix.`)
console.log(`  Admin view: /admin/v2/inventory-accuracy (admin-only per §7.2)`)

// ── per-business count collector ───────────────────────────────────────
async function collectFor(businessId) {
  const nr = await q(`inventory_review_outcomes?select=agreed,owner_action,ai_action&business_id=eq.${businessId}&context=eq.needs_review&created_at=gte.${windowStartIso}&limit=5000`)
  const ai = await q(`inventory_review_suggestions?select=action&business_id=eq.${businessId}&action=eq.create_new&created_at=gte.${windowStartIso}&limit=5000`)
  const ao = await q(`inventory_review_outcomes?select=agreed&business_id=eq.${businessId}&context=eq.audit_sample&created_at=gte.${windowStartIso}&limit=5000`)
  const aq = await q(`inventory_audit_queue?select=reviewer_decision&business_id=eq.${businessId}&reviewed_at=not.is.null&reviewed_at=gte.${windowStartIso}&limit=5000`)
  const sil = await q(`supplier_invoice_lines?select=match_status&business_id=eq.${businessId}&created_at=gte.${windowStartIso}&limit=10000`)
  const dem = await q(`product_aliases?select=id&business_id=eq.${businessId}&deactivated_at=gte.${windowStartIso}&limit=5000`)
  const activeNow = await q(`product_aliases?select=count&business_id=eq.${businessId}&is_active=eq.true`)
  const descs = await q(`product_aliases?select=raw_description&business_id=eq.${businessId}&first_seen_at=gte.${windowStartIso}&limit=5000`)
  return {
    nr_total: nr.length, nr_agreed: nr.filter(r => r.agreed === true).length,
    as_total: ao.length, as_agreed: ao.filter(r => r.agreed === true).length,
    as_confirms:    aq.filter(r => r.reviewer_decision === 'confirm').length,
    as_corrections: aq.filter(r => r.reviewer_decision === 'correct').length,
    total_lines: sil.length, needs_review_lines: sil.filter(r => r.match_status === 'needs_review').length,
    demotions: dem.length, active_start: (activeNow[0]?.count ?? 0) + dem.length,
    ai_create_new: Math.max(ai.length, nr.filter(r => r.ai_action === 'create_new').length),
    owner_create_new: nr.filter(r => r.owner_action === 'create_new').length,
    rebate_noise: countRebate(descs.map(r => r.raw_description)),
  }
}
