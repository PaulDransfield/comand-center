// app/api/admin/v2/customers/[orgId]/sync/route.ts
//
// v2 wrapper for "force sync this org's integrations". Takes a typed
// reason, records audit, runs sync via lib/sync/engine. Per PR 4 plan,
// this is one of the four quick actions on the right rail.
//
// Body: { reason: string, business_id?: string, integration_id?: string, provider?: string }
//
// If integration_id is supplied: sync only that integration.
// Else if business_id + provider: sync that single integration.
// Else: sync all eligible integrations for the org (master-sync style).

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'
import { runSync }                   from '@/lib/sync/engine'

export const dynamic     = 'force-dynamic'
export const maxDuration = 300

const REASON_MIN = 10

export async function POST(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  let body: any = {}
  try { body = await req.json() } catch {}

  const reason        = String(body?.reason ?? '').trim()
  const integrationId = body?.integration_id ? String(body.integration_id) : undefined
  const businessId    = body?.business_id    ? String(body.business_id)    : undefined
  const provider      = body?.provider       ? String(body.provider)       : undefined

  if (reason.length < REASON_MIN) {
    return NextResponse.json({ error: `reason required (min ${REASON_MIN} chars)` }, { status: 400 })
  }

  const guard = await requireAdmin(req, { orgId, businessId })
  if ('ok' in guard === false) return guard as NextResponse

  const db = createAdminClient()

  // Resolve the integration(s) to sync.
  let integsQuery = db.from('integrations')
    .select('id, business_id, provider, status')
    .eq('org_id', orgId)
    .in('status', ['connected', 'needs_reauth', 'error'])
  if (integrationId) integsQuery = integsQuery.eq('id', integrationId)
  if (businessId)    integsQuery = integsQuery.eq('business_id', businessId)
  if (provider)      integsQuery = integsQuery.eq('provider', provider)

  const { data: integs } = await integsQuery
  if (!integs?.length) {
    return NextResponse.json({ error: 'No matching eligible integrations' }, { status: 404 })
  }

  // Audit BEFORE the action — easier to reason about (no race where the
  // sync writes data but the audit insert dies and the row is missing).
  await recordAdminAction(db, {
    action:        ADMIN_ACTIONS.INTEGRATION_SYNC,
    orgId,
    targetType:    'org',
    targetId:      orgId,
    payload:       {
      reason,
      surface:        'admin_v2',
      integration_id: integrationId ?? null,
      business_id:    businessId    ?? null,
      provider:       provider      ?? null,
      target_count:   integs.length,
    },
    req,
  })

  // Run sync sequentially per integration. runSync handles its own
  // status updates + error handling.
  const results: any[] = []
  for (const i of integs) {
    try {
      const r = await runSync(orgId, i.provider, undefined, undefined, i.id)
      results.push({ integration_id: i.id, provider: i.provider, ok: true, ...r })
    } catch (e: any) {
      results.push({ integration_id: i.id, provider: i.provider, ok: false, error: e?.message ?? 'sync failed' })
    }
  }

  return NextResponse.json({
    ok:      results.every(r => r.ok),
    results,
    reason,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
