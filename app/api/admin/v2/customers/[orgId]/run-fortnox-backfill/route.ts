// app/api/admin/v2/customers/[orgId]/run-fortnox-backfill/route.ts
//
// Admin v2 quick-action wrapper around the 12-month Fortnox API backfill.
// Same enqueue logic as the owner-facing /api/integrations/fortnox/run-backfill,
// but auth'd via requireAdmin (admin secret + TOTP per project pattern) and
// audit-logged with a required reason.
//
// Body: { reason: string, business_id?: string, integration_id?: string }
//
// If integration_id is supplied: enqueue that specific Fortnox integration.
// Else if business_id is supplied: enqueue the Fortnox integration on that
//   business in this org.
// Else: enqueue every Fortnox integration on this org (typical case — orgs
//   currently have 0–1 Fortnox connections per business).
//
// Skips integrations whose backfill_status is already 'running' (don't disturb
// an in-flight worker — would risk a concurrent claim if it crashes).

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const REASON_MIN = 10

export async function POST(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  let body: any = {}
  try { body = await req.json() } catch {}

  const reason        = String(body?.reason ?? '').trim()
  const integrationId = body?.integration_id ? String(body.integration_id) : undefined
  const businessId    = body?.business_id    ? String(body.business_id)    : undefined

  if (reason.length < REASON_MIN) {
    return NextResponse.json({ error: `reason required (min ${REASON_MIN} chars)` }, { status: 400 })
  }

  const guard = await requireAdmin(req, { orgId, businessId })
  if ('ok' in guard === false) return guard as NextResponse

  const db = createAdminClient()

  let q = db.from('integrations')
    .select('id, business_id, backfill_status')
    .eq('org_id', orgId)
    .eq('provider', 'fortnox')
  if (integrationId) q = q.eq('id', integrationId)
  if (businessId)    q = q.eq('business_id', businessId)

  const { data: rows } = await q
  if (!rows?.length) {
    return NextResponse.json({ error: 'No matching Fortnox integrations' }, { status: 404 })
  }

  // Audit BEFORE the action — same convention as /sync and /reaggregate.
  await recordAdminAction(db, {
    action:     ADMIN_ACTIONS.INTEGRATION_BACKFILL,
    orgId,
    targetType: 'org',
    targetId:   orgId,
    payload: {
      reason,
      surface:        'admin_v2',
      integration_id: integrationId ?? null,
      business_id:    businessId    ?? null,
      target_count:   rows.length,
      already_running: rows.filter(r => r.backfill_status === 'running').length,
    },
    req,
  })

  // Flip eligible rows to pending. 'running' rows are skipped — re-claim
  // would race with the in-flight worker if it crashes mid-run.
  const eligible = rows.filter(r => r.backfill_status !== 'running')
  const skipped  = rows.length - eligible.length

  if (eligible.length === 0) {
    return NextResponse.json({
      ok:              true,
      enqueued:        0,
      already_running: skipped,
      results:         rows.map(r => ({
        integration_id: r.id, business_id: r.business_id,
        status: r.backfill_status,
        action: 'skipped_in_flight',
      })),
      reason,
    })
  }

  const eligibleIds = eligible.map(r => r.id)
  const { error: updErr } = await db
    .from('integrations')
    .update({
      backfill_status:   'pending',
      backfill_progress: { phase: 'enqueued', triggered_by: 'admin_v2', reason: reason.slice(0, 200) },
      backfill_error:    null,
    })
    .in('id', eligibleIds)

  if (updErr) {
    return NextResponse.json({ error: `Failed to enqueue: ${updErr.message}` }, { status: 500 })
  }

  // Fire the worker once so the operator doesn't wait for the cron.
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
      body: JSON.stringify({ trigger: 'admin_v2' }),
    }).catch(() => {})
  }

  return NextResponse.json({
    ok:              true,
    enqueued:        eligible.length,
    already_running: skipped,
    results: rows.map(r => ({
      integration_id: r.id,
      business_id:    r.business_id,
      status:         eligibleIds.includes(r.id) ? 'pending' : r.backfill_status,
      action:         eligibleIds.includes(r.id) ? 'enqueued' : 'skipped_in_flight',
    })),
    reason,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
