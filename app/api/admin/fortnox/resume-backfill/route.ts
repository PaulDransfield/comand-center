// app/api/admin/fortnox/resume-backfill/route.ts
//
// Admin "resume" — pairs with kick-backfill. Flips a stuck 'running' row
// (or a 'paused' row that the daily cron hasn't picked up yet) back to
// 'paused' status WITHOUT clearing the fortnox_backfill_state row, then
// fires a worker via waitUntil. The worker's claim logic then sees the
// state row, skips Phase 1 (summaries already populated), and resumes
// from the cursor.
//
// Difference from kick-backfill:
//   kick-backfill   = fresh start. Clears state row. Re-fetches all summaries.
//                     Use when admin wants to redo the backfill from scratch.
//   resume-backfill = continue. Preserves state row. Resumes from cursor.
//                     Use when a previous run timed out without checkpointing
//                     (worker killed mid-iteration by Vercel) or when a
//                     paused row needs an immediate retrigger.
//
// Inputs: { business_id }

import { NextRequest, NextResponse }   from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { waitUntil }                   from '@vercel/functions'
import { requireAdmin }                from '@/lib/admin/require-admin'
import { createAdminClient }           from '@/lib/supabase/server'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  noStore()

  const body = await req.json().catch(() => ({} as any))
  const businessId: string | undefined = body?.business_id
  if (!businessId) {
    return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  }

  const db = createAdminClient()

  const { data: integ } = await db
    .from('integrations')
    .select('id, org_id, business_id, backfill_status')
    .eq('business_id', businessId)
    .eq('provider', 'fortnox')
    .maybeSingle()

  if (!integ) {
    return NextResponse.json({ error: 'No Fortnox integration found for that business' }, { status: 404 })
  }

  const guard = await requireAdmin(req, { orgId: integ.org_id, businessId })
  if (!('ok' in guard)) return guard

  // Verify a state row exists — without it, "resume" has nothing to resume.
  const { data: state } = await db
    .from('fortnox_backfill_state')
    .select('integration_id, cursor, total_vouchers, written_periods')
    .eq('integration_id', integ.id)
    .maybeSingle()

  if (!state) {
    return NextResponse.json({
      error:   'no_state_row',
      message: 'No fortnox_backfill_state row exists for this integration. Use Kick worker (fresh start) instead.',
    }, { status: 404 })
  }

  // Flip status to 'paused' so the worker's atomic claim picks it up.
  // 'paused' is the agreed status for "has state, ready to resume".
  // Don't clear the state row — that's the whole point.
  const { error: updErr } = await db
    .from('integrations')
    .update({
      backfill_status:    'paused',
      backfill_finished_at: null,
      backfill_error:     null,
      backfill_progress:  {
        phase:                  'enqueued_resume',
        triggered_by:           'admin_resume',
        cursor:                 state.cursor,
        total_vouchers:         state.total_vouchers,
        months_written_total:   Array.isArray(state.written_periods) ? state.written_periods.length : 0,
      },
    })
    .eq('id', integ.id)

  if (updErr) {
    return NextResponse.json({ error: `Failed to enqueue resume: ${updErr.message}` }, { status: 500 })
  }

  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)

  if (!base || !process.env.CRON_SECRET) {
    return NextResponse.json({
      error: 'Server misconfigured: NEXT_PUBLIC_APP_URL or CRON_SECRET missing',
    }, { status: 500 })
  }

  waitUntil(
    fetch(`${base}/api/cron/fortnox-backfill-worker`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.CRON_SECRET}`,
      },
      body: JSON.stringify({ trigger: 'admin_resume', business_id: businessId }),
    }).catch(() => {}),
  )

  return NextResponse.json({
    ok:                   true,
    integration_id:       integ.id,
    business_id:          businessId,
    cursor:               state.cursor,
    total_vouchers:       state.total_vouchers,
    months_written_total: Array.isArray(state.written_periods) ? state.written_periods.length : 0,
    status:               'enqueued_resume',
    message:              'Worker chained — should pick up from cursor in a few seconds. Watch the integrations row.',
  })
}
