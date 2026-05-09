// scripts/dump-vero-march-vouchers.ts
//
// Fetch Vero Italiano's March 2026 vouchers from Fortnox via the API,
// translate them through voucher-to-aggregator + projectRollup, and
// compare against the known-good PDF baseline.
//
// March 2026 is the test target because it's a CLOSED month where we
// have an authoritative PDF result in tracker_data:
//   revenue=1,603,919  food_cost=461,333  staff_cost=665,173
//
// Run:
//   npx tsx scripts/dump-vero-march-vouchers.ts
//
// Side effects:
//   - Reads Fortnox tokens from integrations table (admin client, RLS bypassed).
//   - Writes raw vouchers JSON to scripts/_out/vero-march-2026.json
//   - Writes translated rollup JSON to scripts/_out/vero-march-2026-rollup.json
//   - Prints expected-vs-actual diff to stdout.
//
// Does NOT write to tracker_data. Read-only against production.
//
// Required env (loaded from .env.local automatically by tsx if dotenv-cli used,
// or set inline):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   FORTNOX_CLIENT_ID
//   FORTNOX_CLIENT_SECRET

import { createClient } from '@supabase/supabase-js'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { fetchVouchersForRange } from '../lib/fortnox/api/vouchers'
import { translateVouchersToPeriods } from '../lib/fortnox/api/voucher-to-aggregator'
import { projectRollup } from '../lib/finance/projectRollup'

// ── Vero Italiano (test fixture per CLAUDE.md) ───────────────────────────────
const VERO_ORG_ID      = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'
const VERO_BUSINESS_ID = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

// March 2026 closed-month baseline from PDF apply (source='fortnox_pdf')
const PDF_BASELINE = {
  revenue:    1_603_919,
  food_cost:    461_333,
  staff_cost:   665_173,
}

const FROM = '2026-03-01'
const TO   = '2026-03-31'

