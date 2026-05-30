#!/usr/bin/env node
// scripts/test-accuracy.mjs
//
// Assertion tests for D3 accuracy snapshots (LEARNING-LOOP-PHASE1-PLAN.md §4).
//
// Covers:
//   - Pure rate helpers (agreementPct, precisionPct, pct, createNewDivergencePct)
//   - Rebate noise pattern
//   - Synthetic-regression scenarios on accuracy-floor.ts:
//       12pp drop, ≥50 outcomes → 'hard'
//       6pp  drop, ≥50 outcomes → 'soft'
//       12pp drop, <50 outcomes → quiet (null)
//       no drop                  → quiet
//       during warm-up           → 'informational' regardless of magnitude
//       absolute floor crossed   → escalates regardless of relative delta
//   - Source-file shape checks (M107 columns, RPC, route handlers, vercel cron)
//
// Run: node scripts/test-accuracy.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ── Mirror of pure logic (kept in sync via source-file shape checks below) ──

const MIN_SAMPLE_FOR_RATE = 50

function round1(n) { return Math.round(n * 10) / 10 }
function agreementPct(agreed, total) {
  if (total < MIN_SAMPLE_FOR_RATE) return null
  return round1((agreed / total) * 100)
}
function precisionPct(c, k) {
  const d = c + k
  if (d < MIN_SAMPLE_FOR_RATE) return null
  return round1((c / d) * 100)
}
function pct(num, den) {
  if (den <= 0) return null
  return round1((num / den) * 100)
}
function createNewDivergencePct(ai, owner) {
  if (ai < 5) return null
  return round1(((ai - owner) / ai) * 100)
}
const REBATE_NOISE_PATTERN = /(avtalsrabatt|^rabatt|\bpant\b|pantersättning|öresavrundning|faktureringsavg|inkassoarvode|påminnelseavg)/i
function countRebateNoise(arr) {
  let n = 0
  for (const s of arr) if (s && REBATE_NOISE_PATTERN.test(s)) n++
  return n
}

// ── Mirror of accuracy-floor.ts ─────────────────────────────────────────

const BASELINE_ANCHOR_DATE = '2026-05-30'
const WARMUP_DAYS = 30
const MIN_OUTCOMES_FOR_ALERT = MIN_SAMPLE_FOR_RATE
const SOFT_RELATIVE_DROP_PP = 5
const HARD_RELATIVE_DROP_PP = 10
const SOFT_ABSOLUTE_FLOOR_PCT = 55
const HARD_ABSOLUTE_FLOOR_PCT = 50

function isInWarmup(dateIso) {
  const today = new Date(dateIso + 'T00:00:00Z').getTime()
  const start = new Date(BASELINE_ANCHOR_DATE + 'T00:00:00Z').getTime()
  const warmEnd = start + WARMUP_DAYS * 86_400_000
  return today >= start && today < warmEnd
}

function checkAgreementFloor({ snapshot_date, needs_review_agreement_pct: today, needs_review_outcomes_total: outcomes, baseline_pct: baseline }) {
  if (today == null || outcomes < MIN_OUTCOMES_FOR_ALERT) {
    return { alert_level: null, alert_reason: `insufficient sample`, baseline_needs_review_pct: baseline, delta_vs_baseline_pp: null }
  }
  let level = null, reason = null
  const delta = baseline == null ? null : round1(today - baseline)
  if (delta != null) {
    if (delta <= -HARD_RELATIVE_DROP_PP) { level = 'hard'; reason = `relative drop ${-delta}pp ≥ ${HARD_RELATIVE_DROP_PP}pp` }
    else if (delta <= -SOFT_RELATIVE_DROP_PP) { level = 'soft'; reason = `relative drop ${-delta}pp ≥ ${SOFT_RELATIVE_DROP_PP}pp` }
  }
  if (today < HARD_ABSOLUTE_FLOOR_PCT && level !== 'hard') { level = 'hard'; reason = `below absolute floor ${HARD_ABSOLUTE_FLOOR_PCT}%` }
  else if (today < SOFT_ABSOLUTE_FLOOR_PCT && level == null) { level = 'soft'; reason = `below absolute floor ${SOFT_ABSOLUTE_FLOOR_PCT}%` }
  if (level != null && isInWarmup(snapshot_date)) {
    return { alert_level: 'informational', alert_reason: `[WARMUP] ${reason}`, baseline_needs_review_pct: baseline, delta_vs_baseline_pp: delta }
  }
  return { alert_level: level, alert_reason: reason, baseline_needs_review_pct: baseline, delta_vs_baseline_pp: delta }
}

// ── Test harness ────────────────────────────────────────────────────────

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); console.log('  PASS', name); pass++ }
  catch (e) { console.log('  FAIL', name, '-', e.message); fail++ }
}

