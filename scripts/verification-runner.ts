// @ts-nocheck
// scripts/verification-runner.ts
//
// Phase 1 Fortnox API verification harness — runner.
//
// What it does:
//   1. Open a verification_runs row (`status='in_progress'`)
//   2. Fetch all vouchers for Vero org (e917d4b8-635e-4be6-8af0-afc48c3c7450)
//      for the last 90 days via the API
//   3. Translate vouchers → per-period rollups + line items
//   4. Run projectRollup() per period to get the canonical shape
//   5. TRUNCATE the verification_* tables and write fresh rows for this run
//   6. Close the verification_runs row (`status='completed'`)
//
// What it does NOT do:
//   - Touch any production table. Only verification_* tables are written.
//   - Run the daily/dept aggregator. The diff against monthly_metrics is
//     done in scripts/verification-report.ts; the daily/dept comparisons
//     would need API-fetched POS data which is out of Phase 1 scope.
//   - Email anyone. It writes to stdout and to verification_runs.metadata.
//
// Usage:
//   npx tsx scripts/verification-runner.ts
//
// Required env (loaded from .env.local automatically by tsx via dotenv):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   CREDENTIAL_ENCRYPTION_KEY
//   FORTNOX_CLIENT_ID
//   FORTNOX_CLIENT_SECRET
//
// Hard preconditions:
//   - Migration M048 applied (verification_* tables exist).
//   - Vero (e917d4b8-…) has a valid OAuth token in `integrations` with
//     status='connected'.
//
// Exit codes:
//   0 — success, run finished, comparison can proceed
//   1 — preflight failure (env, schema, integration row)
//   2 — fetch failure (Fortnox API error)
//   3 — write failure (DB error)

import { createClient }              from '@supabase/supabase-js'
import { fetchVouchersForRange }     from '../lib/fortnox/api/vouchers'
import { translateVouchersToPeriods } from '../lib/fortnox/api/voucher-to-aggregator'
import { projectRollup }             from '../lib/finance/projectRollup'

// ── Constants ────────────────────────────────────────────────────────────────

const VERO_ORG_ID = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'

// 90-day window ending today. Phase 1 prompt says 2026-02-07 to 2026-05-06,
// computed from the prompt's generation date 2026-05-07. Keep it as constants
// so re-runs are deterministic.
const FROM_DATE = '2026-02-07'
const TO_DATE   = '2026-05-06'

