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
import {
  fetchVoucherSummariesForRange,
  fetchVoucherDetailsForSummaries,
  type FortnoxVoucherSummaryWithContext,
  type FortnoxVoucher,
} from '@/lib/fortnox/api/vouchers'
import { translateVouchersToPeriods }    from '@/lib/fortnox/api/voucher-to-aggregator'
import { projectRollup }                 from '@/lib/finance/projectRollup'
import { validateApiBackfillBatch }      from '@/lib/fortnox/api/validate-backfill'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
// 12 months of vouchers + per-voucher detail can take 5-15 minutes for a
// busy restaurant under Fortnox's rate limit (real-world ~18 req/5sec
// before 429s). Vercel Pro allows up to 800s on Fluid Compute; we cap at
// 600s to leave headroom. v1 doesn't implement resumption — if a single
// restaurant exceeds 600s the row is left in 'running' and the cron's
// daily backstop will re-claim it once we add resume logic. For Vero's
// voucher volume (~30/day) the full 12-month fetch is well under 10min.
export const maxDuration = 600

const PROVIDER       = 'fortnox'
const DEFAULT_MONTHS = 12
// months=0 is the sentinel for "all available history" — the fetcher
// receives an effectively unbounded fromDate and clampRangeToFiscalYears
// limits the actual range to whatever the customer's /financialyears
// returns. Cleaner than guessing "is this customer 6mo old or 5yr old?"
const MIN_MONTHS     = 0
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
  // Find one row in pending OR paused status. 'paused' rows are partially-
  // processed backfills with a state row that needs resuming. The same
  // atomic-CAS-via-eq pattern means contended workers no-op cleanly.
  const { data: pending } = await db
    .from('integrations')
    .select('id, org_id, business_id, backfill_status')
    .in('backfill_status', ['pending', 'paused'])
    .eq('provider', PROVIDER)
    .limit(1)
    .maybeSingle()

  if (!pending) {
    return NextResponse.json({ ok: true, empty: true })
  }

  const previousStatus = pending.backfill_status as 'pending' | 'paused'
  const { data: claimed, error: claimErr } = await db
    .from('integrations')
    .update({
      backfill_status:     'running',
      backfill_started_at: previousStatus === 'pending' ? new Date().toISOString() : undefined,  // preserve original start on resume
      backfill_progress:   { phase: previousStatus === 'paused' ? 'resuming' : 'claimed' },
      backfill_error:      null,
    })
    .eq('id', pending.id)
    .eq('backfill_status', previousStatus)   // atomic gate
    .select('id, org_id, business_id')
    .maybeSingle()

  if (claimErr || !claimed) {
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
    // ── Resumable design (M060) ────────────────────────────────────────
    // Worker leaves 60s headroom before maxDuration; if the time budget
    // runs out mid-detail-loop, we persist {cursor, written_periods} to
    // fortnox_backfill_state, set integrations.backfill_status='paused',
    // and chain another worker invocation via waitUntil. The next claim
    // sees the paused row, skips Phase 1 (summaries are already in state),
    // and resumes from the cursor.
    const TIME_BUDGET_MS = (maxDuration - 60) * 1000  // leave 60s for cleanup
    const deadline       = startedAt + TIME_BUDGET_MS

    // Try to load existing state row (resume case).
    const { data: existingState } = await db
      .from('fortnox_backfill_state')
      .select('*')
      .eq('integration_id', integrationId)
      .maybeSingle()

    let summaries:      FortnoxVoucherSummaryWithContext[]
    const writtenPeriods = new Set<string>()
    let cursor:         number
    let fromIso:        string
    let toIso:          string
    let resumeCount:    number

    if (existingState && Array.isArray(existingState.voucher_queue) && existingState.voucher_queue.length > 0) {
      // ── Resume mode ────────────────────────────────────────────────
      summaries     = existingState.voucher_queue
      cursor        = Number(existingState.cursor ?? 0)
      fromIso       = existingState.from_date  ?? '1990-01-01'
      toIso         = existingState.to_date    ?? new Date().toISOString().slice(0, 10)
      resumeCount   = Number(existingState.resume_count ?? 0)
      for (const k of (existingState.written_periods ?? []) as string[]) writtenPeriods.add(k)

      log.info('fortnox-backfill resuming', {
        route:           'cron/fortnox-backfill-worker',
        integration_id:  integrationId,
        cursor,
        total_vouchers:  summaries.length,
        months_written:  writtenPeriods.size,
        resume_count:    resumeCount,
      })
    } else {
      // ── Fresh start ────────────────────────────────────────────────
      const toDate = new Date()
      if (MONTHS === 0) {
        fromIso = '1990-01-01'
      } else {
        const fromDate = new Date(toDate)
        fromDate.setUTCMonth(fromDate.getUTCMonth() - MONTHS)
        fromIso = fromDate.toISOString().slice(0, 10)
      }
      toIso       = toDate.toISOString().slice(0, 10)
      resumeCount = 0

      await markProgress(db, integrationId, {
        phase:            'listing',
        from_date:        fromIso,
        to_date:          toIso,
        months_requested: MONTHS === 0 ? 'all_available' : MONTHS,
      })

      // Phase 1: fetch summaries only. Single round-trip — fast.
      const sumResult = await fetchVoucherSummariesForRange({
        db,
        orgId,
        businessId: businessId ?? undefined,
        fromDate:   fromIso,
        toDate:     toIso,
      })
      summaries = sumResult.summaries
      // Sort by TransactionDate ascending so periods are processed in order.
      // The per-period flush logic relies on knowing when a period is fully
      // fetched; sorting by date guarantees we never see a summary from an
      // earlier period after we've started processing a later one.
      summaries.sort((a, b) => (a.TransactionDate ?? '').localeCompare(b.TransactionDate ?? ''))
      cursor = 0

      log.info('fortnox-backfill listed', {
        route:           'cron/fortnox-backfill-worker',
        integration_id:  integrationId,
        voucher_total:   summaries.length,
        list_requests:   sumResult.listRequests,
        duration_ms:     sumResult.durationMs,
      })

      // Persist state row so a future timeout can resume from this point.
      const { error: stateErr } = await db
        .from('fortnox_backfill_state')
        .upsert({
          integration_id:  integrationId,
          org_id:          orgId,
          business_id:     businessId,
          voucher_queue:   summaries,
          total_vouchers:  summaries.length,
          cursor:          0,
          written_periods: [],
          from_date:       fromIso,
          to_date:         toIso,
        }, { onConflict: 'integration_id' })
      if (stateErr) throw new Error(`state init: ${stateErr.message}`)
    }

    // Pre-load context once per worker invocation (used for validators)
    const [{ data: bizRow }, { data: orgRow }] = await Promise.all([
      db.from('businesses').select('name, org_number').eq('id', businessId).maybeSingle(),
      db.from('organisations').select('name, org_number').eq('id', orgId).maybeSingle(),
    ])

    // History from tracker_data BEFORE we write anything in THIS run. Note
    // that on resumes, this picks up rows already written by earlier runs —
    // that's actually FINE because those rows are correct API data anyway.
    const minSummaryYear = summaries.length > 0
      ? Number(summaries[0].TransactionDate?.slice(0, 4) ?? new Date().getUTCFullYear()) - 1
      : new Date().getUTCFullYear() - 1
    const { data: historyRows } = await db
      .from('tracker_data')
      .select('period_year, period_month, revenue, staff_cost, food_cost')
      .eq('business_id', businessId)
      .gte('period_year', minSummaryYear)
      .order('period_year', { ascending: true })
      .order('period_month', { ascending: true })
      .limit(36)
    const history = (historyRows ?? []).map(h => ({
      year:       Number(h.period_year),
      month:      Number(h.period_month),
      revenue:    Number(h.revenue ?? 0),
      staff_cost: Number(h.staff_cost ?? 0),
      food_cost:  Number(h.food_cost ?? 0),
    }))

    // Compute remaining-summaries-per-period from cursor onwards. As we fetch
    // each detail and decrement, we know when a period is fully fetched and
    // ready to flush.
    const remainingByPeriod = new Map<string, number>()
    for (let i = cursor; i < summaries.length; i++) {
      const s = summaries[i]
      const yyyymm = (s.TransactionDate ?? '').slice(0, 7)  // YYYY-MM
      if (!yyyymm) continue
      if (writtenPeriods.has(yyyymm)) continue
      remainingByPeriod.set(yyyymm, (remainingByPeriod.get(yyyymm) ?? 0) + 1)
    }

    let monthsWrittenThisRun     = 0
    let monthsOverwrittenPdfThis = 0
    let monthsSkippedValidation  = 0
    const validationFailures: Array<{ period: string; codes: string[] }> = []
    let detailRequestsThisRun    = 0

    // ── Per-period detail loop with deadline-aware checkpointing ─────────
    // Each iteration fetches ALL of one period's vouchers in a single
    // fetchVoucherDetailsForSummaries call. That call shares its throttle +
    // token state across the period's vouchers, sustaining 3.6 req/sec
    // (the throttle ceiling) instead of the ~1.5 req/sec we got with
    // one-call-per-voucher (where each call paid integration-load + token-
    // check overhead). Period boundaries are also natural checkpoint
    // points: we only persist cursor after a clean per-period flush, so
    // resumes never have to reconcile partial-period writes.
    const checkpointAndPause = async (cursorAtPause: number) => {
      await db.from('fortnox_backfill_state').update({
        cursor:           cursorAtPause,
        written_periods:  Array.from(writtenPeriods),
        last_progress_at: new Date().toISOString(),
        resume_count:     resumeCount + 1,
      }).eq('integration_id', integrationId)

      await db.from('integrations').update({
        backfill_status: 'paused',
        backfill_progress: {
          phase:                    'paused',
          cursor:                   cursorAtPause,
          total_vouchers:           summaries.length,
          months_written_total:     writtenPeriods.size,
          months_written_this_run:  monthsWrittenThisRun,
          detail_requests_this_run: detailRequestsThisRun,
          duration_ms_this_run:     Date.now() - startedAt,
          resume_count:             resumeCount + 1,
        },
      }).eq('id', integrationId)

      log.info('fortnox-backfill paused', {
        route:                    'cron/fortnox-backfill-worker',
        integration_id:           integrationId,
        cursor:                   cursorAtPause,
        total_vouchers:           summaries.length,
        months_written_total:     writtenPeriods.size,
        months_written_this_run:  monthsWrittenThisRun,
        duration_ms_this_run:     Date.now() - startedAt,
        resume_count:             resumeCount + 1,
      })

      waitUntil(triggerNext())
    }

    while (cursor < summaries.length) {
      if (Date.now() > deadline) {
        await checkpointAndPause(cursor)
        return NextResponse.json({
          ok:                      true,
          integration_id:          integrationId,
          status:                  'paused',
          cursor,
          total_vouchers:          summaries.length,
          months_written_total:    writtenPeriods.size,
          months_written_this_run: monthsWrittenThisRun,
        })
      }

      const periodStartCursor = cursor
      const startSummary      = summaries[periodStartCursor]
      const yyyymm            = (startSummary.TransactionDate ?? '').slice(0, 7)
      if (!yyyymm) { cursor++; continue }

      // Skip already-written periods (resume after a prior run that wrote some)
      if (writtenPeriods.has(yyyymm)) {
        cursor++
        continue
      }

      // Find the end-cursor for THIS period (summaries is sorted by date asc)
      let periodEndCursor = periodStartCursor
      while (
        periodEndCursor < summaries.length &&
        (summaries[periodEndCursor].TransactionDate ?? '').slice(0, 7) === yyyymm
      ) {
        periodEndCursor++
      }
      const periodSummaries = summaries.slice(periodStartCursor, periodEndCursor)

      // Fetch ALL of this period's details in one batch call. The deadline
      // pushes early-exit DOWN into the fetcher so we don't waste time on
      // doomed fetches near timeout.
      const detailBatch = await fetchVoucherDetailsForSummaries({
        db,
        orgId,
        businessId: businessId ?? undefined,
        summaries:  periodSummaries,
        deadlineMs: deadline,
        progressEvery: 25,
        onProgress: async (state) => {
          // Live UI feedback while fetching a long period's details
          await markProgress(db, integrationId, {
            phase:                'fetching',
            cursor:               periodStartCursor + state.vouchersFetched,
            total_vouchers:       summaries.length,
            months_written_total: writtenPeriods.size,
            current_period:       yyyymm,
            from_date:            fromIso,
            to_date:              toIso,
          })
        },
      })
      detailRequestsThisRun += detailBatch.detailRequests

      if (detailBatch.aborted) {
        // Got partial period — discard the partial vouchers and checkpoint.
        // cursor stays at periodStartCursor so the next resume re-fetches
        // this period from scratch. Cost: re-fetch up to one period's
        // worth of vouchers (~330 for Vero); avoids any partial-period
        // tracker_data write.
        await checkpointAndPause(periodStartCursor)
        return NextResponse.json({
          ok:                      true,
          integration_id:          integrationId,
          status:                  'paused',
          cursor:                  periodStartCursor,
          total_vouchers:          summaries.length,
          months_written_total:    writtenPeriods.size,
          months_written_this_run: monthsWrittenThisRun,
        })
      }

      // Translate, validate, write the period.
      const translated   = translateVouchersToPeriods(detailBatch.vouchers)
      const periodOutput = translated.periods.find(
        p => `${p.year}-${String(p.month).padStart(2, '0')}` === yyyymm,
      )

      if (periodOutput) {
        const projected = projectRollup(periodOutput.rollup, periodOutput.lines)

        const valBatch = validateApiBackfillBatch(
          [{ period: periodOutput, projected }],
          {
            org:             { name: orgRow?.name ?? null, org_number: orgRow?.org_number ?? null },
            business:        { name: bizRow?.name ?? null, org_number: bizRow?.org_number ?? null },
            history,
            existingPeriods: writtenPeriods,
          },
        )
        const valResult = valBatch.results[0]

        if (!valResult.ok) {
          monthsSkippedValidation++
          validationFailures.push({
            period: yyyymm,
            codes:  valResult.findings.filter(f => f.severity === 'error').map(f => f.code),
          })
        } else {
          const { data: existing } = await db
            .from('tracker_data')
            .select('id, source')
            .eq('business_id', businessId)
            .eq('period_year', periodOutput.year)
            .eq('period_month', periodOutput.month)
            .maybeSingle()

          const payload: Record<string, any> = {
            org_id:           orgId,
            business_id:      businessId,
            period_year:      periodOutput.year,
            period_month:     periodOutput.month,
            revenue:          projected.revenue,
            dine_in_revenue:  projected.dine_in_revenue,
            takeaway_revenue: projected.takeaway_revenue,
            alcohol_revenue:  projected.alcohol_revenue,
            food_cost:        projected.food_cost,
            alcohol_cost:     projected.alcohol_cost,
            staff_cost:       projected.staff_cost,
            other_cost:       projected.other_cost,
            total_cost:       projected.food_cost + projected.staff_cost + projected.other_cost + projected.depreciation,
            net_profit:       projected.net_profit,
            margin_pct:       projected.margin_pct,
            source:           'fortnox_api',
            created_via:      'fortnox_backfill',
            updated_at:       new Date().toISOString(),
          }

          if (existing) {
            if (existing.source === 'fortnox_pdf' || existing.source === 'fortnox_apply') {
              monthsOverwrittenPdfThis++
              log.info('fortnox-backfill overwriting pdf', {
                route:           'cron/fortnox-backfill-worker',
                integration_id:  integrationId,
                period:          yyyymm,
                previous_source: existing.source,
              })
            }
            const { error } = await db.from('tracker_data').update(payload).eq('id', existing.id)
            if (error) throw new Error(`update ${yyyymm}: ${error.message}`)
          } else {
            const { error } = await db.from('tracker_data').insert(payload)
            if (error) throw new Error(`insert ${yyyymm}: ${error.message}`)
          }
          monthsWrittenThisRun++
        }
      }

      writtenPeriods.add(yyyymm)
      cursor = periodEndCursor

      // Persist state after every period flush so a crash mid-run doesn't
      // lose progress on already-written tracker_data rows.
      await db.from('fortnox_backfill_state').update({
        cursor,
        written_periods:  Array.from(writtenPeriods),
        last_progress_at: new Date().toISOString(),
      }).eq('integration_id', integrationId)
    }

    // ── All done. Mark completed + delete state row ─────────────────
    await db
      .from('integrations')
      .update({
        backfill_status:      'completed',
        backfill_finished_at: new Date().toISOString(),
        backfill_progress: {
          phase:                     'completed',
          total_vouchers:            summaries.length,
          months_written_total:      writtenPeriods.size,
          months_written_this_run:   monthsWrittenThisRun,
          months_overwritten_pdf:    monthsOverwrittenPdfThis,
          months_skipped_validation: monthsSkippedValidation,
          validation_failures:       validationFailures,
          duration_ms_this_run:      Date.now() - startedAt,
          resume_count:              resumeCount,
        },
        last_sync_at:         new Date().toISOString(),
        last_error:           null,
        status:               'connected',
      })
      .eq('id', integrationId)

    await db.from('fortnox_backfill_state').delete().eq('integration_id', integrationId)

    log.info('fortnox-backfill complete', {
      route:                     'cron/fortnox-backfill-worker',
      integration_id:            integrationId,
      months_written_total:      writtenPeriods.size,
      months_written_this_run:   monthsWrittenThisRun,
      months_overwritten_pdf:    monthsOverwrittenPdfThis,
      months_skipped_validation: monthsSkippedValidation,
      total_vouchers:            summaries.length,
      duration_ms_this_run:      Date.now() - startedAt,
      resume_count:              resumeCount,
      status:                    'success',
    })

    // Re-fire ourselves in case more pending integrations are queued.
    waitUntil(triggerNext())

    return NextResponse.json({
      ok:                        true,
      integration_id:            integrationId,
      months_written_total:      writtenPeriods.size,
      months_written_this_run:   monthsWrittenThisRun,
      months_overwritten_pdf:    monthsOverwrittenPdfThis,
      months_skipped_validation: monthsSkippedValidation,
      validation_failures:       validationFailures,
      total_vouchers:            summaries.length,
      duration_ms_this_run:      Date.now() - startedAt,
      resume_count:              resumeCount,
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