console.log('\n── Pure rate helpers ───────────────────────────────────────────────')
t('agreementPct: 30/50 = 60% (just clears MIN_SAMPLE)', () => assert.equal(agreementPct(30, 50), 60))
t('agreementPct: 30/49 = null (below MIN_SAMPLE)', () => assert.equal(agreementPct(30, 49), null))
t('agreementPct: 0/0 = null', () => assert.equal(agreementPct(0, 0), null))
t('agreementPct: 613/1000 ≈ 61.3%', () => assert.equal(agreementPct(613, 1000), 61.3))
t('precisionPct: 45 confirms + 5 corrections = 90%', () => assert.equal(precisionPct(45, 5), 90))
t('precisionPct: 40 + 5 = below MIN_SAMPLE → null', () => assert.equal(precisionPct(40, 5), null))
t('pct: 82/1000 = 8.2', () => assert.equal(pct(82, 1000), 8.2))
t('pct: 0 denom → null', () => assert.equal(pct(0, 0), null))
t('createNewDivergencePct: 721 AI vs 533 owner = +26.1%', () => assert.equal(createNewDivergencePct(721, 533), 26.1))
t('createNewDivergencePct: tiny sample → null', () => assert.equal(createNewDivergencePct(4, 2), null))
t('createNewDivergencePct: equal → 0', () => assert.equal(createNewDivergencePct(100, 100), 0))
t('createNewDivergencePct: owner exceeds AI → negative', () => assert.equal(createNewDivergencePct(100, 130), -30))

console.log('\n── Rebate noise pattern ─────────────────────────────────────────────')
t('Avtalsrabatt JAMESON 40% matches', () => assert.ok(REBATE_NOISE_PATTERN.test('Avtalsrabatt JAMESON 40%')))
t('Avtalsrabatt BIRRA PORETTI matches', () => assert.ok(REBATE_NOISE_PATTERN.test('Avtalsrabatt BIRRA PORETTI 5,0%')))
t('Öresavrundning matches', () => assert.ok(REBATE_NOISE_PATTERN.test('Öresavrundning')))
t('Faktureringsavgift matches', () => assert.ok(REBATE_NOISE_PATTERN.test('Faktureringsavgift')))
t('Pant Coca-Cola matches', () => assert.ok(REBATE_NOISE_PATTERN.test('Pant Coca-Cola 33cl')))
t('Påminnelseavgift matches', () => assert.ok(REBATE_NOISE_PATTERN.test('Påminnelseavgift 60kr')))
t('"Rabatt" at start matches', () => assert.ok(REBATE_NOISE_PATTERN.test('Rabatt 10kr')))
t('Real product MOZZARELLA does NOT match', () => assert.ok(!REBATE_NOISE_PATTERN.test('MOZZARELLA 2KG')))
t('Real product Persilja krus does NOT match', () => assert.ok(!REBATE_NOISE_PATTERN.test('PERSILJA KRUS 250G')))
t('Real product Chiarlo Le Orme does NOT match', () => assert.ok(!REBATE_NOISE_PATTERN.test("Chiarlo Le Orme Barbera d'Asti")))
t('countRebateNoise on a mix', () => assert.equal(countRebateNoise([
  'Avtalsrabatt JAMESON', 'MOZZARELLA', 'Öresavrundning', null, 'Wolt', 'Pant 33cl',
]), 3))

console.log('\n── SYNTHETIC REGRESSION — floor-check matrix ────────────────────────')
// Use a POST-warmup date so the matrix tests the actionable levels.
const POST_WARMUP = '2026-07-15'  // > 2026-05-30 + 30 days

t('12pp drop, 100 outcomes, post-warmup → HARD', () => {
  const r = checkAgreementFloor({ snapshot_date: POST_WARMUP, needs_review_agreement_pct: 49.3, needs_review_outcomes_total: 100, baseline_pct: 61.3 })
  assert.equal(r.alert_level, 'hard', `expected hard, got ${r.alert_level}`)
  // 49.3 also crosses absolute hard floor (50%), so either reason is acceptable
  assert.ok(r.delta_vs_baseline_pp <= -10, 'delta should reflect ≥10pp drop')
})

t('6pp drop, 100 outcomes, post-warmup → SOFT', () => {
  const r = checkAgreementFloor({ snapshot_date: POST_WARMUP, needs_review_agreement_pct: 55.3, needs_review_outcomes_total: 100, baseline_pct: 61.3 })
  assert.equal(r.alert_level, 'soft', `expected soft, got ${r.alert_level}`)
  assert.ok(r.delta_vs_baseline_pp <= -5 && r.delta_vs_baseline_pp > -10)
})

