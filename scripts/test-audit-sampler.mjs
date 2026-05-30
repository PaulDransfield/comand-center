#!/usr/bin/env node
// scripts/test-audit-sampler.mjs
//
// Assertion tests for the M106 audit-sampler logic. No DB; pure
// function tests on the JS implementations. Mirrors the pattern from
// scripts/test-demotion.mjs and scripts/test-vat-classifier.mjs.
//
// Run: node scripts/test-audit-sampler.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Mirror of lib/inventory/audit-sampler.ts so we can unit-test without
// the .ts loader dance. If the canonical lib changes, this mirror must
// follow — the source-file inspections below catch shape mismatches.

const USAGE_WEIGHT_ACTIVATION_THRESHOLD = 20

function targetSampleRate(autoLinksInWindow) {
  if (autoLinksInWindow <= 20)  return 1.00
  if (autoLinksInWindow <= 50)  return 0.50
  if (autoLinksInWindow <= 200) return 0.20
  return 0.05
}

const W = { CROSS: 10000, PREV: 1000, SAME: 100, RECENT: 50, VALUE: 25, USAGE: 40 }

function scoreCandidate(c, now = new Date()) {
  let score = 0
  let primary = 'other'
  let reason = 'manual_review'
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
  const ageMs = now.getTime() - new Date(c.first_seen_at).getTime()
  const ageDays = ageMs / 86_400_000
  if (ageDays >= 0 && ageDays < 7) score += Math.round(W.RECENT * (1 - ageDays / 7))
  if (c.highest_line_total_excl_vat > 0) {
    score += Math.min(W.VALUE, Math.round(Math.log10(Math.abs(c.highest_line_total_excl_vat) + 1) * 10))
  }
  if (c.line_refs_count >= USAGE_WEIGHT_ACTIVATION_THRESHOLD) {
    score += Math.min(W.USAGE, Math.round((c.line_refs_count - USAGE_WEIGHT_ACTIVATION_THRESHOLD) * (W.USAGE / (200 - USAGE_WEIGHT_ACTIVATION_THRESHOLD))))
    if (primary === 'other') primary = 'high_usage'
  }
  return { ...c, risk_score: score, reason, primary_factor: primary }
}

function pickSampleSet(candidates, now = new Date()) {
  if (candidates.length === 0) return []
  const scored = candidates.map(c => scoreCandidate(c, now))
  const rate = targetSampleRate(candidates.length)
  const n = Math.max(1, Math.round(candidates.length * rate))
  return scored.sort((a, b) => b.risk_score - a.risk_score).slice(0, n)
}

let pass = 0, fail = 0
function t(name, fn) { try { fn(); console.log('  PASS', name); pass++ } catch (e) { console.log('  FAIL', name, '-', e.message); fail++ } }

const today = new Date('2026-05-30T12:00:00Z')
function mkAlias(overrides = {}) {
  return {
    alias_id: 'a-' + Math.random().toString(36).slice(2, 8),
    business_id: 'b1', org_id: 'o1',
    match_method: 'fuzzy_same_supplier',
    match_confidence: 0.9,
    times_demoted: 0,
    first_seen_at: today.toISOString(),  // brand new = max recency boost
    highest_line_total_excl_vat: 100,
    highest_value_line_id: 'l1',
    line_refs_count: 1,
    ...overrides,
  }
}

console.log('\n── targetSampleRate (adaptive) ─────────────────────────────────────')
t('1 candidate → 100%',     () => assert.equal(targetSampleRate(1),    1.00))
t('20 candidates → 100%',   () => assert.equal(targetSampleRate(20),   1.00))
t('21 candidates → 50%',    () => assert.equal(targetSampleRate(21),   0.50))
t('50 candidates → 50%',    () => assert.equal(targetSampleRate(50),   0.50))
t('51 candidates → 20%',    () => assert.equal(targetSampleRate(51),   0.20))
t('200 candidates → 20%',   () => assert.equal(targetSampleRate(200),  0.20))
t('201 candidates → 5%',    () => assert.equal(targetSampleRate(201),  0.05))
t('10000 → 5%',             () => assert.equal(targetSampleRate(10000), 0.05))

console.log('\n── scoreCandidate ranking (owner-locked order) ─────────────────────')
const crossSupplier      = mkAlias({ match_method: 'fuzzy_cross_supplier' })
const previouslyDemoted  = mkAlias({ times_demoted: 1 })
const sameSupplier       = mkAlias({ match_method: 'fuzzy_same_supplier' })
const recentSame         = mkAlias({ match_method: 'fuzzy_same_supplier', first_seen_at: today.toISOString() })
const oldSame            = mkAlias({ match_method: 'fuzzy_same_supplier', first_seen_at: new Date(today.getTime() - 30 * 86_400_000).toISOString() })
const highValueSame      = mkAlias({ match_method: 'fuzzy_same_supplier', first_seen_at: oldSame.first_seen_at, highest_line_total_excl_vat: 50000 })
const highUsageSame      = mkAlias({ match_method: 'fuzzy_same_supplier', first_seen_at: oldSame.first_seen_at, line_refs_count: 100 })

