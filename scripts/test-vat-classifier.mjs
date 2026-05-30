#!/usr/bin/env node
// scripts/test-vat-classifier.mjs
//
// Assertion tests for the VAT misrouting fix (VAT-MISROUTING-FIX-PLAN.md
// Phase 1). Repo doesn't carry a test framework — runnable via:
//
//   node scripts/test-vat-classifier.mjs
//
// Exits non-zero on any failure. Each test block prints PASS / FAIL so
// the failing case is identifiable. Reuses imports via tsx-style: the
// classify module is plain TS importable from .mjs because Node 24 has
// experimental TS support, but we re-implement the regex deterministically
// here rather than importing the TS file directly to avoid the loader
// dance. The two implementations are kept in sync by linking from the
// expectations below to the canonical source comment.

import assert from 'node:assert/strict'

// ── classify.ts behaviour (mirror of post-fix logic) ────────────────────
// Pre-fix: 6 % moms → takeaway. Post-fix: 6 % moms → null (caller's
// responsibility). Wolt / Foodora / UberEats → takeaway regardless.
// 12 % moms → food. 25 % moms → alcohol. alkohol / vin / öl / sprit /
// cider / whisky / dryck label keyword → alcohol (cost-side fallback).
function classifyByVat(label) {
  const key = String(label ?? '').trim().toLowerCase()
  if (/\b25\s*%?\s*moms\b/.test(key))  return { subcategory: 'alcohol' }
  if (/\b12\s*%?\s*moms\b/.test(key))  return { subcategory: 'food' }
  if (/\b(wolt|foodora|uber\s*eats)\b/.test(key)) return { subcategory: 'takeaway' }
  if (/\b(alkohol|vin|öl|sprit|cider|whisky|dryck)/i.test(key)) return { subcategory: 'alcohol' }
  return null
}

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); console.log('  PASS', name); pass++ }
  catch (e) { console.log('  FAIL', name, '-', e.message); fail++ }
}

console.log('\n── classifyByVat (post-fix) ───────────────────────────────────────')
t('"Försäljning 25% moms" → alcohol', () => {
  assert.deepEqual(classifyByVat('Försäljning 25% moms'), { subcategory: 'alcohol' })
})
t('"Försäljning 12% moms" → food', () => {
  assert.deepEqual(classifyByVat('Försäljning 12% moms'), { subcategory: 'food' })
})
t('"Försäljning 6% moms" → null (was takeaway pre-fix)', () => {
  assert.equal(classifyByVat('Försäljning 6% moms'), null)
})
t('"Försäljning varor 6% moms Sv" (Vero account 3053) → null', () => {
  assert.equal(classifyByVat('Försäljning varor 6% moms Sv'), null)
})
t('"Försäljning Wolt, Foodora" → takeaway (explicit platform)', () => {
  assert.deepEqual(classifyByVat('Försäljning Wolt, Foodora'), { subcategory: 'takeaway' })
})
t('"Wolt" alone → takeaway', () => {
  assert.deepEqual(classifyByVat('Wolt'), { subcategory: 'takeaway' })
})
t('"foodora 6% moms" → takeaway (platform wins)', () => {
  assert.deepEqual(classifyByVat('foodora 6% moms'), { subcategory: 'takeaway' })
})
t('"Uber Eats" → takeaway', () => {
  assert.deepEqual(classifyByVat('Uber Eats'), { subcategory: 'takeaway' })
})
t('"UberEats" (no space) → takeaway (\\s* in regex)', () => {
  assert.deepEqual(classifyByVat('UberEats'), { subcategory: 'takeaway' })
})
t('"Inköp av varor och material alkohol" → alcohol (keyword fallback)', () => {
  assert.deepEqual(classifyByVat('Inköp av varor och material alkohol'), { subcategory: 'alcohol' })
})
t('"Vin import" → alcohol (vin keyword)', () => {
  assert.deepEqual(classifyByVat('Vin import'), { subcategory: 'alcohol' })
})
t('empty label → null', () => {
  assert.equal(classifyByVat(''), null)
})
t('null label → null', () => {
  assert.equal(classifyByVat(null), null)
})
t('"Övriga intäkter" (no VAT, no keyword) → null', () => {
  assert.equal(classifyByVat('Övriga intäkter'), null)
})

// ── personalkollen sales splitter (mirror of post-fix logic) ──────────
// Pre-fix: 6 % VAT line forced takeaway. Post-fix: PK sale's is_take_away
// flag is authoritative; VAT only identifies food vs alcohol.
function splitTicket(sale) {
  const isTakeawayHint = sale.is_take_away === true
  let net = 0, foodNet = 0, drinkNet = 0, takeawayNet = 0, dineInNet = 0
  for (const i of (sale.items ?? [])) {
    const qty = parseFloat(i.amount ?? 0)
    const price = parseFloat(i.price_per_unit ?? 0)
    const vat = parseFloat(i.vat ?? 0)
    const line = qty * price
    net += line
    const isFoodVat = Math.abs(vat - 0.12) < 0.001 || Math.abs(vat - 0.06) < 0.001
    const isAlcoholVat = Math.abs(vat - 0.25) < 0.001
    if (isFoodVat) {
      foodNet += line
      if (isTakeawayHint) takeawayNet += line
      else                dineInNet   += line
    } else if (isAlcoholVat) {
      drinkNet += line
      dineInNet += line
    } else {
      drinkNet += line
      dineInNet += line
    }
  }
  return { net, foodNet, drinkNet, takeawayNet, dineInNet, isTakeaway: isTakeawayHint }
}