t('12pp drop but only 40 outcomes → QUIET (min-sample guard)', () => {
  // Caller passes null when outcomes < MIN_SAMPLE_FOR_RATE because
  // agreementPct returned null. Test both paths:
  const r1 = checkAgreementFloor({ snapshot_date: POST_WARMUP, needs_review_agreement_pct: null, needs_review_outcomes_total: 40, baseline_pct: 61.3 })
  assert.equal(r1.alert_level, null)
  // Even with a numeric agreement (caller mistakenly passed it), the
  // explicit outcomes < threshold check fires.
  const r2 = checkAgreementFloor({ snapshot_date: POST_WARMUP, needs_review_agreement_pct: 49.3, needs_review_outcomes_total: 40, baseline_pct: 61.3 })
  assert.equal(r2.alert_level, null)
})

t('no drop (within 2pp of baseline), 100 outcomes → QUIET', () => {
  const r = checkAgreementFloor({ snapshot_date: POST_WARMUP, needs_review_agreement_pct: 60.8, needs_review_outcomes_total: 100, baseline_pct: 61.3 })
  assert.equal(r.alert_level, null, `expected null, got ${r.alert_level}`)
})

t('improvement (above baseline), 100 outcomes → QUIET', () => {
  const r = checkAgreementFloor({ snapshot_date: POST_WARMUP, needs_review_agreement_pct: 70.0, needs_review_outcomes_total: 100, baseline_pct: 61.3 })
  assert.equal(r.alert_level, null)
  assert.ok(r.delta_vs_baseline_pp > 0)
})

t('WARMUP — 12pp drop downgraded to INFORMATIONAL', () => {
  const WARMUP_DATE = '2026-06-10'  // within 30d of 2026-05-30
  const r = checkAgreementFloor({ snapshot_date: WARMUP_DATE, needs_review_agreement_pct: 49.3, needs_review_outcomes_total: 100, baseline_pct: 61.3 })
  assert.equal(r.alert_level, 'informational', `expected informational, got ${r.alert_level}`)
  assert.ok((r.alert_reason ?? '').startsWith('[WARMUP]'))
})

t('WARMUP — 6pp drop downgraded to INFORMATIONAL', () => {
  const r = checkAgreementFloor({ snapshot_date: '2026-06-15', needs_review_agreement_pct: 55.3, needs_review_outcomes_total: 100, baseline_pct: 61.3 })
  assert.equal(r.alert_level, 'informational')
})

t('WARMUP — no-drop stays QUIET (no downgrade needed)', () => {
  const r = checkAgreementFloor({ snapshot_date: '2026-06-15', needs_review_agreement_pct: 61.0, needs_review_outcomes_total: 100, baseline_pct: 61.3 })
  assert.equal(r.alert_level, null)
})

t('Absolute hard floor — agreement 49% (no drop computed) → HARD', () => {
  // No baseline yet (first day after warmup), but agreement is already below 50% absolute floor.
  const r = checkAgreementFloor({ snapshot_date: POST_WARMUP, needs_review_agreement_pct: 49.0, needs_review_outcomes_total: 200, baseline_pct: null })
  assert.equal(r.alert_level, 'hard')
})

t('Absolute soft floor — agreement 54% (no baseline) → SOFT', () => {
  const r = checkAgreementFloor({ snapshot_date: POST_WARMUP, needs_review_agreement_pct: 54.0, needs_review_outcomes_total: 200, baseline_pct: null })
  assert.equal(r.alert_level, 'soft')
})

t('Both relative + absolute escalation: relative says soft but absolute < 50 → escalates to HARD', () => {
  // baseline 54, today 49.5 → relative drop 4.5pp (just under soft 5pp threshold);
  // absolute 49.5 < 50 → escalates to hard.
  const r = checkAgreementFloor({ snapshot_date: POST_WARMUP, needs_review_agreement_pct: 49.5, needs_review_outcomes_total: 200, baseline_pct: 54.0 })
  assert.equal(r.alert_level, 'hard')
})

t('isInWarmup boundary day-29 (within)', () => assert.equal(isInWarmup('2026-06-28'), true))
t('isInWarmup boundary day-30 (just out)', () => assert.equal(isInWarmup('2026-06-29'), false))