const csScore   = scoreCandidate(crossSupplier, today).risk_score
const pdScore   = scoreCandidate(previouslyDemoted, today).risk_score
const ssScore   = scoreCandidate(sameSupplier, today).risk_score
const rsScore   = scoreCandidate(recentSame, today).risk_score
const osScore   = scoreCandidate(oldSame, today).risk_score
const hvScore   = scoreCandidate(highValueSame, today).risk_score
const huScore   = scoreCandidate(highUsageSame, today).risk_score

t('cross-supplier > previously-demoted', () => assert.ok(csScore > pdScore, `${csScore} !> ${pdScore}`))
t('previously-demoted > same-supplier',  () => assert.ok(pdScore > ssScore, `${pdScore} !> ${ssScore}`))
t('recent same-supplier > old same-supplier',  () => assert.ok(rsScore > osScore, `${rsScore} !> ${osScore}`))
t('high-value old same > plain old same',      () => assert.ok(hvScore > osScore, `${hvScore} !> ${osScore}`))
t('high-usage doesn\'t lift over previously-demoted',  () => assert.ok(huScore < pdScore, `${huScore} !< ${pdScore}`))

console.log('\n── scoreCandidate factor combination ───────────────────────────────')
t('cross-supplier + previously-demoted ranks highest', () => {
  const both = scoreCandidate(mkAlias({ match_method: 'fuzzy_cross_supplier', times_demoted: 1 }), today)
  assert.ok(both.risk_score > csScore, `combined ${both.risk_score} should be > cross-only ${csScore}`)
  assert.equal(both.primary_factor, 'cross_supplier+previously_demoted')
})
t('previously-demoted (no fuzzy) tags reason="previously_demoted"', () => {
  const r = scoreCandidate(mkAlias({ match_method: 'owner_confirmed', times_demoted: 1 }), today)
  assert.equal(r.reason, 'previously_demoted')
  assert.equal(r.primary_factor, 'previously_demoted')
})
t('cross-supplier tags reason="confident_auto_match"', () => {
  const r = scoreCandidate(crossSupplier, today)
  assert.equal(r.reason, 'confident_auto_match')
})
t('plain owner_confirmed (no risk signals) → reason="manual_review"', () => {
  const r = scoreCandidate(mkAlias({ match_method: 'owner_confirmed', first_seen_at: new Date(today.getTime() - 100 * 86_400_000).toISOString(), highest_line_total_excl_vat: 0 }), today)
  assert.equal(r.reason, 'manual_review')
})
t('high-usage activation gate (line_refs_count=20 = threshold, gets boost)', () => {
  const r = scoreCandidate(mkAlias({ line_refs_count: 20 }), today)
  // At exactly threshold, formula = (20-20) * (80/(200-20)) = 0. Boost is 0.
  // Above threshold, boost grows. At 100 refs: (100-20)*(80/180) ≈ 35.6 → 36
  const above = scoreCandidate(mkAlias({ line_refs_count: 100 }), today)
  assert.ok(above.risk_score > r.risk_score, `above-threshold should have higher score`)
})
t('high-usage below activation threshold has no effect', () => {
  const r1 = scoreCandidate(mkAlias({ line_refs_count: 1 }), today)
  const r19 = scoreCandidate(mkAlias({ line_refs_count: 19 }), today)
  // Same input shape otherwise → identical score
  assert.equal(r1.risk_score, r19.risk_score)
})

console.log('\n── pickSampleSet ─────────────────────────────────────────────────────')
t('empty input → empty output', () => assert.deepEqual(pickSampleSet([], today), []))
t('5 candidates → all 5 (≤20 = 100%)', () => {
  const cs = Array.from({ length: 5 }, (_, i) => mkAlias({ alias_id: 'a' + i }))
  assert.equal(pickSampleSet(cs, today).length, 5)
})
t('30 candidates → 15 (50% rate)', () => {
  const cs = Array.from({ length: 30 }, (_, i) => mkAlias({ alias_id: 'a' + i }))
  assert.equal(pickSampleSet(cs, today).length, 15)
})
t('300 candidates → 15 (5% rate)', () => {
  const cs = Array.from({ length: 300 }, (_, i) => mkAlias({ alias_id: 'a' + i }))
  assert.equal(pickSampleSet(cs, today).length, 15)
})
t('mixed pool: cross-supplier ranked above same-supplier in output', () => {
  const cs = [
    ...Array.from({ length: 10 }, (_, i) => mkAlias({ alias_id: 'ss' + i, match_method: 'fuzzy_same_supplier' })),
    ...Array.from({ length: 3 },  (_, i) => mkAlias({ alias_id: 'cs' + i, match_method: 'fuzzy_cross_supplier' })),
  ]
  const sample = pickSampleSet(cs, today)
  assert.ok(sample[0].match_method === 'fuzzy_cross_supplier', `top-ranked should be cross-supplier, got ${sample[0].match_method}`)
})

