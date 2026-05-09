// app/api/integrations/fortnox/run-backfill/route.ts
//
// Owner-facing button at /integrations triggers the 12-month Fortnox API
// backfill on demand instead of waiting for the daily 07:00 UTC cron tick.
//
// Flow:
//   1. Authenticate the caller via Supabase session.
//   2. Verify the caller's org owns the named integration row.
//   3. Set integrations.backfill_status='pending' for that row.
//   4. Fire the worker (/api/cron/fortnox-backfill-worker) via authenticated
//      HTTP POST so the customer doesn't wait for the next cron tick.
//   5. Return immediately with status; the UI polls integrations row to show
//      progress.
//
// Idempotency: re-running while a backfill is already 'running' is safe —
// the worker re-claims via WHERE backfill_status='pending', and the second
// claim no-ops if the first is still in flight. We don't transition rows
// from 'running' back to 'pending' here; that would risk two workers writing
// concurrently. If a customer wants to re-backfill after one completes,
// they can retrigger and it will overwrite our own prior fortnox_api rows
// (PDF-apply rows are protected by the worker's idempotency check).

import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({} as any))
  const businessId: string | null = body?.business_id ?? null

  const db = createAdminClient()

  // Find the integration. Scope by org_id (from session) and provider; if
  // business_id is supplied, filter to that specific row, otherwise pick
  // the first non-disconnected Fortnox row in the org.
  //
  // Accept status IN ('connected', 'error', 'warning') — the credentials
  // are fine in any of those states, only 'disconnected' / 'not_connected'
  // means we have nothing to retry. A backfill that failed at the Fortnox
  // API layer flips the row to status='error' but the OAuth tokens are
  // still valid, so the retry path needs to work without reconnecting.
  let q = db
    .from('integrations')
    .select('id, business_id, backfill_status')
    .eq('org_id',   auth.orgId)
    .eq('provider', 'fortnox')
    .in('status',   ['connected', 'error', 'warning'])

  if (businessId) q = q.eq('business_id', businessId)

  const { data: integ, error: fetchErr } = await q.limit(1).maybeSingle()
  if (fetchErr) {
    return NextResponse.json({ error: `Failed to find Fortnox integration: ${fetchErr.message}` }, { status: 500 })
  }
  if (!integ) {
    return NextResponse.json({ error: 'No connected Fortnox integration for this org' }, { status: 404 })
  }

  // If the worker is currently running, don't disturb it — just acknowledge
  // and let the customer poll. Re-triggering 'pending' over 'running' would
  // risk a concurrent claim if the running worker crashes mid-flight before
  // we add a stale-running sweeper.
  if (integ.backfill_status === 'running') {
    return NextResponse.json({
      ok:      true,
      already_running: true,
      integration_id: integ.id,
      message: 'Backfill is already running — wait for it to finish before re-triggering.',
    })
  }

  // Flip to pending. The atomic gate is the WHERE id=... + the worker's
  // own atomic claim (UPDATE ... WHERE backfill_status='pending'); two
  // concurrent button clicks both produce 'pending' but only one worker
  // claims it.
  const { error: updErr } = await db
    .from('integrations')
    .update({
      backfill_status:   'pending',
      backfill_progress: { phase: 'enqueued', triggered_by: 'owner_button' },
      backfill_error:    null,
    })
    .eq('id', integ.id)

  if (updErr) {
    return NextResponse.json({ error: `Failed to enqueue backfill: ${updErr.message}` }, { status: 500 })
  }

  // Fire the worker once so the customer doesn't wait for the cron.
  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  if (base && process.env.CRON_SECRET) {
    fetch(`${base}/api/cron/fortnox-backfill-worker`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.CRON_SECRET}`,
      },
      body: JSON.stringify({ trigger: 'owner_button' }),
    }).catch(() => {})  // fire-and-forget; worker will also be picked up by daily cron
  }

  return NextResponse.json({
    ok:             true,
    integration_id: integ.id,
    business_id:    integ.business_id,
    status:         'pending',
    message:        'Backfill enqueued. Watch the Fortnox card for progress.',
  })
}