async function main() {
  console.log(`[dump] Vero Italiano · March 2026 voucher diagnostic`)
  console.log(`[dump] Range: ${FROM} → ${TO}`)
  console.log(`[dump] PDF baseline: revenue=${PDF_BASELINE.revenue.toLocaleString()}  food=${PDF_BASELINE.food_cost.toLocaleString()}  staff=${PDF_BASELINE.staff_cost.toLocaleString()}`)
  console.log('')

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — load .env.local first')
  }
  const db = createClient(supabaseUrl, serviceKey)

  // ── Fetch ──────────────────────────────────────────────────────────────────
  console.log('[dump] Fetching vouchers via Fortnox API…')
  const startedAt = Date.now()
  const fetchResult = await fetchVouchersForRange({
    db,
    orgId:       VERO_ORG_ID,
    businessId:  VERO_BUSINESS_ID,
    fromDate:    FROM,
    toDate:      TO,
    progressEvery: 50,
  })
  console.log(`[dump] Fetched ${fetchResult.vouchers.length} vouchers in ${(Date.now() - startedAt) / 1000}s`)
  console.log(`[dump]   list_requests=${fetchResult.listRequests}  detail_requests=${fetchResult.detailRequests}  token_refreshed=${fetchResult.tokenRefreshed}`)
  console.log('')

  // ── Persist raw vouchers (for fixture / future regression) ────────────────
  const outDir = join(process.cwd(), 'scripts', '_out')
  await mkdir(outDir, { recursive: true })
  const rawPath = join(outDir, 'vero-march-2026.json')
  await writeFile(rawPath, JSON.stringify(fetchResult.vouchers, null, 2))
  console.log(`[dump] Wrote raw vouchers → ${rawPath}`)

  // ── Translate ──────────────────────────────────────────────────────────────
  const translation = translateVouchersToPeriods(fetchResult.vouchers)
  const marchPeriod = translation.periods.find(p => p.year === 2026 && p.month === 3)

  if (!marchPeriod) {
    console.error(`[dump] ERROR: no March 2026 period in translation output`)
    console.error(`[dump]   periods returned: ${translation.periods.map(p => `${p.year}-${p.month}`).join(', ')}`)
    console.error(`[dump]   skipped vouchers: ${translation.skipped.length}`)
    process.exit(1)
  }

  // ── Project (same path as the worker) ──────────────────────────────────────
  const projected = projectRollup(marchPeriod.rollup, marchPeriod.lines)

  const rollupPath = join(outDir, 'vero-march-2026-rollup.json')
  await writeFile(rollupPath, JSON.stringify({
    raw_rollup:   marchPeriod.rollup,
    line_count:   marchPeriod.lines.length,
    voucher_count: marchPeriod.voucherCount,
    skipped:      translation.skipped.length,
    projected,
  }, null, 2))
  console.log(`[dump] Wrote rollup → ${rollupPath}`)
  console.log('')

  // ── Account-range histogram (so we can see WHERE the money went) ──────────
  const byAccount = new Map<number, { debit: number; credit: number; rows: number }>()
  for (const v of fetchResult.vouchers) {
    if (!v.TransactionDate?.startsWith('2026-03')) continue
    for (const r of v.VoucherRows ?? []) {
      if (r.Removed) continue
      const acct = Number(r.Account)
      if (!Number.isFinite(acct)) continue
      const cur = byAccount.get(acct) ?? { debit: 0, credit: 0, rows: 0 }
      cur.debit  += Number(r.Debit  ?? 0)
      cur.credit += Number(r.Credit ?? 0)
      cur.rows   += 1
      byAccount.set(acct, cur)
    }
  }
  const acctRows = Array.from(byAccount.entries())
    .map(([acct, t]) => ({ acct, ...t, net: t.credit - t.debit }))
    .sort((a, b) => a.acct - b.acct)

  // Bucketed totals (matches classify.ts ranges)
  const buckets = {
    '3000-3999 revenue (credit-debit)':       0,
    '4000-4999 food cost (debit-credit)':     0,
    '5000-6999 other_cost (debit-credit)':    0,
    '7000-7799 staff (debit-credit)':         0,
    '7800-7899 depreciation (debit-credit)':  0,
    '7900-7999 staff (debit-credit)':         0,
    '8000-8899 financial (credit-debit)':     0,
    '8900-8999 tax (debit-credit)':           0,
    'other (1xxx, 2xxx, etc — ignored)':      0,
  }
  for (const r of acctRows) {
    if (r.acct >= 3000 && r.acct <= 3999)      buckets['3000-3999 revenue (credit-debit)']      += r.credit - r.debit
    else if (r.acct >= 4000 && r.acct <= 4999) buckets['4000-4999 food cost (debit-credit)']    += r.debit - r.credit
    else if (r.acct >= 5000 && r.acct <= 6999) buckets['5000-6999 other_cost (debit-credit)']   += r.debit - r.credit
    else if (r.acct >= 7000 && r.acct <= 7799) buckets['7000-7799 staff (debit-credit)']        += r.debit - r.credit
    else if (r.acct >= 7800 && r.acct <= 7899) buckets['7800-7899 depreciation (debit-credit)'] += r.debit - r.credit
    else if (r.acct >= 7900 && r.acct <= 7999) buckets['7900-7999 staff (debit-credit)']        += r.debit - r.credit
    else if (r.acct >= 8000 && r.acct <= 8899) buckets['8000-8899 financial (credit-debit)']    += r.credit - r.debit
    else if (r.acct >= 8900 && r.acct <= 8999) buckets['8900-8999 tax (debit-credit)']          += r.debit - r.credit
    else                                       buckets['other (1xxx, 2xxx, etc — ignored)']    += r.debit  // raw side, just for visibility
  }

  console.log('── Bucketed account totals (raw, before translator sign convention) ──')
  for (const [k, v] of Object.entries(buckets)) {
    console.log(`  ${k.padEnd(46)} ${formatKr(v)}`)
  }
  console.log('')

  // ── Diff vs PDF baseline ──────────────────────────────────────────────────
  console.log('── Translator output vs PDF baseline ──')
  console.log(`  Field         API translation       PDF baseline       Diff           % off`)
  for (const k of ['revenue', 'food_cost', 'staff_cost'] as const) {
    const api = Number((projected as any)[k] ?? 0)
    const pdf = (PDF_BASELINE as any)[k]
    const diff = api - pdf
    const pct  = pdf === 0 ? 'n/a' : `${((diff / pdf) * 100).toFixed(1)}%`
    console.log(`  ${k.padEnd(13)} ${formatKr(api).padStart(20)}  ${formatKr(pdf).padStart(18)}  ${formatKr(diff).padStart(13)}  ${pct.padStart(7)}`)
  }
  console.log('')

  // ── Top 20 accounts by absolute net amount (for inspection) ───────────────
  console.log('── Top 20 accounts by |net amount| ──')
  const top = [...acctRows].sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 20)
  console.log(`  acct   debit              credit            net (cr-db)     rows`)
  for (const r of top) {
    console.log(`  ${String(r.acct).padEnd(6)} ${formatKr(r.debit).padStart(16)}  ${formatKr(r.credit).padStart(16)}  ${formatKr(r.net).padStart(15)}  ${String(r.rows).padStart(4)}`)
  }
  console.log('')

  console.log(`[dump] Done. Inspect ${rawPath} and ${rollupPath} for the full picture.`)
}

function formatKr(n: number): string {
  return Math.round(n).toLocaleString('en-GB')
}

main().catch(err => {
  console.error('[dump] FAILED:', err?.stack ?? err)
  // Node 18+ fetch wraps the real network error in `cause`. Dig through.
  let cause: any = err?.cause
  let depth = 1
  while (cause && depth < 6) {
    console.error(`  cause[${depth}]:`, cause?.message ?? cause, cause?.code ? `(code=${cause.code})` : '')
    if (cause?.errors && Array.isArray(cause.errors)) {
      for (const e of cause.errors) console.error(`    sub:`, e?.message ?? e, e?.code ? `(code=${e.code})` : '')
    }
    cause = cause?.cause
    depth++
  }
  process.exit(1)
})
