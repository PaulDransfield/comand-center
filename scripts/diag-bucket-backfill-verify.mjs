#!/usr/bin/env node
// Pre-COMMIT verification of M115 — the by-spend believability check.
//
// Reads the dictionary from lib/overheads/basBuckets.ts, applies it to
// every NULL-subcategory row at Chicce + Vero IN MEMORY (no write),
// and produces:
//   - Bucket totals in kronor per business
//   - Top-15 accounts by spend → bucket each mapped to
//   - Category × bucket spend (overhead-only vs revenue/COGS check)
//   - Long-tail of unknown accounts (if any) → are they mappable?
//   - Sample of low-spend rows to spot obvious mis-maps

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
for (const [k, v] of Object.entries(env)) {
  if (!(k in process.env) || /^mock_|^https:\/\/mock-/.test(process.env[k] ?? '')) process.env[k] = v
}
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }
async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: h })
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

const { bucketForAccount, BAS_BUCKET_MAP, ALL_BUCKETS } = await import('../lib/overheads/basBuckets.ts')

const BIZES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

for (const biz of BIZES) {
  console.log(`\n\n══════════════════════════════════════════════════════════════════════════════`)
  console.log(`  ${biz.name}`)
  console.log(`══════════════════════════════════════════════════════════════════════════════`)

  // Pull EVERY row at this business (we'll filter to NULL-subcat in-memory
  // so we can also surface category breakdowns).
  const all = []
  for (let from = 0; ; from += 1000) {
    const batch = await q(`tracker_line_items?business_id=eq.${biz.id}&select=id,category,subcategory,label_sv,amount,fortnox_account,period_year,period_month&offset=${from}&limit=1000`)
    all.push(...batch)
    if (batch.length < 1000) break
    if (all.length > 20000) break
  }

  // Apply dictionary in memory to the NULL-subcategory rows that have a BAS account.
  const target = all.filter(r => (!r.subcategory || r.subcategory === '?') && r.fortnox_account != null)
  const enriched = target.map(r => ({ ...r, _dict: bucketForAccount(r.fortnox_account) }))
  const resolved = enriched.filter(e => e._dict != null)
  const unmapped = enriched.filter(e => e._dict == null)

  console.log(`\nDry-run resolution:`)
  console.log(`  NULL-subcategory rows with BAS account:  ${target.length}`)
  console.log(`  Dictionary resolved:                     ${resolved.length}`)
  console.log(`  Dictionary returned null (unmapped):     ${unmapped.length}`)

  // ── 1. By-spend bucket totals ────────────────────────────────────
  console.log(`\n── 1. By-spend bucket totals (kronor) ──`)
  const byBucket = new Map()
  for (const r of resolved) {
    const k = r._dict.sub
    const cur = byBucket.get(k) ?? { bucket: k, label_en: r._dict.label_en, spend: 0, rows: 0 }
    cur.spend += Math.abs(Number(r.amount ?? 0))
    cur.rows  += 1
    byBucket.set(k, cur)
  }
  const sortedByBucket = [...byBucket.values()].sort((a, b) => b.spend - a.spend)
  for (const b of sortedByBucket) {
    console.log(`  ${b.bucket.padEnd(22)} ${Math.round(b.spend).toLocaleString().padStart(12)} SEK  ${b.rows.toString().padStart(4)} rows  (${b.label_en})`)
  }
  const totalEnrichedSpend = sortedByBucket.reduce((s, b) => s + b.spend, 0)
  console.log(`  ${'(total)'.padEnd(22)} ${Math.round(totalEnrichedSpend).toLocaleString().padStart(12)} SEK`)

  // ── 2. Top-15 accounts by spend → bucket ─────────────────────────
  console.log(`\n── 2. Top-15 NULL-subcategory accounts by spend ──`)
  const byAcct = new Map()
  for (const r of enriched) {
    const k = String(r.fortnox_account)
    const cur = byAcct.get(k) ?? { account: k, spend: 0, rows: 0, label: r.label_sv ?? '?', bucket: r._dict?.sub ?? '(unmapped)', bucket_label: r._dict?.label_en ?? '—' }
    cur.spend += Math.abs(Number(r.amount ?? 0))
    cur.rows  += 1
    byAcct.set(k, cur)
  }
  const topAcct = [...byAcct.values()].sort((a, b) => b.spend - a.spend)
  for (const a of topAcct.slice(0, 15)) {
    console.log(`  ${a.account.padEnd(6)} ${Math.round(a.spend).toLocaleString().padStart(12)} SEK  ${a.bucket.padEnd(22)} ${a.rows.toString().padStart(3)} rows  e.g. "${(a.label ?? '').slice(0, 35)}"`)
  }

  // ── 3. Category × bucket coherence check ──────────────────────────
  console.log(`\n── 3. Bucket spend split by category (coherence) ──`)
  const byCatBucket = new Map()
  for (const r of resolved) {
    const k = `${r.category ?? '?'}/${r._dict.sub}`
    byCatBucket.set(k, (byCatBucket.get(k) ?? 0) + Math.abs(Number(r.amount ?? 0)))
  }
  const sortedCatBucket = [...byCatBucket.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  for (const [k, s] of sortedCatBucket) {
    console.log(`  ${k.padEnd(40)} ${Math.round(s).toLocaleString().padStart(12)} SEK`)
  }

  // ── 4. Unmapped accounts (long tail) ─────────────────────────────
  if (unmapped.length > 0) {
    console.log(`\n── 4. UNMAPPED ACCOUNTS (long-tail to spot-check) ──`)
    const byUnmapped = new Map()
    for (const r of unmapped) {
      const k = String(r.fortnox_account)
      const cur = byUnmapped.get(k) ?? { account: k, spend: 0, rows: 0, label: r.label_sv ?? '?' }
      cur.spend += Math.abs(Number(r.amount ?? 0))
      cur.rows  += 1
      byUnmapped.set(k, cur)
    }
    for (const u of [...byUnmapped.values()].sort((a, b) => b.spend - a.spend)) {
      console.log(`  ${u.account.padEnd(6)} ${Math.round(u.spend).toLocaleString().padStart(12)} SEK  ${u.rows} rows  "${(u.label ?? '').slice(0, 40)}"`)
    }
  } else {
    console.log(`\n── 4. UNMAPPED ACCOUNTS: 0 ✓ ──`)
  }
}

// ── 5. Dictionary self-check ─────────────────────────────────────
console.log(`\n\n── 5. Dictionary self-check ──`)
console.log(`  Distinct accounts in dictionary: ${Object.keys(BAS_BUCKET_MAP).length}`)
console.log(`  Distinct buckets the dict emits: ${ALL_BUCKETS.length}`)
console.log(`  Buckets: ${ALL_BUCKETS.join(', ')}`)
