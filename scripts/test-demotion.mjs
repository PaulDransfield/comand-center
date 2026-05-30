#!/usr/bin/env node
// scripts/test-demotion.mjs
//
// Assertion tests for the M105 demotion infrastructure. Mirrors the
// scripts/test-vat-classifier.mjs pattern (repo has no test framework
// — runnable via `node scripts/test-demotion.mjs`).
//
// Tests the pure logic that doesn't require a live DB:
//   - DEMOTION_THRESHOLD + DEMOTION_THRESHOLD_AUDIT constants
//   - DECAY_DAYS_CROSS_SUPPLIER constant
//   - USAGE_WEIGHT_ACTIVATION_THRESHOLD constant
//   - Threshold-cross logic (mirror of the RPC body)
//
// DB-touching verification lives in scripts/verify-demotion-end-to-end.mjs.

import assert from 'node:assert/strict'

// Mirror the M105 RPC's threshold-cross logic in JS so we can unit-test
// the decision boundary without a DB round-trip. If this diverges from
// the SQL RPC, the end-to-end verification script catches it.
function shouldDeactivate(currentCount, threshold) {
  const newCount = currentCount + 1
  return newCount >= threshold
}

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); console.log('  PASS', name); pass++ }
  catch (e) { console.log('  FAIL', name, '-', e.message); fail++ }
}

console.log('\n── Demotion threshold logic ───────────────────────────────────────')
t('first correction (0 → 1) at default threshold 2 → NO deactivation', () => {
  assert.equal(shouldDeactivate(0, 2), false)
})
t('second correction (1 → 2) at default threshold 2 → DEACTIVATE', () => {
  assert.equal(shouldDeactivate(1, 2), true)
})
t('first correction at audit threshold 1 → DEACTIVATE', () => {
  assert.equal(shouldDeactivate(0, 1), true)
})
t('correction beyond threshold (3 → 4) at threshold 2 → DEACTIVATE (idempotent)', () => {
  assert.equal(shouldDeactivate(3, 2), true)
})
t('zero corrections with threshold 0 → DEACTIVATE (defensive)', () => {
  // Edge case: threshold 0 means "deactivate on any correction"; rare
  // but should be consistent with the > semantics.
  assert.equal(shouldDeactivate(0, 0), true)
})

console.log('\n── Constants (sourced from lib/inventory/demotion.ts) ─────────────')
const fs = await import('node:fs')
const demoTs = fs.readFileSync('lib/inventory/demotion.ts', 'utf8')
t('DEMOTION_THRESHOLD = 2', () => {
  assert.match(demoTs, /export const DEMOTION_THRESHOLD\s*=\s*2\b/)
})
t('DEMOTION_THRESHOLD_AUDIT = 1', () => {
  assert.match(demoTs, /export const DEMOTION_THRESHOLD_AUDIT\s*=\s*1\b/)
})
t('DECAY_DAYS_CROSS_SUPPLIER = 90', () => {
  assert.match(demoTs, /export const DECAY_DAYS_CROSS_SUPPLIER\s*=\s*90\b/)
})
t('USAGE_WEIGHT_ACTIVATION_THRESHOLD = 20', () => {
  assert.match(demoTs, /export const USAGE_WEIGHT_ACTIVATION_THRESHOLD\s*=\s*20\b/)
})

console.log('\n── Matcher filter (lib/inventory/matcher.ts) ──────────────────────')
const matcherTs = fs.readFileSync('lib/inventory/matcher.ts', 'utf8')
t('Step 1 SELECT filters on is_active=true', () => {
  // Find the article_number-keyed SELECT block; check it has the is_active filter
  const step1 = matcherTs.match(/\.eq\('article_number', line\.article_number\)[\s\S]{0,300}\.maybeSingle\(\)/)
  assert.ok(step1, 'could not find Step 1 SELECT block')
  assert.match(step1[0], /\.eq\('is_active',\s*true\)/, 'Step 1 missing .eq("is_active", true)')
})
t('Step 2 SELECT filters on is_active=true', () => {
  const step2 = matcherTs.match(/\.eq\('normalised_description', normalised\)[\s\S]{0,400}\.maybeSingle\(\)/)
  assert.ok(step2, 'could not find Step 2 SELECT block')
  assert.match(step2[0], /\.eq\('is_active',\s*true\)/, 'Step 2 missing .eq("is_active", true)')
})
t('insertAlias has re-activation branch for demoted rows', () => {
  // Look for the M105 reactivation path: updates is_active to true + clears deactivation
  assert.match(matcherTs, /is_active:\s*true,\s*\n\s*corrections_against:\s*0,\s*\n\s*deactivated_reason:\s*null,\s*\n\s*deactivated_at:\s*null/)
})

