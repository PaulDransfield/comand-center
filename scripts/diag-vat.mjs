#!/usr/bin/env node
// scripts/diag-vat.mjs
//
// Pull raw PK sales for a small window, dump every field we've never mapped,
// and compute every plausible revenue candidate. Goal: find the PK field/combo
// that matches what PK's own dashboard shows as "Försäljning ex. moms".
//
// Runs fully local — no secrets to transcript.

import { readFileSync } from 'node:fs'
import {
  createDecipheriv,
} from 'node:crypto'

// ── Env loader ──────────────────────────────────────────────────────────────
function parseEnv(p) {
  try {
    return Object.fromEntries(
      readFileSync(p, 'utf8').split('\n')
        .filter(l => l.includes('=') && !l.trim().startsWith('#'))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
    )
  } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const KEY  = env.SUPABASE_SERVICE_ROLE_KEY
const CRYPT_KEY = env.CREDENTIAL_ENCRYPTION_KEY
if (!URL_ || !KEY)       { console.error('missing supabase env');   process.exit(1) }
if (!CRYPT_KEY)          { console.error('missing encryption key'); process.exit(1) }

// ── AES-256-GCM decrypt (mirror of lib/integrations/encryption.ts) ─────────
function decrypt(b64) {
  if (!b64) return null
  const key    = Buffer.from(CRYPT_KEY, 'hex')
  const packed = Buffer.from(b64, 'base64')
  const iv     = packed.subarray(0, 12)
  const tag    = packed.subarray(packed.length - 16)
  const ct     = packed.subarray(12, packed.length - 16)
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

// ── Supabase REST helper ────────────────────────────────────────────────────
async function q(path) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  })
  if (!r.ok) { console.error('SB error', r.status, await r.text()); return [] }
  return r.json()
}

// ── 1. Find the Vero PK integration ─────────────────────────────────────────
const integs = await q(`integrations?select=id,credentials_enc,provider,business_id&provider=eq.personalkollen&status=eq.connected`)
if (!integs.length) { console.error('no connected PK integration'); process.exit(1) }
const veroIntegId = '2475e1ef-a4d9-4442-ab50-bffe4e831258'
const integ = integs.find(i => i.id === veroIntegId) ?? integs[0]
console.log(`using integration ${integ.id} (business_id=${integ.business_id})`)

const token = decrypt(integ.credentials_enc)
if (!token) { console.error('decrypt failed'); process.exit(1) }
console.log(`decrypted token ok (length ${token.length})\n`)

// ── 2. Pull raw PK sales for one day ────────────────────────────────────────
const DATE = '2026-04-17'  // a Friday with ~70k rev for Vero
async function pkGet(path) {
  const r = await fetch(`https://personalkollen.se/api${path}`, {
    headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
  })
  if (!r.ok) { console.error('PK error', r.status, path, await r.text().catch(()=> '')); return null }
  return r.json()
}

// Probe date filter: pull one sale with no filter and see what format sale_time uses.
const probe = await pkGet('/sales/?page_size=1')
if (!probe) process.exit(1)
console.log('raw sample (no filter):')
console.log(JSON.stringify(probe.results?.[0] ?? probe, null, 2).split('\n').slice(0, 40).join('\n'))
console.log(`total sales (count field): ${probe.count ?? '?'}`)
console.log(`next: ${probe.next ?? '—'}`)
console.log(`sample sale_time value: ${probe.results?.[0]?.sale_time ?? '—'}\n`)

// Try a few date filter shapes and report how many each returns.
const FILTERS = [
  `sale_time__gte=${DATE}&sale_time__lte=${DATE}`,
  `sale_time__gte=${DATE}T00:00:00&sale_time__lt=${DATE}T23:59:59`,
  `sale_time__date=${DATE}`,
  `date=${DATE}`,
  `sale_time__startswith=${DATE}`,
  `sale_time__gte=${DATE}T00:00:00Z&sale_time__lte=${DATE}T23:59:59Z`,
]
let winning = null
for (const filt of FILTERS) {
  const r = await pkGet(`/sales/?${filt}&page_size=5`)
  const n = r?.results?.length ?? 0
  const count = r?.count ?? '?'
  console.log(`  ${filt.padEnd(70)} → ${n} rows (count=${count})`)
  if (n > 0 && !winning) winning = filt
}
if (!winning) {
  console.error('\nno date-filter shape returned rows. Investigate PK docs.')
  process.exit(1)
}
console.log(`\n→ using filter: ${winning}\n`)