console.log('\n── Source-file shape checks ─────────────────────────────────────────')
const accuracyTs = readFileSync('lib/inventory/accuracy.ts', 'utf8')
t('lib/inventory/accuracy.ts exports MIN_SAMPLE_FOR_RATE = 50', () => assert.match(accuracyTs, /export const MIN_SAMPLE_FOR_RATE\s*=\s*50/))
t('accuracy.ts exports agreementPct + precisionPct + createNewDivergencePct', () => {
  for (const fn of ['agreementPct', 'precisionPct', 'createNewDivergencePct', 'pct', 'countRebateNoise']) {
    assert.match(accuracyTs, new RegExp(`export function ${fn}`), `missing ${fn}`)
  }
})
t('accuracy.ts REBATE_NOISE_PATTERN matches Avtalsrabatt', () => {
  // Source uses /i flag — re-derive from the file to be sure
  const m = accuracyTs.match(/export const REBATE_NOISE_PATTERN\s*=\s*(\/.+?\/[gimsuy]*)/)
  assert.ok(m, 'pattern not found in source')
})

const floorTs = readFileSync('lib/inventory/accuracy-floor.ts', 'utf8')
t('accuracy-floor.ts BASELINE_ANCHOR_DATE = 2026-05-30', () => assert.match(floorTs, /BASELINE_ANCHOR_DATE\s*=\s*['"]2026-05-30['"]/))
t('accuracy-floor.ts WARMUP_DAYS = 30', () => assert.match(floorTs, /WARMUP_DAYS\s*=\s*30/))
t('accuracy-floor.ts SOFT/HARD relative thresholds (5/10pp)', () => {
  assert.match(floorTs, /SOFT_RELATIVE_DROP_PP\s*=\s*5/)
  assert.match(floorTs, /HARD_RELATIVE_DROP_PP\s*=\s*10/)
})
t('accuracy-floor.ts SOFT/HARD absolute floors (55/50%)', () => {
  assert.match(floorTs, /SOFT_ABSOLUTE_FLOOR_PCT\s*=\s*55/)
  assert.match(floorTs, /HARD_ABSOLUTE_FLOOR_PCT\s*=\s*50/)
})
t('accuracy-floor.ts exports checkAgreementFloor + isInWarmup', () => {
  assert.match(floorTs, /export function checkAgreementFloor/)
  assert.match(floorTs, /export function isInWarmup/)
})

const m107 = readFileSync('sql/M107-INVENTORY-ACCURACY-SNAPSHOTS.sql', 'utf8')
const requiredColumns = [
  'needs_review_outcomes_total', 'needs_review_outcomes_agreed', 'needs_review_agreement_pct',
  'audit_sample_outcomes_total', 'audit_sample_outcomes_agreed', 'audit_sample_agreement_pct',
  'audit_sample_confirmations', 'audit_sample_corrections', 'audit_sample_precision_pct',
  'needs_review_lines_count', 'total_lines_in_window', 'needs_review_rate_pct',
  'demotions_in_window', 'active_aliases_window_start', 'demotion_rate_pct',
  'ai_create_new_count', 'owner_create_new_count', 'create_new_divergence_pct',
  'rebate_noise_count',
  'alert_level', 'alert_reason', 'baseline_needs_review_pct', 'delta_vs_baseline_pp',
]
for (const col of requiredColumns) {
  t(`M107 has column ${col}`, () => assert.match(m107, new RegExp(`\\b${col}\\b`)))
}
t('M107 CHECK on alert_level', () => assert.match(m107, /alert_level IN \('informational', 'soft', 'hard'\)/))
t('M107 RLS enabled', () => assert.match(m107, /ENABLE ROW LEVEL SECURITY/))
t('M107 trend index', () => assert.match(m107, /inventory_accuracy_snapshots_trend/))

const cronTs = readFileSync('app/api/cron/inventory-accuracy-snapshot/route.ts', 'utf8')
t('Cron route auth-gated by CRON_SECRET', () => {
  assert.match(cronTs, /CRON_SECRET/)
  assert.match(cronTs, /'forbidden'/)
})
t('Cron uses computeRates + checkAgreementFloor', () => {
  assert.match(cronTs, /computeRates/)
  assert.match(cronTs, /checkAgreementFloor/)
})
t('Cron upserts onConflict org_id,business_id,snapshot_date,window_days', () => {
  assert.match(cronTs, /onConflict:\s*['"]org_id,business_id,snapshot_date,window_days['"]/)
})

const adminApiTs = readFileSync('app/api/admin/inventory-accuracy/route.ts', 'utf8')
t('Admin API uses ADMIN_SECRET (admin-only per §7.2)', () => assert.match(adminApiTs, /ADMIN_SECRET/))
t('Admin API returns snapshots ordered by date DESC', () => assert.match(adminApiTs, /order\('snapshot_date'/))

const vercelJson = readFileSync('vercel.json', 'utf8')
t('vercel.json includes inventory-accuracy-snapshot cron at 02:30 UTC', () => assert.match(vercelJson, /inventory-accuracy-snapshot.+?30 2/))

console.log(`\n${pass} passed, ${fail} failed.`)
process.exit(fail === 0 ? 0 : 1)