console.log('\n── Source file shape checks ────────────────────────────────────────')
const samplerTs = readFileSync('lib/inventory/audit-sampler.ts', 'utf8')
t('lib/inventory/audit-sampler.ts exports targetSampleRate', () => assert.match(samplerTs, /export function targetSampleRate/))
t('lib/inventory/audit-sampler.ts exports scoreCandidate', () => assert.match(samplerTs, /export function scoreCandidate/))
t('lib/inventory/audit-sampler.ts exports pickSampleSet', () => assert.match(samplerTs, /export function pickSampleSet/))
t('sampler imports USAGE_WEIGHT_ACTIVATION_THRESHOLD from demotion.ts', () => assert.match(samplerTs, /from\s+['"]\.\/demotion['"]/))
t('adaptive rate thresholds match (20/50/200)', () => {
  for (const n of ['20', '50', '200']) assert.match(samplerTs, new RegExp(`<=\\s*${n}`))
})

const m106 = readFileSync('sql/M106-INVENTORY-AUDIT-QUEUE.sql', 'utf8')
t('M106 adds times_demoted column', () => assert.match(m106, /ADD COLUMN IF NOT EXISTS times_demoted/))
t('M106 adds last_demoted_at column', () => assert.match(m106, /ADD COLUMN IF NOT EXISTS last_demoted_at/))
t('M106 adds context column to outcomes', () => assert.match(m106, /inventory_review_outcomes[\s\S]+?context\s+TEXT/))
t('M106 CREATE TABLE inventory_audit_queue', () => assert.match(m106, /CREATE TABLE IF NOT EXISTS public\.inventory_audit_queue/))
t('M106 audit_queue UNIQUE(business_id, alias_id, reason)', () => assert.match(m106, /UNIQUE\s*\(business_id, alias_id, reason\)/))
t('M106 audit_queue reason CHECK includes previously_demoted', () => assert.match(m106, /'previously_demoted'/))
t('M106 extended RPC bumps times_demoted on deactivation', () => {
  const rpc = m106.match(/CREATE OR REPLACE FUNCTION public\.product_aliases_record_correction[\s\S]+?AS \$\$[\s\S]+?\$\$/)
  assert.ok(rpc, 'RPC not found')
  assert.match(rpc[0], /times_demoted\s*=\s*times_demoted\s*\+\s*1/)
  assert.match(rpc[0], /last_demoted_at\s*=\s*NOW\(\)/)
})

const cronTs = readFileSync('app/api/cron/inventory-audit-sampler/route.ts', 'utf8')
t('Cron route exists + auth-gated', () => {
  assert.match(cronTs, /CRON_SECRET/)
  assert.match(cronTs, /'forbidden'/)
})
t('Cron upserts onConflict business_id,alias_id,reason', () => {
  assert.match(cronTs, /onConflict:\s*['"]business_id,alias_id,reason['"]/)
})

const actionTs = readFileSync('app/api/inventory/audit/[id]/action/route.ts', 'utf8')
t('action route uses DEMOTION_THRESHOLD_AUDIT', () => assert.match(actionTs, /DEMOTION_THRESHOLD_AUDIT/))
t('action route writes context=audit_sample on outcomes', () => assert.match(actionTs, /context:\s*['"]audit_sample['"]/))

const aiSuggestTs = readFileSync('lib/inventory/ai-suggest-core.ts', 'utf8')
t('ai-suggest reads context column on outcomes', () => assert.match(aiSuggestTs, /select\(['"](.|\n)*?context/))
t('ai-suggest tags audit_sample outcomes in the prompt', () => assert.match(aiSuggestTs, /AUDIT — high-confidence correction/))

const vercelJson = readFileSync('vercel.json', 'utf8')
t('vercel.json includes inventory-audit-sampler cron', () => assert.match(vercelJson, /inventory-audit-sampler/))

console.log(`\n${pass} passed, ${fail} failed.`)
process.exit(fail === 0 ? 0 : 1)