console.log('\n── M105 SQL migration ─────────────────────────────────────────────')
const m105 = fs.readFileSync('sql/M105-PRODUCT-ALIASES-DEMOTION.sql', 'utf8')
t('M105 adds is_active column (default TRUE)', () => {
  assert.match(m105, /ADD COLUMN IF NOT EXISTS is_active\s+BOOLEAN\s+NOT NULL DEFAULT TRUE/)
})
t('M105 adds corrections_against column (default 0)', () => {
  assert.match(m105, /ADD COLUMN IF NOT EXISTS corrections_against\s+INTEGER\s+NOT NULL DEFAULT 0/)
})
t('M105 adds last_applied_at, last_corrected_at, deactivated_reason, deactivated_at', () => {
  for (const col of ['last_applied_at', 'last_corrected_at', 'deactivated_reason', 'deactivated_at']) {
    assert.match(m105, new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`), `missing column ${col}`)
  }
})
t('M105 CHECK constraint on deactivated_reason enum', () => {
  assert.match(m105, /CHECK\s*\(\s*\n?\s*deactivated_reason IS NULL/)
  for (const reason of ['owner_override', 'corrections_threshold', 'decay_stale', 'manual_admin']) {
    assert.match(m105, new RegExp(`'${reason}'`), `enum value ${reason} not in CHECK`)
  }
})
t('M105 product_aliases_record_correction RPC defined with threshold default 2', () => {
  assert.match(m105, /CREATE OR REPLACE FUNCTION public\.product_aliases_record_correction/)
  assert.match(m105, /p_threshold\s+INTEGER\s+DEFAULT 2/)
})
t('M105 inventory_touch_alias RPC extended to set last_applied_at', () => {
  // Match the full RPC body (both $$ delimiters). Non-greedy on the
  // CLOSING $$ — the OPENING $$ is `AS $$\n`.
  const rpcBody = m105.match(/CREATE OR REPLACE FUNCTION public\.inventory_touch_alias[\s\S]+?AS \$\$[\s\S]+?\$\$/)
  assert.ok(rpcBody, 'inventory_touch_alias RPC not found in M105')
  assert.match(rpcBody[0], /last_applied_at\s*=\s*NOW\(\)/, 'inventory_touch_alias does not set last_applied_at')
})
t('M105 inventory_trigram_search RPC filters on pa.is_active = TRUE', () => {
  const rpcBody = m105.match(/CREATE OR REPLACE FUNCTION public\.inventory_trigram_search[\s\S]+?AS \$\$[\s\S]+?\$\$/)
  assert.ok(rpcBody, 'inventory_trigram_search RPC not in M105')
  assert.match(rpcBody[0], /pa\.is_active\s*=\s*TRUE/, 'trigram RPC does not filter on is_active')
})
t('M105 indexes (active_lookup + decay_candidates) created', () => {
  assert.match(m105, /CREATE INDEX IF NOT EXISTS product_aliases_active_lookup/)
  assert.match(m105, /CREATE INDEX IF NOT EXISTS product_aliases_decay_candidates/)
})
t('M105 is wrapped in a transaction', () => {
  assert.match(m105, /^BEGIN;/m)
  assert.match(m105, /^COMMIT;/m)
})

console.log('\n── correct-attribution endpoint (app/api/inventory/lines/[id]/correct-attribution/route.ts) ──')
const endpointTs = fs.readFileSync('app/api/inventory/lines/[id]/correct-attribution/route.ts', 'utf8')
t('endpoint calls product_aliases_record_correction RPC with DEMOTION_THRESHOLD', () => {
  assert.match(endpointTs, /rpc\(\s*'product_aliases_record_correction'/)
  assert.match(endpointTs, /p_threshold:\s*DEMOTION_THRESHOLD/)
})
t('endpoint refuses on non-matched lines', () => {
  assert.match(endpointTs, /match_status\s*!==\s*'matched'/)
  assert.match(endpointTs, /not currently matched/)
})
t('endpoint flips line back to needs_review + clears product_alias_id', () => {
  assert.match(endpointTs, /match_status:\s*'needs_review'/)
  assert.match(endpointTs, /product_alias_id:\s*null/)
})
t('endpoint uses requireBusinessAccess auth gate', () => {
  assert.match(endpointTs, /requireBusinessAccess\(auth,\s*line\.business_id\)/)
})

console.log(`\n${pass} passed, ${fail} failed.`)
process.exit(fail === 0 ? 0 : 1)
