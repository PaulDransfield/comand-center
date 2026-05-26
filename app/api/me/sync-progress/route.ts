// app/api/me/sync-progress/route.ts
//
// Unified, owner-facing progress feed for the two background pipelines that
// fire when a business connects / re-auths Fortnox:
//
//   1. Financial history backfill — 12 months of vouchers → tracker_data P&L.
//      State lives on the integrations row (backfill_status / backfill_progress
//      / backfill_started_at / backfill_finished_at), written by
//      /api/cron/fortnox-backfill-worker.
//   2. Invoice scanner backfill ("the scrapper") — supplier invoices → line
//      extraction → product matching. State lives in inventory_backfill_state
//      (status / progress / started_at / finished_at), written by
//      lib/inventory/backfill-worker.ts.
//
// This endpoint normalises both into a single shape the SyncProgressBanner
// polls every few seconds. We compute percent + a naive linear ETA here so
// the client stays dumb. The banner shows nothing once both pipelines are
// idle (and stops polling), so this is cheap.
//
// GET /api/me/sync-progress?business_id=X
//   → { business_id, active, jobs: SyncJob[] }

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

type JobState = 'queued' | 'running' | 'done' | 'failed'

interface SyncJob {
  key:        'financials' | 'invoices'
  label:      string
  state:      JobState
  phaseLabel: string
  percent:    number | null   // 0-100
  etaSeconds: number | null
  detail:     string | null
  finishedAt: string | null
  error:      string | null
}

// Naive linear extrapolation: if we're `percent` done after `elapsed`, the
// whole job takes elapsed / (percent/100) and the remainder is the ETA.
// Fortnox is rate-limited so throughput is roughly constant — good enough
// for a "~2 min left" hint, which is all the owner needs.
function estimateEtaSeconds(startedAtIso: string | null, percent: number | null): number | null {
  if (!startedAtIso || percent == null || percent <= 0 || percent >= 100) return null
  const started = new Date(startedAtIso).getTime()
  if (!Number.isFinite(started)) return null
  const elapsed = Date.now() - started
  if (elapsed <= 0) return null
  const total     = elapsed / (percent / 100)
  const remaining = total - elapsed
  if (!Number.isFinite(remaining) || remaining < 0) return null
  return Math.round(remaining / 1000)
}