const salesRes = await pkGet(`/sales/?${winning}&page_size=500`)
if (!salesRes) process.exit(1)
const sales = salesRes.results ?? []
console.log(`fetched ${sales.length} raw PK sales for ${DATE}`)
console.log(`top-level fields on a sale:`)
console.log(`  ${Object.keys(sales[0] ?? {}).sort().join(', ')}\n`)

// ── 3. Sample one item detail (follow .items[0].url if present) ────────────
const sampleItems = sales[0]?.items ?? []
console.log(`item count on first sale: ${sampleItems.length}`)
if (sampleItems.length > 0) {
  console.log(`  inline item fields: ${Object.keys(sampleItems[0] ?? {}).sort().join(', ')}`)
  if (sampleItems[0]?.url) {
    const itemDetail = await fetch(sampleItems[0].url, {
      headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
    }).then(r => r.ok ? r.json() : null)
    if (itemDetail) {
      console.log(`  detailed item fields: ${Object.keys(itemDetail).sort().join(', ')}`)
      console.log(`  detailed item sample:`)
      console.log('   ', JSON.stringify(itemDetail, null, 2).split('\n').join('\n    '))
    }
  }
}

// ── 4. Sample one payment ───────────────────────────────────────────────────
const samplePayments = sales[0]?.payments ?? []
console.log(`\npayment count on first sale: ${samplePayments.length}`)
if (samplePayments[0]) {
  console.log(`  inline payment fields: ${Object.keys(samplePayments[0] ?? {}).sort().join(', ')}`)
  console.log(`  payment sample:`, JSON.stringify(samplePayments[0]))
}

// ── 5. Dump the first full sale raw so we can eyeball it ────────────────────
console.log(`\nfirst raw sale (unmapped):`)
console.log(JSON.stringify(sales[0], null, 2))

// ── 6. Compute candidate totals for the day, compare side-by-side ──────────
function num(v) { const n = parseFloat(v ?? 0); return Number.isFinite(n) ? n : 0 }

let sumPayments    = 0   // current code (amount from payments)
let sumItemsTotal  = 0   // sum of items[].total
let sumItemsPrice  = 0   // sum of items[].price
let sumTip         = 0   // sum of sale.tip
let sumAmountTop   = 0   // sum of sale.amount (if top-level exists)
let sumAmountGross = 0   // sum of sale.amount_gross
let sumAmountNet   = 0   // sum of sale.amount_net
let sumAmountExVat = 0   // sum of sale.amount_ex_vat / amount_ex_moms etc.
let sumMomsBelopp  = 0   // sum of any `moms`, `vat`, `vat_amount` field (to subtract)
let sumBrutto      = 0
let sumNetto       = 0
let sumTotalInkl   = 0
let sumTotalExkl   = 0

// also: collect ALL top-level numeric keys seen across sales, so we can spot
// Swedish field names we haven't mapped.
const numericTopKeys = new Set()
const numericItemKeys = new Set()