// Tables to truncate before each run. Order doesn't matter — verification
// tables have no foreign keys to each other.
const VERIFICATION_TABLES = [
  'verification_tracker_data',
  'verification_tracker_line_items',
  'verification_monthly_metrics',
  'verification_daily_metrics',
  'verification_dept_metrics',
  'verification_revenue_logs',
  'verification_financial_logs',
]

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  preflight()

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  await assertM048Applied(db)
  const integ = await loadVeroFortnoxIntegration(db)

  // Open run row
  const { data: runRow, error: runErr } = await db
    .from('verification_runs')
    .insert({
      org_id:      VERO_ORG_ID,
      business_id: integ.business_id,
      from_date:   FROM_DATE,
      to_date:     TO_DATE,
      status:      'in_progress',
    })
    .select('id')
    .single()
  if (runErr) {
    console.error('Failed to open verification_runs row:', runErr.message)
    process.exit(3)
  }
  const runId = runRow.id
  console.log(`[verification] run ${runId} opened — fetching vouchers ${FROM_DATE} → ${TO_DATE}`)

  // Fetch
  let fetchResult
  try {
    fetchResult = await fetchVouchersForRange({
      db,
      orgId:      VERO_ORG_ID,
      businessId: integ.business_id,
      fromDate:   FROM_DATE,
      toDate:     TO_DATE,
    })
  } catch (e: any) {
    await markRunFailed(db, runId, `fetch: ${e?.message ?? String(e)}`)
    console.error('[verification] fetch failed:', e?.message ?? e)
    process.exit(2)
  }
  console.log(
    `[verification] fetched ${fetchResult.vouchers.length} vouchers in ${fetchResult.durationMs}ms` +
    ` (${fetchResult.listRequests} list requests, ${fetchResult.detailRequests} detail requests` +
    `${fetchResult.tokenRefreshed ? ', token refreshed mid-run' : ''})`,
  )

  // Translate + project
  const translated = translateVouchersToPeriods(fetchResult.vouchers)
  console.log(`[verification] translated into ${translated.periods.length} periods (${translated.skipped.length} skipped)`)

  const projectedRows = translated.periods.map(p => {
    const proj = projectRollup(p.rollup, p.lines)
    return {
      period: p,
      proj,
    }
  })

  // Truncate the verification mirror tables before writing fresh rows.
  try {
    await truncateVerificationTables(db)
  } catch (e: any) {
    await markRunFailed(db, runId, `truncate: ${e?.message ?? String(e)}`)
    console.error('[verification] truncate failed:', e?.message ?? e)
    process.exit(3)
  }

  // Write tracker_data + tracker_line_items rows
  let trackerRows = 0
  let lineRows    = 0
  for (const { period, proj } of projectedRows) {
    const trackerInsert = {
      org_id:           VERO_ORG_ID,
      business_id:      integ.business_id,
      period_year:      period.year,
      period_month:     period.month,
      revenue:          proj.revenue,
      dine_in_revenue:  proj.dine_in_revenue,
      takeaway_revenue: proj.takeaway_revenue,
      alcohol_revenue:  proj.alcohol_revenue,
      food_cost:        proj.food_cost,
      alcohol_cost:     proj.alcohol_cost,
      staff_cost:       proj.staff_cost,
      other_cost:       proj.other_cost,
      // depreciation + financial may not be present on legacy tracker_data
      // schemas. Insert defensively — if the column doesn't exist it'll error
      // with a clear message and the comparison can still happen on the rest.
      total_cost:       proj.food_cost + proj.staff_cost + proj.other_cost,
      net_profit:       proj.net_profit,
      margin_pct:       proj.margin_pct,
      source:           'fortnox_api_verification',
    }

    const { data: tdRow, error: tdErr } = await db
      .from('verification_tracker_data')
      .insert(trackerInsert)
      .select('id')
      .single()
    if (tdErr) {
      await markRunFailed(db, runId, `write tracker_data: ${tdErr.message}`)
      console.error('[verification] write tracker_data failed for', period.year, period.month, tdErr.message)
      process.exit(3)
    }
    trackerRows++

    // Line items for this period
    const lineInserts = period.lines.map(l => ({
      org_id:          VERO_ORG_ID,
      business_id:     integ.business_id,
      period_year:     period.year,
      period_month:    period.month,
      tracker_data_id: tdRow.id,
      label:           l.label ?? '',
      label_sv:        l.label_sv ?? l.label ?? '',
      category:        l.category,
      subcategory:     l.subcategory,
      amount:          l.amount,
      fortnox_account: l.fortnox_account,
      // Mark which API run produced these so future debugging can join back.
      source:          'fortnox_api_verification',
    }))

    if (lineInserts.length) {
      // Chunk to keep individual INSERTs small — 200 rows / chunk is safe.
      for (let i = 0; i < lineInserts.length; i += 200) {
        const chunk = lineInserts.slice(i, i + 200)
        const { error: liErr } = await db
          .from('verification_tracker_line_items')
          .insert(chunk)
        if (liErr) {
          await markRunFailed(db, runId, `write tracker_line_items: ${liErr.message}`)
          console.error('[verification] write tracker_line_items failed:', liErr.message)
          process.exit(3)
        }
        lineRows += chunk.length
      }
    }
  }

  // Close run row
  const { error: closeErr } = await db
    .from('verification_runs')
    .update({
      run_finished_at: new Date().toISOString(),
      status:          'completed',
      voucher_count:   fetchResult.vouchers.length,
      invoice_count:   null,    // not fetched in Phase 1
      metadata: {
        list_requests:    fetchResult.listRequests,
        detail_requests:  fetchResult.detailRequests,
        duration_ms:      fetchResult.durationMs,
        token_refreshed:  fetchResult.tokenRefreshed,
        periods_written:  trackerRows,
        line_items_written: lineRows,
        skipped_vouchers: translated.skipped.length,
      },
    })
    .eq('id', runId)
  if (closeErr) {
    console.error('[verification] failed to close run row:', closeErr.message)
    // Don't exit non-zero — the data is already written. Just log.
  }

  console.log(`[verification] done — ${trackerRows} tracker_data rows, ${lineRows} line items, run ${runId}`)
  console.log(`[verification] next step: npx tsx scripts/verification-report.ts ${runId}`)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function preflight(): void {
  const required = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'CREDENTIAL_ENCRYPTION_KEY',
    'FORTNOX_CLIENT_ID',
    'FORTNOX_CLIENT_SECRET',
  ]
  const missing = required.filter(k => !process.env[k])
  if (missing.length) {
    console.error('[verification] preflight failed — missing env vars:', missing.join(', '))
    process.exit(1)
  }
}

async function assertM048Applied(db: any): Promise<void> {
  const { data, error } = await db
    .from('verification_runs')
    .select('id')
    .limit(1)
  if (error) {
    console.error(
      '[verification] M048 not applied (or DB unreachable). ' +
      'Apply sql/M048-VERIFICATION-TABLES.sql in Supabase and re-run.',
    )
    console.error('   underlying error:', error.message)
    process.exit(1)
  }
}

async function loadVeroFortnoxIntegration(db: any): Promise<any> {
  const { data, error } = await db
    .from('integrations')
    .select('id, org_id, business_id, status')
    .eq('org_id', VERO_ORG_ID)
    .eq('provider', 'fortnox')
    .eq('status', 'connected')
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('[verification] failed to load Vero Fortnox integration:', error.message)
    process.exit(1)
  }
  if (!data) {
    console.error(
      '[verification] no connected Fortnox integration for Vero org ' + VERO_ORG_ID + '. ' +
      'Confirm via /admin/v2/customers or run a Connect flow against Vero before retrying.',
    )
    process.exit(1)
  }
  return data
}

async function truncateVerificationTables(db: any): Promise<void> {
  // PostgREST doesn't expose TRUNCATE. Use bulk delete instead — these are
  // verification tables, never large, and the simpler API saves us writing
  // an RPC just for harness use.
  for (const t of VERIFICATION_TABLES) {
    const { error } = await db.from(t).delete().neq('id', '00000000-0000-0000-0000-000000000000')
    if (error) throw new Error(`delete ${t}: ${error.message}`)
  }
}

async function markRunFailed(db: any, runId: string, message: string): Promise<void> {
  await db
    .from('verification_runs')
    .update({
      run_finished_at: new Date().toISOString(),
      status:          'failed',
      error_message:   message.slice(0, 1000),
    })
    .eq('id', runId)
}

main().catch(e => {
  console.error('[verification] uncaught:', e?.stack ?? e)
  process.exit(3)
})
