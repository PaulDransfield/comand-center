// Backfill hourly_metrics for the last N days for a given business.
//
// Re-fetches PK /sales/ for the date range, aggregates by Stockholm-local
// (date × hour), and upserts to hourly_metrics. Same logic as the
// production sync engine — kept in a separate script so it's safe to run
// without firing the rest of the sync (staff_logs, forecasts, aggregator).
//
// Run:
//   node scripts/backfill-hourly-metrics.mjs <business_id> [days=90]
//
// Examples:
//   node scripts/backfill-hourly-metrics.mjs 0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99 90  # Vero
//   node scripts/backfill-hourly-metrics.mjs 97187ef3-b816-4c41-9230-7551430784a7 90  # Rosali

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
// Load both env files — production.local OVERRIDES local. Matches the pattern
// flip-vero-v2-flag.mjs and other scripts in this repo use. .env.local often
// holds placeholders for fresh dev setups; .env.production.local has the
// real Supabase URL + service role + encryption key.
dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env.production.local', override: true })

const businessId = process.argv[2]
const days       = parseInt(process.argv[3] ?? '90', 10)

if (!businessId) {
  console.error('Usage: node scripts/backfill-hourly-metrics.mjs <business_id> [days=90]')
  process.exit(1)
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

console.log('── Environment check ──')
console.log('NEXT_PUBLIC_SUPABASE_URL:    ', url ? `${url.slice(0, 50)}...` : '(missing!)')
console.log('SUPABASE_SERVICE_ROLE_KEY:   ', key ? `${key.slice(0, 12)}... (${key.length} chars)` : '(missing!)')
console.log('CREDENTIAL_ENCRYPTION_KEY:   ', process.env.CREDENTIAL_ENCRYPTION_KEY ? `present (${process.env.CREDENTIAL_ENCRYPTION_KEY.length} chars)` : '(missing!)')
console.log()

if (!url || !key) {
  console.error('FATAL: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from .env.local')
  process.exit(1)
}
const db = createClient(url, key)

// ── Fetch the PK integration ────────────────────────────────────────
const { data: integ, error: integErr } = await db
  .from('integrations')
  .select('id, org_id, business_id, credentials_enc, provider')
  .eq('business_id', businessId)
  .eq('provider', 'personalkollen')
  .maybeSingle()

if (integErr) {
  console.error('FATAL: Supabase query failed.')
  console.error('  Error message:', integErr.message)
  console.error('  Error details:', JSON.stringify(integErr, null, 2))
  console.error('  This is usually a network/auth issue, NOT a "missing integration" — verify .env.local URL + key are correct for the right Supabase project.')
  process.exit(1)
}
if (!integ) {
  console.error(`FATAL: No PK integration row for business_id=${businessId}`)
  console.error('  Confirm the business has Personalkollen connected via /integrations in the app.')
  process.exit(1)
}
console.log(`✓ Found PK integration: id=${integ.id}, org=${integ.org_id}`)

// ── Decrypt token (mirrors lib/integrations/encryption.ts exactly) ──
// Production format: base64(iv + ciphertext + authTag) — one concatenated
// base64 string. Key is 64 hex chars (32 bytes). AES-256-GCM with 12-byte
// IV + 16-byte auth tag. Don't drift from this — any deviation produces
// the unhelpful "data may be corrupted" error and burns debugging time.
const CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY
if (!CREDENTIAL_ENCRYPTION_KEY) {
  console.error('CREDENTIAL_ENCRYPTION_KEY missing from .env.production.local')
  process.exit(1)
}
if (CREDENTIAL_ENCRYPTION_KEY.length !== 64) {
  console.error(`CREDENTIAL_ENCRYPTION_KEY must be 64 hex chars (got ${CREDENTIAL_ENCRYPTION_KEY.length})`)
  process.exit(1)
}

import crypto from 'node:crypto'
const IV_LENGTH  = 12
const TAG_LENGTH = 16

function decrypt(encryptedBase64) {
  if (!encryptedBase64) return null
  const key    = Buffer.from(CREDENTIAL_ENCRYPTION_KEY, 'hex')
  const packed = Buffer.from(encryptedBase64, 'base64')
  const iv         = packed.subarray(0, IV_LENGTH)
  const authTag    = packed.subarray(packed.length - TAG_LENGTH)
  const ciphertext = packed.subarray(IV_LENGTH, packed.length - TAG_LENGTH)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH })
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

const token = decrypt(integ.credentials_enc)
if (!token) {
  console.error('Token decrypt returned empty')
  process.exit(1)
}

// ── Date range ──────────────────────────────────────────────────────
function todayStockholm() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm' }).format(new Date())
}
function daysAgoStockholm(n) {
  const today = new Date(todayStockholm() + 'T00:00:00Z')
  today.setUTCDate(today.getUTCDate() - n)
  return today.toISOString().slice(0, 10)
}
const fromDate = daysAgoStockholm(days)
const toDate   = todayStockholm()
console.log(`Backfill window: ${fromDate} → ${toDate} (${days} days)`)

// ── Fetch all PK sales for the window ───────────────────────────────
// Real PK base URL is https://personalkollen.se/api (NOT api.personalkollen.se,
// NOT /api/v1). Auth header: "Authorization: Token <token>". Mirrors
// fetchAll() in lib/pos/personalkollen.ts.
const PK_BASE = 'https://personalkollen.se/api'

function startOfDay(d) { return `${d}T00:00:00Z` }
function endOfDay(d)   { return `${d}T23:59:59Z` }

