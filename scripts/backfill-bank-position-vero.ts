// scripts/backfill-bank-position-vero.ts
//
// One-shot population of bank_net_change + bank_accounts on Vero's existing
// tracker_data rows. Surgical UPDATEs only — does NOT touch revenue, costs,
// or any other P&L field.
//
// Why a separate script: we just shipped the M069 columns + translator
// extension, but Vero's existing 5 fortnox_api rows were written BEFORE
// the translator knew about bank data. Re-running the full backfill
// worker would also touch the P&L fields. This script just re-fetches
// the vouchers and updates ONLY the new bank columns.
//
// Run: npx -y dotenv-cli -e .env.production.local -- npx tsx scripts/backfill-bank-position-vero.ts

import { createClient } from '@supabase/supabase-js'
import { fetchVouchersForRange } from '../lib/fortnox/api/vouchers'
import { translateVouchersToPeriods } from '../lib/fortnox/api/voucher-to-aggregator'

const VERO_ORG_ID      = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'
const VERO_BUSINESS_ID = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE env missing')
  const db = createClient(url, key)

  // 12 months back from today.
  const today  = new Date()
  const toIso  = today.toISOString().slice(0, 10)
  const from   = new Date(today); from.setUTCMonth(from.getUTCMonth() - 12); from.setUTCDate(1)
  const fromIso = from.toISOString().slice(0, 10)

  console.log(`[bank-backfill] Vero — fetching vouchers ${fromIso} → ${toIso}`)
  const t0 = Date.now()
  const result = await fetchVouchersForRange({
    db, orgId: VERO_ORG_ID, businessId: VERO_BUSINESS_ID,
    fromDate: fromIso, toDate: toIso,
    progressEvery: 100,
  })
  console.log(`[bank-backfill] fetched ${result.vouchers.length} vouchers in ${Math.round((Date.now()-t0)/1000)}s`)

  // Run the extended translator
  const translation = translateVouchersToPeriods(result.vouchers)
  console.log(`[bank-backfill] translator produced ${translation.periods.length} period rollups`)

  // For each period, UPDATE only the bank columns on the existing tracker_data row
  let updated = 0, missing = 0, skipped = 0, errored = 0
  for (const p of translation.periods) {
    const hasBankData = p.bank && Object.keys(p.bank.accounts).length > 0
    if (!hasBankData) { skipped++; continue }

    // Find the existing tracker_data row to update
    const { data: existing, error: lookupErr } = await db
      .from('tracker_data')
      .select('id, source, bank_net_change')
      .eq('business_id', VERO_BUSINESS_ID)
      .eq('period_year', p.year)
      .eq('period_month', p.month)
      .maybeSingle()
    if (lookupErr) { errored++; console.error(`  ${p.year}-${p.month}: lookup ${lookupErr.message}`); continue }
    if (!existing) {
      missing++
      console.log(`  ${p.year}-${String(p.month).padStart(2,'0')}: no tracker_data row (skipping — next backfill will create with bank data)`)
      continue
    }

    const { error: updErr } = await db
      .from('tracker_data')
      .update({
        bank_net_change: p.bank.net_change,
        bank_accounts:   p.bank.accounts,
        updated_at:      new Date().toISOString(),
      })
      .eq('id', existing.id)
    if (updErr) {
      errored++
      console.error(`  ${p.year}-${p.month}: update ${updErr.message}`)
      continue
    }

    updated++
    const accountList = Object.keys(p.bank.accounts).sort().join(',')
    console.log(`  ${p.year}-${String(p.month).padStart(2,'0')}  source=${existing.source}  net=${p.bank.net_change.toLocaleString('sv-SE').padStart(12)} kr  accounts=[${accountList}]`)
  }

  console.log()
  console.log(`[bank-backfill] DONE.  updated=${updated} skipped=${skipped} missing=${missing} errored=${errored}`)
}

main().catch(e => { console.error(e); process.exit(1) })
