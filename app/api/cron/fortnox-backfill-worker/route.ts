// app/api/cron/fortnox-backfill-worker/route.ts
//
// 12-month Fortnox API backfill worker.
//
// When a customer connects Fortnox via OAuth, the callback in
// app/api/integrations/fortnox/route.ts sets `integrations.backfill_status =
// 'pending'`. This worker drains pending Fortnox integrations and writes
// 12 months of API-derived `tracker_data` rows so the budget AI, forecasting,
// and scheduling agents have history to work with from day one.
//
// Pipeline:
//   1. Atomic claim — flip one pending Fortnox integration row to 'running'.
//   2. Fetch 12 months of vouchers via lib/fortnox/api/vouchers.ts.
//   3. Translate to per-period rollup + line items via
//      lib/fortnox/api/voucher-to-aggregator.ts.
//   4. Per period: project via projectRollup, idempotency-check vs PDF data,
//      write canonical tracker_data row with source='fortnox_api'.
//   5. Mark completed (or failed with error message).
//
// Trigger model:
//   - Primary: fire-and-forget HTTP POST from the OAuth callback right after
//     the integration row is upserted. Customer doesn't wait for cron tick.
//   - Backstop: daily cron in vercel.json (provides retry on the rare case
//     where the immediate fire-and-forget never reached the worker, e.g.
//     Vercel routing blip).
//
// Idempotency:
//   - Skip months where tracker_data already has a row with
//     source IN ('fortnox_pdf', 'fortnox_apply'). PDF apply is the canonical
//     human-reviewed path; never overwrite it with API-derived data.
//   - Overwrite our own prior 'fortnox_api' rows (re-running the backfill is
//     idempotent at the period level).
//
// Auth: CRON_SECRET bearer token. Not exposed to the browser.

import { NextRequest, NextResponse }     from 'next/server'
import { waitUntil }                     from '@vercel/functions'
import { createAdminClient }             from '@/lib/supabase/server'
import { log }                           from '@/lib/log/structured'
import { fetchVouchersForRange }         from '@/lib/fortnox/api/vouchers'
import { translateVouchersToPeriods }    from '@/lib/fortnox/api/voucher-to-aggregator'
import { projectRollup }                 from '@/lib/finance/projectRollup'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
// 12 months of vouchers + per-voucher detail can take 5-10 minutes for a
// busy restaurant under Fortnox's 25-req-per-5-sec rate limit. Vercel Pro
// allows up to 300s on a function; we cap our work to that and rely on
// the worker re-firing itself (status stays 'pending' until completion)
// if it didn't finish in one slice. v1 doesn't implement resumption — if
// a single restaurant exceeds 300s the row is left in 'running' and the
// cron's daily backstop will re-claim it once we add resume logic. For
// Vero's voucher volume (~30/day) the full 12-month fetch is well under 5min.
export const maxDuration = 300