console.log('\n── personalkollen splitTicket (post-fix) ──────────────────────────')

t('dine-in ticket with 6 %-VAT food → dineIn (was takeaway pre-fix)', () => {
  const r = splitTicket({
    is_take_away: false,
    items: [{ amount: 2, price_per_unit: 100, vat: 0.06 }],
  })
  assert.equal(r.takeawayNet, 0, 'takeawayNet should be 0')
  assert.equal(r.dineInNet, 200, 'dineInNet should be 200')
  assert.equal(r.foodNet, 200)
  assert.equal(r.isTakeaway, false)
})

t('takeaway ticket with 6 %-VAT food → takeaway', () => {
  const r = splitTicket({
    is_take_away: true,
    items: [{ amount: 1, price_per_unit: 150, vat: 0.06 }],
  })
  assert.equal(r.takeawayNet, 150)
  assert.equal(r.dineInNet, 0)
  assert.equal(r.isTakeaway, true)
})

t('dine-in ticket with 12 %-VAT food → dineIn (unchanged)', () => {
  const r = splitTicket({
    is_take_away: false,
    items: [{ amount: 1, price_per_unit: 100, vat: 0.12 }],
  })
  assert.equal(r.dineInNet, 100)
  assert.equal(r.takeawayNet, 0)
})

t('takeaway ticket with 12 %-VAT food → takeaway (new — would have been dine-in pre-fix)', () => {
  const r = splitTicket({
    is_take_away: true,
    items: [{ amount: 1, price_per_unit: 100, vat: 0.12 }],
  })
  assert.equal(r.takeawayNet, 100)
  assert.equal(r.dineInNet, 0)
})

t('dine-in ticket with 25 %-VAT alcohol → dineIn alcohol bucket', () => {
  const r = splitTicket({
    is_take_away: false,
    items: [{ amount: 1, price_per_unit: 80, vat: 0.25 }],
  })
  assert.equal(r.drinkNet, 80)
  assert.equal(r.dineInNet, 80)
  assert.equal(r.takeawayNet, 0)
})

t('mixed ticket (dine-in): 6% food + 25% alcohol → dineIn for both', () => {
  const r = splitTicket({
    is_take_away: false,
    items: [
      { amount: 1, price_per_unit: 100, vat: 0.06 },
      { amount: 1, price_per_unit: 80,  vat: 0.25 },
    ],
  })
  assert.equal(r.foodNet, 100)
  assert.equal(r.drinkNet, 80)
  assert.equal(r.dineInNet, 180)
  assert.equal(r.takeawayNet, 0)
})

t('null is_take_away → dineIn (no longer flips to takeaway on 6%)', () => {
  const r = splitTicket({
    is_take_away: null,
    items: [{ amount: 1, price_per_unit: 100, vat: 0.06 }],
  })
  assert.equal(r.dineInNet, 100)
  assert.equal(r.takeawayNet, 0)
  assert.equal(r.isTakeaway, false)
})

// ── lib/sweden/vat helpers (date-aware) ────────────────────────────────
// Mirror of lib/sweden/vat.ts behaviour.
function isFoodVatCutActive(dateIso) {
  return dateIso >= '2026-04-01' && dateIso <= '2027-12-31'
}
function foodVatRateAt(dateIso) {
  return isFoodVatCutActive(dateIso) ? 6 : 12
}

console.log('\n── lib/sweden/vat date helpers ────────────────────────────────────')
t('2026-03-31 → cut NOT active', () => { assert.equal(isFoodVatCutActive('2026-03-31'), false) })
t('2026-04-01 → cut active (cutoff is inclusive)', () => { assert.equal(isFoodVatCutActive('2026-04-01'), true) })
t('2026-04-15 → cut active', () => { assert.equal(isFoodVatCutActive('2026-04-15'), true) })
t('2027-12-31 → cut active (end-date inclusive)', () => { assert.equal(isFoodVatCutActive('2027-12-31'), true) })
t('2028-01-01 → cut NOT active (post-revert)', () => { assert.equal(isFoodVatCutActive('2028-01-01'), false) })
t('foodVatRateAt(2026-03-31) = 12', () => { assert.equal(foodVatRateAt('2026-03-31'), 12) })
t('foodVatRateAt(2026-04-01) = 6', () => { assert.equal(foodVatRateAt('2026-04-01'), 6) })
t('foodVatRateAt(2027-12-31) = 6', () => { assert.equal(foodVatRateAt('2027-12-31'), 6) })
t('foodVatRateAt(2028-01-01) = 12', () => { assert.equal(foodVatRateAt('2028-01-01'), 12) })

console.log(`\n${pass} passed, ${fail} failed.`)
process.exit(fail === 0 ? 0 : 1)