async function fetchAll(path) {
  let next = `${PK_BASE}${path}`
  const out = []
  while (next) {
    const r = await fetch(next, {
      headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
    })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new Error(`PK ${r.status} ${body.slice(0, 200)}`)
    }
    const j = await r.json()
    if (Array.isArray(j.results)) out.push(...j.results)
    else if (Array.isArray(j)) out.push(...j)
    next = j.next ?? null
    if (out.length % 1000 === 0 && out.length > 0) console.log(`  fetched ${out.length} rows so far…`)
  }
  return out
}

const params = [
  `sale_time__gte=${startOfDay(fromDate)}`,
  `sale_time__lte=${endOfDay(toDate)}`,
]
console.log(`Fetching PK /sales/ …`)
const sales = await fetchAll(`/sales/?${params.join('&')}`)
console.log(`PK returned ${sales.length} sales`)

// ── Stockholm-local hour helper ─────────────────────────────────────
function stockholmLocalParts(iso) {
  if (!iso) return { date: null, hour: null }
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return { date: null, hour: null }
    const dateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Stockholm',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d)
    const hourStr = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Stockholm',
      hour: '2-digit', hour12: false,
    }).format(d)
    const hour = parseInt(hourStr, 10)
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) return { date: null, hour: null }
    return { date: dateStr, hour }
  } catch {
    return { date: null, hour: null }
  }
}

// ── Aggregate by (date, hour) ───────────────────────────────────────
const byHour = {}
for (const s of sales) {
  if (!s.sale_time) continue
  const { date, hour } = stockholmLocalParts(s.sale_time)
  if (!date || hour == null) continue
  const key = `${date}|${hour}`

  // Reproduce the same VAT-coding logic as lib/pos/personalkollen.ts getSales
  let net = 0, foodNet = 0, drinkNet = 0, takeawayNet = 0, dineInNet = 0, cogsNet = 0, cogsCoverage = 0
  for (const i of (s.items ?? [])) {
    const qty   = parseFloat(i.amount         ?? 0)
    const price = parseFloat(i.price_per_unit ?? 0)
    const vat   = parseFloat(i.vat            ?? 0)
    const line  = qty * price
    net += line
    if      (Math.abs(vat - 0.12) < 0.001) { foodNet  += line; dineInNet   += line }
    else if (Math.abs(vat - 0.06) < 0.001) { foodNet  += line; takeawayNet += line }
    else if (Math.abs(vat - 0.25) < 0.001) { drinkNet += line; dineInNet   += line }
    else                                   { drinkNet += line; dineInNet   += line }
    const purchase = parseFloat(i.product?.purchase_price ?? NaN)
    if (Number.isFinite(purchase) && purchase > 0) {
      cogsNet      += qty * purchase
      cogsCoverage += line
    }
  }
  const tip = s.tip ? parseFloat(s.tip) : 0

  if (!byHour[key]) {
    byHour[key] = {
      business_date: date,
      hour,
      revenue: 0, covers: 0, transactions: 0, tip: 0,
      food: 0, drink: 0, takeaway: 0, dine_in: 0,
      cogs: 0, cogs_coverage: 0,
    }
  }
  const row = byHour[key]
  row.revenue       += net
  row.covers        += s.number_of_guests ?? 0
  row.transactions  += 1
  row.tip           += tip
  row.food          += foodNet
  row.drink         += drinkNet
  row.takeaway      += takeawayNet
  row.dine_in       += dineInNet
  row.cogs          += cogsNet
  row.cogs_coverage += cogsCoverage
}

const rows = Object.values(byHour)
  .filter(r => r.revenue > 0)
  .map(r => ({
    org_id:           integ.org_id,
    business_id:      integ.business_id,
    business_date:    r.business_date,
    hour:             r.hour,
    revenue:          Math.round(r.revenue       * 100) / 100,
    covers:           r.covers,
    transactions:     r.transactions,
    food_revenue:     Math.round(r.food          * 100) / 100,
    bev_revenue:      Math.round(r.drink         * 100) / 100,
    takeaway_revenue: Math.round(r.takeaway      * 100) / 100,
    dine_in_revenue:  Math.round(r.dine_in       * 100) / 100,
    tip_revenue:      Math.round(r.tip           * 100) / 100,
    cogs_amount:      Math.round(r.cogs          * 100) / 100,
    cogs_coverage:    Math.round(r.cogs_coverage * 100) / 100,
    provider:         'personalkollen',
  }))

console.log(`Aggregated to ${rows.length} (date × hour) cells across ${new Set(rows.map(r => r.business_date)).size} days`)

if (rows.length === 0) {
  console.log('Nothing to upsert.')
  process.exit(0)
}

// ── Upsert in chunks of 500 to keep payload sane ────────────────────
const CHUNK = 500
let upserted = 0
for (let i = 0; i < rows.length; i += CHUNK) {
  const slice = rows.slice(i, i + CHUNK)
  const { error } = await db
    .from('hourly_metrics')
    .upsert(slice, { onConflict: 'business_id,business_date,hour,provider' })
  if (error) {
    console.error(`Chunk ${i}-${i + slice.length} failed:`, error.message)
    process.exit(1)
  }
  upserted += slice.length
  console.log(`  upserted ${upserted}/${rows.length}`)
}

console.log(`\n✓ Backfilled ${upserted} hourly_metrics rows for ${businessId}`)

// ── Distribution summary ────────────────────────────────────────────
const byHourSummary = {}
for (const r of rows) {
  byHourSummary[r.hour] = (byHourSummary[r.hour] ?? 0) + r.revenue
}
console.log('\nRevenue distribution by hour (Stockholm-local):')
for (let h = 0; h < 24; h++) {
  const rev = byHourSummary[h] ?? 0
  const bar = '█'.repeat(Math.min(40, Math.round(rev / 5000)))
  console.log(`  ${String(h).padStart(2, '0')}:00  ${rev.toLocaleString('en-GB').padStart(12)}  ${bar}`)
}
