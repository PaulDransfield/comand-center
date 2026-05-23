// app/api/inventory/lines/backfill/route.ts
//
// Kick endpoint for the inventory Phase A backfill. Background-worker
// pattern — same shape as /api/admin/fortnox/kick-backfill:
//
//   1. Validate auth + business_id
//   2. Upsert an inventory_backfill_state row with status='pending'
//   3. Fire the worker via Vercel `waitUntil` (keeps the function alive
//      after the HTTP response is sent — up to the function's max
//      duration cap)
//   4. Return immediately with { ok, started_at }
//
// The admin UI polls /api/inventory/lines/backfill/status?business_id=…
// for live progress (next file over).
//
// Replaces the v1 of this endpoint that ran synchronously and timed
// out (HTTP 504) on businesses with > ~60 invoices because the matcher
// cost (~50-100ms × thousands of lines) exceeded the edge proxy timeout.

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
// Function may live for up to 800s (Vercel Pro cap) while the background
// worker grinds. The HTTP response itself returns within seconds. Even
// 800s isn't enough to walk hundreds of invoices serially via Fortnox's
// rate-limited API on a cold backfill — the skip-already-ingested
// optimisation in lib/inventory/backfill-worker.ts is what makes
// re-runs fast (no Fortnox calls for invoices we already have).
export const maxDuration = 800

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { waitUntil } from '@vercel/functions'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { runInventoryBackfill } from '@/lib/inventory/backfill-worker'

export async function POST(req: NextRequest) {
  noStore()

  // Two auth paths:
  //   - User session (owner clicking 'Kick inventory backfill' from /admin/v2/tools)
  //   - CRON_SECRET / ADMIN_SECRET (server-to-server from OAuth callback,
  //     periodic sweep, ops scripts). The cron path needs an explicit
  //     business_id since there's no session to derive org from.
  const headerAuth = req.headers.get('authorization') ?? ''
  const cronSecret  = process.env.CRON_SECRET
  const adminSecret = process.env.ADMIN_SECRET
  const isCronCall =
    (cronSecret  && headerAuth === `Bearer ${cronSecret}`) ||
    (adminSecret && headerAuth === `Bearer ${adminSecret}`)

  let userOrgId: string | null = null
  let userIdentity: string = 'cron'
  if (!isCronCall) {
    const auth = await getRequestAuth(req)
    if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    userOrgId   = auth.orgId
    userIdentity = auth.userId
  }

  const body = await req.json().catch(() => ({}))
  const businessId = String(body.business_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  // User-session calls go through the existing business-access gate.
  // Cron calls trust the secret + the explicit business_id.
  if (!isCronCall) {
    const auth = await getRequestAuth(req)
    if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    const forbidden = requireBusinessAccess(auth, businessId)
    if (forbidden) return forbidden
  }

  const db = createAdminClient()

  // Cron path needs the org_id from the businesses table directly.
  let orgId = userOrgId
  if (!orgId) {
    const { data: biz } = await db
      .from('businesses')
      .select('org_id')
      .eq('id', businessId)
      .maybeSingle()
    if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })
    orgId = biz.org_id
  }
  if (!orgId) return NextResponse.json({ error: 'business has no org_id' }, { status: 500 })

  // Initial state row — UPSERT so re-kicks replace the previous run's
  // status/progress cleanly. The supplier_invoice_lines rows from any
  // previous run stay intact (idempotent on their row-level unique key);
  // the matcher will skip already-matched ones.
  const initialProgress = {
    phase:        'enqueued',
    triggered_at: new Date().toISOString(),
    triggered_by: userIdentity,
  }
  const { error: upsertErr } = await db
    .from('inventory_backfill_state')
    .upsert({
      org_id:        orgId,
      business_id:   businessId,
      status:        'pending',
      progress:      initialProgress,
      started_at:    new Date().toISOString(),
      finished_at:   null,
      error_message: null,
    }, { onConflict: 'business_id' })
  if (upsertErr) {
    return NextResponse.json({
      error:   'state_init_failed',
      message: upsertErr.message,
    }, { status: 500 })
  }

  // Fire the worker. waitUntil keeps the function alive after the HTTP
  // response so the worker finishes regardless of the client's poll
  // cadence. The worker itself catches errors and writes them to the
  // state row — the .catch below is belt-and-braces for the case where
  // something throws before the worker's own try/catch fires.
  waitUntil(
    runInventoryBackfill(db, {
      org_id:      orgId,
      business_id: businessId,
    }).catch(err =>
      db.from('inventory_backfill_state').update({
        status:        'failed',
        error_message: `worker crashed before handler: ${err?.message ?? err}`,
        finished_at:   new Date().toISOString(),
      }).eq('business_id', businessId).then(() => {})
    )
  )

  return NextResponse.json({
    ok:          true,
    status:      'started',
    business_id: businessId,
    message:     'Backfill running in the background. Poll the status endpoint for progress.',
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}
