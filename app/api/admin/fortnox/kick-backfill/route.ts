// app/api/admin/fortnox/kick-backfill/route.ts
//
// Admin one-click "kick Fortnox backfill" endpoint. Bypasses the
// owner-side run-backfill button's gates and the fire-and-forget
// trigger reliability issues — admin presents ADMIN_SECRET, we reset
// the integration row to backfill_status='pending', then fire the
// worker via `waitUntil()` and return IMMEDIATELY.
//
// Why not await the worker?
//   The worker can take 5-15 min for a busy restaurant. Vercel's edge
//   proxy times out long before that (~60-120s typical), returning HTTP
//   504 to the admin even though the worker is actually still running
//   in the background. Synchronous "wait for completion" is the wrong
//   shape — admins watch progress via the SQL query / integrations
//   table while the worker grinds in the background.
//
// Use cases:
//   - Owner-side button stuck (fire-and-forget POST didn't reach worker)
//   - Worker crashed mid-flight, row stuck at 'running'
//   - Need to re-run after a code fix without waiting for daily cron
//
// Inputs (POST JSON body):
//   - business_id: required. Identifies which Fortnox integration to kick.
//
// Returns the worker's response verbatim so the admin sees:
//   - success → months_written / months_skipped_pdf / voucher_count / duration_ms
//   - failure → error message including the new fiscal-year context

import { NextRequest, NextResponse }   from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { waitUntil }                   from '@vercel/functions'
import { requireAdmin }                from '@/lib/admin/require-admin'
import { createAdminClient }           from '@/lib/supabase/server'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
// We return immediately — worker runs in background via waitUntil. No need
// for a long timeout on this endpoint.
export const maxDuration = 30

export async function POST(req: NextRequest) {
  noStore()

  const body = await req.json().catch(() => ({} as any))
  const businessId: string | undefined = body?.business_id
  const months: number | undefined = Number.isFinite(Number(body?.months)) ? Number(body.months) : undefined

  if (!businessId) {
    return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  }

  // Look up the integration's org so requireAdmin can verify (admin secret +
  // org/business existence). We do an admin lookup first because the admin
  // doesn't necessarily know the org_id — they have the business_id.
  const db = createAdminClient()
  const { data: integ, error: integErr } = await db
    .from('integrations')
    .select('id, org_id, business_id, backfill_status, status')
    .eq('business_id', businessId)
    .eq('provider', 'fortnox')
    .maybeSingle()

  if (integErr) {
    return NextResponse.json({ error: `Integration lookup failed: ${integErr.message}` }, { status: 500 })
  }
  if (!integ) {
    return NextResponse.json({ error: 'No Fortnox integration found for that business' }, { status: 404 })
  }

  // Now run the standard admin guard with the resolved org_id.
  const guard = await requireAdmin(req, { orgId: integ.org_id, businessId })
  if (!('ok' in guard)) return guard  // 401/403/404 NextResponse

  // Reset the row so the worker's atomic claim can pick it up. Admin
  // intent is "run it now" — wipe any stale state row so the next run
  // starts fresh from Phase 1 (summary fetch). If the admin wanted to
  // RESUME a paused backfill, they can let the daily cron pick it up
  // or fire the worker directly without going through this endpoint.
  await db.from('fortnox_backfill_state').delete().eq('integration_id', integ.id)
  const { error: resetErr } = await db
    .from('integrations')
    .update({
      backfill_status:      'pending',
      backfill_started_at:  null,
      backfill_finished_at: null,
      backfill_error:       null,
      backfill_progress:    { phase: 'enqueued', triggered_by: 'admin_kick' },
      // Don't flip status here — the worker writes status='connected' on
      // success and 'error' on failure. Leaving the existing status
      // means the UI shows the right state during the run.
    })
    .eq('id', integ.id)

  if (resetErr) {
    return NextResponse.json({ error: `Failed to enqueue backfill: ${resetErr.message}` }, { status: 500 })
  }

  // Fire the worker via waitUntil and return immediately. waitUntil keeps
  // Vercel's runtime alive long enough for the outbound POST to actually
  // reach the worker (a bare fire-and-forget can be killed when the
  // response is sent), but the admin caller doesn't wait for the worker
  // to finish. Watch progress via the integrations table:
  //   SELECT backfill_status, backfill_progress, backfill_error
  //   FROM integrations WHERE business_id = '...' AND provider = 'fortnox';
  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)

  if (!base || !process.env.CRON_SECRET) {
    return NextResponse.json({
      error: 'Server misconfigured: NEXT_PUBLIC_APP_URL or CRON_SECRET missing — row is set to pending but worker cannot be triggered',
    }, { status: 500 })
  }

  waitUntil(
    fetch(`${base}/api/cron/fortnox-backfill-worker`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.CRON_SECRET}`,
      },
      body: JSON.stringify({ trigger: 'admin_kick', business_id: businessId, months }),
    }).catch(() => {}),  // worker errors are surfaced via integrations.backfill_error
  )

  return NextResponse.json({
    ok:             true,
    integration_id: integ.id,
    business_id:    businessId,
    months:         months ?? null,
    status:         'enqueued',
    message:        'Worker started in background. Watch backfill_status / backfill_progress in the integrations table — refresh every 15-30s.',
  })
}