const PROVIDER       = 'fortnox'
const DEFAULT_MONTHS = 12
const MIN_MONTHS     = 1
const MAX_MONTHS     = 24

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createAdminClient()
  const startedAt = Date.now()

  // Optional `months` override (1..24) — admin kick endpoint passes this so
  // we can bisect issues by running a smaller backfill first. Defaults to 12.
  const overrideBody = await req.json().catch(() => ({} as any))
  const requestedMonths = Number(overrideBody?.months)
  const MONTHS = Number.isFinite(requestedMonths) && requestedMonths >= MIN_MONTHS && requestedMonths <= MAX_MONTHS
    ? Math.floor(requestedMonths)
    : DEFAULT_MONTHS

  // ── 1. Atomic claim ──────────────────────────────────────────────────────
  // Find one pending Fortnox integration. If two workers fire at the same
  // moment they may both read this row, but only one of them survives the
  // UPDATE because the second eq('backfill_status','pending') turns the
  // other worker's UPDATE into a zero-row no-op.
  const { data: pending } = await db
    .from('integrations')
    .select('id, org_id, business_id')
    .eq('backfill_status', 'pending')
    .eq('provider', PROVIDER)
    .limit(1)
    .maybeSingle()

  if (!pending) {
    return NextResponse.json({ ok: true, empty: true })
  }

  const { data: claimed, error: claimErr } = await db
    .from('integrations')
    .update({
      backfill_status:     'running',
      backfill_started_at: new Date().toISOString(),
      backfill_progress:   { phase: 'claimed', months_total: MONTHS, months_done: 0 },
      backfill_error:      null,
    })
    .eq('id', pending.id)
    .eq('backfill_status', 'pending')        // atomic gate — second worker no-ops
    .select('id, org_id, business_id')
    .maybeSingle()

  if (claimErr || !claimed) {
    // Another worker claimed this row first.
    return NextResponse.json({ ok: true, empty: false, contended: true })
  }

  const integrationId = claimed.id
  const orgId         = claimed.org_id
  const businessId    = claimed.business_id

  log.info('fortnox-backfill claim', {
    route:          'cron/fortnox-backfill-worker',
    integration_id: integrationId,
    org_id:         orgId,
    business_id:    businessId,
  })

  try {
    // ── 2. Compute date range ─────────────────────────────────────────────
    const toDate   = new Date()
    const fromDate = new Date(toDate)
    fromDate.setUTCMonth(fromDate.getUTCMonth() - MONTHS)
    const fromIso  = fromDate.toISOString().slice(0, 10)
    const toIso    = toDate.toISOString().slice(0, 10)

    await markProgress(db, integrationId, { phase: 'fetching', from_date: fromIso, to_date: toIso, months_requested: MONTHS, months_done: 0 })

    // ── 3. Fetch vouchers ──────────────────────────────────────────────────
    const fetchResult = await fetchVouchersForRange({
      db,
      orgId,
      businessId: businessId ?? undefined,
      fromDate:   fromIso,
      toDate:     toIso,
    })

    log.info('fortnox-backfill fetched', {
      route:           'cron/fortnox-backfill-worker',
      integration_id:  integrationId,
      voucher_count:   fetchResult.vouchers.length,
      list_requests:   fetchResult.listRequests,
      detail_requests: fetchResult.detailRequests,
      duration_ms:     fetchResult.durationMs,
      token_refreshed: fetchResult.tokenRefreshed,
    })

    await markProgress(db, integrationId, {
      phase:           'translating',
      voucher_count:   fetchResult.vouchers.length,
      list_requests:   fetchResult.listRequests,
      detail_requests: fetchResult.detailRequests,
    })

    // ── 4. Translate + project + write per period ──────────────────────────
    const translated = translateVouchersToPeriods(fetchResult.vouchers)

    // Pre-load existing tracker_data sources for these periods so we can
    // skip months that PDF apply has already written. Single query.
    const periodKeys = translated.periods.map(p => `${p.year}-${String(p.month).padStart(2, '0')}`)
    const existingByKey = new Map<string, { id: string; source: string | null }>()
    if (businessId && periodKeys.length > 0) {
      const minYear = Math.min(...translated.periods.map(p => p.year))
      const maxYear = Math.max(...translated.periods.map(p => p.year))
      const { data: existing } = await db
        .from('tracker_data')
        .select('id, period_year, period_month, source')
        .eq('business_id', businessId)
        .gte('period_year', minYear)
        .lte('period_year', maxYear)
      for (const row of existing ?? []) {
        const key = `${row.period_year}-${String(row.period_month).padStart(2, '0')}`
        existingByKey.set(key, { id: row.id, source: row.source })
      }
    }

    const PDF_SOURCES   = new Set(['fortnox_pdf', 'fortnox_apply'])
    let monthsWritten   = 0
    let monthsSkippedPdf = 0
    let monthsTotal     = translated.periods.length

    for (let i = 0; i < translated.periods.length; i++) {
      const period = translated.periods[i]
      const key    = `${period.year}-${String(period.month).padStart(2, '0')}`
      const existing = existingByKey.get(key)

      if (existing && existing.source && PDF_SOURCES.has(existing.source)) {
        monthsSkippedPdf++
        continue
      }

      const proj = projectRollup(period.rollup, period.lines)

      // tracker_data write payload — uses storage convention from
      // lib/finance/conventions.ts: revenue +, costs +, financial signed.
      // source='fortnox_api' to distinguish from PDF apply.
      // created_via='fortnox_backfill' per M047.
      const payload: Record<string, any> = {
        org_id:           orgId,
        business_id:      businessId,
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
        total_cost:       proj.food_cost + proj.staff_cost + proj.other_cost + proj.depreciation,
        net_profit:       proj.net_profit,
        margin_pct:       proj.margin_pct,
        source:           'fortnox_api',
        created_via:      'fortnox_backfill',
        updated_at:       new Date().toISOString(),
      }

      if (existing) {
        // Overwrite our own prior fortnox_api row (re-runs are idempotent).
        const { error } = await db.from('tracker_data').update(payload).eq('id', existing.id)
        if (error) throw new Error(`update ${key}: ${error.message}`)
      } else {
        const { error } = await db.from('tracker_data').insert(payload)
        if (error) throw new Error(`insert ${key}: ${error.message}`)
      }
      monthsWritten++

      // Progress every 3 months keeps the UI feedback lively without
      // hammering the DB.
      if ((i + 1) % 3 === 0) {
        await markProgress(db, integrationId, {
          phase:               'writing',
          months_total:        monthsTotal,
          months_done:         i + 1,
          months_written:      monthsWritten,
          months_skipped_pdf:  monthsSkippedPdf,
        })
      }
    }

    // ── 5. Mark completed ─────────────────────────────────────────────────
    await db
      .from('integrations')
      .update({
        backfill_status:      'completed',
        backfill_finished_at: new Date().toISOString(),
        backfill_progress: {
          phase:               'completed',
          months_total:        monthsTotal,
          months_written:      monthsWritten,
          months_skipped_pdf:  monthsSkippedPdf,
          voucher_count:       fetchResult.vouchers.length,
          duration_ms:         Date.now() - startedAt,
        },
        last_sync_at:         new Date().toISOString(),
        last_error:           null,
        status:               'connected',
      })
      .eq('id', integrationId)

    log.info('fortnox-backfill complete', {
      route:               'cron/fortnox-backfill-worker',
      integration_id:      integrationId,
      months_written:      monthsWritten,
      months_skipped_pdf:  monthsSkippedPdf,
      voucher_count:       fetchResult.vouchers.length,
      duration_ms:         Date.now() - startedAt,
      status:              'success',
    })

    // Re-fire ourselves in case more pending integrations are queued (the
    // typical case is one customer at a time, but a burst of OAuth connects
    // would otherwise drain at cron-tick speed).
    waitUntil(triggerNext())

    return NextResponse.json({
      ok:                  true,
      integration_id:      integrationId,
      months_written:      monthsWritten,
      months_skipped_pdf:  monthsSkippedPdf,
      voucher_count:       fetchResult.vouchers.length,
      duration_ms:         Date.now() - startedAt,
    })
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 1000)
    await db
      .from('integrations')
      .update({
        backfill_status:      'failed',
        backfill_finished_at: new Date().toISOString(),
        backfill_error:       msg,
        backfill_progress: {
          phase:        'failed',
          duration_ms:  Date.now() - startedAt,
          message:      msg,
        },
        status:               'error',
        last_error:           `Backfill failed: ${msg}`,
      })
      .eq('id', integrationId)

    log.error('fortnox-backfill failed', {
      route:          'cron/fortnox-backfill-worker',
      integration_id: integrationId,
      duration_ms:    Date.now() - startedAt,
      error:          msg,
      status:         'error',
    })

    return NextResponse.json({ ok: false, integration_id: integrationId, error: msg }, { status: 500 })
  }
}

// Allow GET so the Vercel cron can hit it (Vercel cron uses GET by default
// for some configurations); both methods do the same work.
export async function GET(req: NextRequest) {
  return POST(req)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function markProgress(db: any, id: string, progress: Record<string, any>) {
  try {
    await db
      .from('integrations')
      .update({ backfill_progress: progress })
      .eq('id', id)
  } catch (e: any) {
    // Progress writes are best-effort. Don't fail the whole backfill on one.
    log.warn('fortnox-backfill progress write failed', {
      integration_id: id, error: String(e?.message ?? e),
    })
  }
}

async function triggerNext(): Promise<void> {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  if (!base) return
  await fetch(`${base}/api/cron/fortnox-backfill-worker`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
    },
    body: JSON.stringify({ trigger: 'chain' }),
  }).catch(() => {})
}