export async function GET(req: NextRequest) {
  noStore()

  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const businessId = (new URL(req.url).searchParams.get('business_id') ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  const [{ data: integ }, { data: invState }] = await Promise.all([
    db.from('integrations')
      .select('backfill_status, backfill_progress, backfill_started_at, backfill_finished_at, backfill_error')
      .eq('org_id', auth.orgId)
      .eq('provider', 'fortnox')
      .eq('business_id', businessId)
      .maybeSingle(),
    db.from('inventory_backfill_state')
      .select('status, progress, started_at, finished_at, updated_at, error_message')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .maybeSingle(),
  ])

  const jobs: SyncJob[] = []

  // ── Job 1: financial history backfill ───────────────────────────────
  if (integ?.backfill_status) {
    jobs.push(buildFinancialsJob(integ))
  }

  // ── Job 2: invoice scanner backfill ─────────────────────────────────
  if (invState?.status) {
    jobs.push(buildInvoicesJob(invState))
  }

  const active = jobs.some(j => j.state === 'queued' || j.state === 'running')

  return NextResponse.json({ business_id: businessId, active, jobs }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}

function buildFinancialsJob(integ: any): SyncJob {
  const status   = String(integ.backfill_status)
  const progress = (integ.backfill_progress ?? {}) as Record<string, any>
  const phase    = String(progress.phase ?? status)

  // Same staleness guard as the invoices job: a 'running' backfill with no
  // finish and an old start is dead — don't show it as perpetually syncing.
  const finStale = !integ.backfill_finished_at && integ.backfill_started_at &&
    (Date.now() - new Date(integ.backfill_started_at).getTime()) > 30 * 60 * 1000

  const state: JobState =
    status === 'completed' ? 'done'
    : status === 'failed'  ? 'failed'
    : finStale             ? 'done'   // dead run — hide it
    : status === 'pending' ? 'queued'
    : 'running'   // running | paused | anything mid-flight

  const total  = Number(progress.total_vouchers ?? 0)
  const cursor = Number(progress.cursor ?? 0)

  let percent: number | null = null
  if (state === 'done')        percent = 100
  else if (state === 'failed') percent = null
  else if (total > 0)          percent = Math.min(99, Math.round((cursor / total) * 100))
  else if (phase === 'listing' || phase === 'claimed' || phase === 'resuming') percent = 4
  else if (phase === 'enqueued') percent = 2

  let phaseLabel = 'Working'
  switch (phase) {
    case 'enqueued':  phaseLabel = 'Queued';                break
    case 'claimed':   phaseLabel = 'Starting';              break
    case 'listing':   phaseLabel = 'Finding transactions';  break
    case 'fetching':  phaseLabel = 'Reading transactions';  break
    case 'resuming':  phaseLabel = 'Resuming';              break
    case 'paused':    phaseLabel = 'Reading transactions';  break
    case 'completed': phaseLabel = 'Complete';              break
    case 'failed':    phaseLabel = 'Failed';                break
  }

  const monthsWritten = Number(progress.months_written_total ?? 0)
  let detail: string | null = null
  if (state === 'done') {
    detail = monthsWritten > 0 ? `${monthsWritten} months imported` : 'History imported'
  } else if (state === 'running') {
    if (total > 0)        detail = `${cursor.toLocaleString()} of ${total.toLocaleString()} transactions`
    else if (monthsWritten) detail = `${monthsWritten} months imported`
    else if (progress.current_period) detail = `Processing ${progress.current_period}`
  }

  return {
    key:        'financials',
    label:      'Financial history',
    state,
    phaseLabel,
    percent,
    etaSeconds: estimateEtaSeconds(integ.backfill_started_at ?? null, percent),
    detail,
    finishedAt: integ.backfill_finished_at ?? null,
    error:      state === 'failed' ? (integ.backfill_error ?? 'Backfill failed') : null,
  }
}

// inventory_backfill_state is updated only at run boundaries (start +
// completion), not continuously — so a row not touched in 15 min is between
// sweep kicks or from a dead worker, NOT actively syncing. Treat stale rows
// as done so the banner never shows perpetual "syncing" on an idle/onboarded
// customer (the Chicce-stale-'running' bug). The next real kick updates the
// row and the banner re-shows genuine activity.
const INV_STALE_MS = 15 * 60 * 1000

function buildInvoicesJob(invState: any): SyncJob {
  const status   = String(invState.status)
  const progress = (invState.progress ?? {}) as Record<string, any>
  const phase    = String(progress.phase ?? status)
  const ageMs    = invState.updated_at ? Date.now() - new Date(invState.updated_at).getTime() : Infinity
  const stale    = ageMs > INV_STALE_MS

  const state: JobState =
    status === 'failed'    ? 'failed'
    : status === 'completed' || status === 'success' ? 'done'   // both are terminal
    : stale                ? 'done'   // dead/idle worker — don't show "syncing"
    : status === 'pending' ? 'queued'
    : 'running'

  const found     = Number(progress.invoices_found ?? 0)
  const processed = Number(progress.invoices_processed ?? 0)

  let percent: number | null = null
  if (state === 'done')        percent = 100
  else if (state === 'failed') percent = null
  else if (found > 0)          percent = Math.min(99, Math.round((processed / found) * 100))
  else if (phase === 'fetching_invoice_list') percent = 4
  else if (phase === 'enqueued') percent = 2

  let phaseLabel = 'Working'
  switch (phase) {
    case 'enqueued':              phaseLabel = 'Queued';            break
    case 'fetching_invoice_list': phaseLabel = 'Finding invoices';  break
    case 'fetching_rows':         phaseLabel = 'Reading invoices';  break
    case 'matching':              phaseLabel = 'Matching products'; break
    case 'done':                  phaseLabel = 'Complete';          break
  }

  const needsReview = Number(progress.lines_needs_review ?? 0)
  let detail: string | null = null
  if (state === 'done') {
    detail = needsReview > 0
      ? `${needsReview} items need review`
      : (found > 0 ? `${found} invoices scanned` : 'Invoices scanned')
  } else if (state === 'running') {
    if (found > 0) detail = `${processed} of ${found} invoices`
  }

  return {
    key:        'invoices',
    label:      'Invoice scanner',
    state,
    phaseLabel,
    percent,
    etaSeconds: estimateEtaSeconds(invState.started_at ?? null, percent),
    detail,
    finishedAt: invState.finished_at ?? null,
    error:      state === 'failed' ? (invState.error_message ?? 'Scan failed') : null,
  }
}
