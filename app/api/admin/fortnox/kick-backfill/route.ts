// app/api/admin/fortnox/kick-backfill/route.ts
//
// Admin one-click "kick Fortnox backfill" endpoint. Bypasses the
// owner-side run-backfill button's gates and the fire-and-forget
// trigger reliability issues — admin presents ADMIN_SECRET, we reset
// the integration row to backfill_status='pending', then AWAIT a
// direct call to the worker so the admin sees what actually happened.
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
import { requireAdmin }                from '@/lib/admin/require-admin'
import { createAdminClient }           from '@/lib/supabase/server'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 300  // worker can take up to ~5 min for a busy restaurant

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

  // Reset the row so the worker's atomic claim can pick it up. We don't
  // care about the prior status — admin intent is "run it now".
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

  // Directly call the worker and AWAIT — admin endpoint isn't customer-
  // facing so we can hold the connection open until the worker reports
  // back. Returns the worker's response verbatim.
  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)

  if (!base || !process.env.CRON_SECRET) {
    return NextResponse.json({
      error: 'Server misconfigured: NEXT_PUBLIC_APP_URL or CRON_SECRET missing — row is set to pending but worker cannot be triggered',
    }, { status: 500 })
  }

  let workerResponse: any = null
  let workerStatus       = 0
  try {
    const r = await fetch(`${base}/api/cron/fortnox-backfill-worker`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.CRON_SECRET}`,
      },
      body: JSON.stringify({ trigger: 'admin_kick', business_id: businessId, months }),
    })
    workerStatus = r.status
    workerResponse = await r.json().catch(() => ({ raw: 'non-json response' }))
  } catch (err: any) {
    return NextResponse.json({
      error: `Worker fetch failed: ${err?.message ?? String(err)}`,
      integration_id: integ.id,
    }, { status: 502 })
  }

  return NextResponse.json({
    ok:             workerStatus >= 200 && workerStatus < 300,
    integration_id: integ.id,
    business_id:    businessId,
    worker_status:  workerStatus,
    worker_response: workerResponse,
  })
}