for (const s of sales) {
  sumPayments    += (s.payments ?? []).reduce((a, p) => a + num(p.amount), 0)
  sumItemsTotal  += (s.items    ?? []).reduce((a, i) => a + num(i.total), 0)
  sumItemsPrice  += (s.items    ?? []).reduce((a, i) => a + num(i.price), 0)
  sumTip         += num(s.tip)
  sumAmountTop   += num(s.amount)
  sumAmountGross += num(s.amount_gross)
  sumAmountNet   += num(s.amount_net)
  sumAmountExVat += num(s.amount_ex_vat) + num(s.amount_ex_moms) + num(s.ex_moms)
  sumMomsBelopp  += num(s.moms) + num(s.vat) + num(s.vat_amount) + num(s.moms_belopp)
  sumBrutto      += num(s.brutto)
  sumNetto       += num(s.netto)
  sumTotalInkl   += num(s.total_inkl_moms) + num(s.total_inkl_vat)
  sumTotalExkl   += num(s.total_exkl_moms) + num(s.total_exkl_vat) + num(s.total_ex_moms)

  for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v))) {
      numericTopKeys.add(k)
    }
  }
  for (const i of (s.items ?? [])) {
    for (const [k, v] of Object.entries(i)) {
      if (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v))) {
        numericItemKeys.add(k)
      }
    }
  }
}

console.log(`\n═════════════════════════════════════════════════════════════════`)
console.log(`Candidate day totals for ${DATE} (Vero, PK raw)`)
console.log(`═════════════════════════════════════════════════════════════════`)
console.log(`sum payments[].amount           :  ${sumPayments.toFixed(2)}   ← what we currently store`)
console.log(`sum items[].total               :  ${sumItemsTotal.toFixed(2)}`)
console.log(`sum items[].price               :  ${sumItemsPrice.toFixed(2)}`)
console.log(`sum sale.tip                    :  ${sumTip.toFixed(2)}`)
console.log(`sum sale.amount (top-level)     :  ${sumAmountTop.toFixed(2)}`)
console.log(`sum sale.amount_gross           :  ${sumAmountGross.toFixed(2)}`)
console.log(`sum sale.amount_net             :  ${sumAmountNet.toFixed(2)}`)
console.log(`sum sale.amount_ex_(vat|moms)   :  ${sumAmountExVat.toFixed(2)}`)
console.log(`sum sale.moms|vat|vat_amount    :  ${sumMomsBelopp.toFixed(2)}`)
console.log(`sum sale.brutto                 :  ${sumBrutto.toFixed(2)}`)
console.log(`sum sale.netto                  :  ${sumNetto.toFixed(2)}`)
console.log(`sum sale.total_inkl_*           :  ${sumTotalInkl.toFixed(2)}`)
console.log(`sum sale.total_ex(kl)_*         :  ${sumTotalExkl.toFixed(2)}`)
console.log(`\nDerived:`)
console.log(`  payments − tip                :  ${(sumPayments - sumTip).toFixed(2)}`)
console.log(`  payments / 1.25               :  ${(sumPayments / 1.25).toFixed(2)}  (if 25% VAT on gross)`)
console.log(`  payments / 1.12               :  ${(sumPayments / 1.12).toFixed(2)}  (if 12% VAT on gross)`)
console.log(`  (payments−tip) / 1.12         :  ${((sumPayments - sumTip) / 1.12).toFixed(2)}`)
console.log(`  (payments−tip) / 1.25         :  ${((sumPayments - sumTip) / 1.25).toFixed(2)}`)

console.log(`\nAll numeric top-level sale keys seen across ${sales.length} sales:`)
console.log(`  ${[...numericTopKeys].sort().join(', ')}`)
console.log(`\nAll numeric item keys seen:`)
console.log(`  ${[...numericItemKeys].sort().join(', ')}`)

// ── 7. Also pull the PK "sales-summary" / "reports" endpoint if it exists ──
// Many POS APIs expose a dashboard-equivalent endpoint with ex-moms figures.
console.log(`\n--- trying possible summary endpoints ---`)
for (const path of [
  '/sales-summary/',
  '/reports/sales/',
  '/kassa/summary/',
  '/sales/summary/',
  `/sales/?sale_time__gte=${DATE}&sale_time__lte=${DATE}&aggregated=true`,
  '/daily-summary/',
]) {
  const r = await fetch(`https://personalkollen.se/api${path}`, {
    headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
  }).catch(() => null)
  console.log(`  ${path.padEnd(50)} → ${r?.status ?? 'err'}`)
}
