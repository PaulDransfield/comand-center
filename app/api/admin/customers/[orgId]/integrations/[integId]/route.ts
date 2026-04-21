// @ts-nocheck
// app/api/admin/customers/[orgId]/integrations/[integId]/route.ts
// DELETE — remove an integration. Also drops the cached discovery + api-discoveries-enhanced rows.
// POST   — { action: 'run_discovery' } — trigger Enhanced API Discovery for just this integration.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'
import { requireAdmin } from '@/lib/admin/require-admin'
import { captureWarning } from '@/lib/monitoring/sentry'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

export async function DELETE(req: NextRequest, { params }: { params: { orgId: string; integId: string } }) {
  // Admin-secret + org-exists scope check in one call.
  const guard = await requireAdmin(req, { orgId: params.orgId })
  if ('ok' in guard === false) return guard as NextResponse

  const db = createAdminClient()

  // Verify the integration belongs to this org (defense in depth —
  // admin guard confirmed the org, this confirms the integration
  // pairing matches).
  const { data: integ } = await db.from('integrations')
    .select('id, provider, org_id')
    .eq('id', params.integId)
    .eq('org_id', params.orgId)
    .maybeSingle()
  if (!integ) return NextResponse.json({ error: 'Integration not found for this org' }, { status: 404 })

  // Cascade-delete related rows. Tables may not exist in all environments
  // (api_discoveries et al. come from a separate migration sequence).
  // Capture failures as warnings so we can tell "table-doesn't-exist"
  // (expected) from "real problem" (unexpected) post-hoc via Sentry —
  // rather than silent .catch(() => null) which hides both.
  const cascades = [
    { table: 'api_discoveries',          q: db.from('api_discoveries').delete().eq('integration_id', params.integId) },
    { table: 'api_discoveries_enhanced', q: db.from('api_discoveries_enhanced').delete().eq('integration_id', params.integId) },
    { table: 'implementation_plans',     q: db.from('implementation_plans').delete().eq('integration_id', params.integId) },
  ]
  for (const c of cascades) {
    const { error } = await c.q
    if (error) {
      captureWarning(`integration cascade delete failed: ${c.table}`, {
        route:          'admin/integrations/delete',
        table:          c.table,
        error:          error.message,
        integration_id: params.integId,
        org_id:         params.orgId,
      })
    }
  }

  const { error } = await db.from('integrations').delete().eq('id', params.integId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await recordAdminAction(db, {
    action:        ADMIN_ACTIONS.INTEGRATION_DELETE,
    orgId:         params.orgId,
    integrationId: params.integId,
    targetType:    'integration',
    targetId:      params.integId,
    payload:       { provider: integ.provider },
    req,
  })

  return NextResponse.json({ ok: true })
}

// Trigger Enhanced Discovery for this one integration
export async function POST(req: NextRequest, { params }: { params: { orgId: string; integId: string } }) {
  const guard = await requireAdmin(req, { orgId: params.orgId })
  if ('ok' in guard === false) return guard as NextResponse

  const body = await req.json().catch(() => ({}))
  if (body.action !== 'run_discovery') return NextResponse.json({ error: 'Unknown action' }, { status: 400 })

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://comandcenter.se'
  const res = await fetch(`${appUrl}/api/admin/trigger-enhanced-discovery?integration_id=${params.integId}`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.ADMIN_SECRET ?? ''}`,
    },
  })
  const text = await res.text()

  const db = createAdminClient()
  await recordAdminAction(db, {
    action:        ADMIN_ACTIONS.DISCOVERY_RUN,
    orgId:         params.orgId,
    integrationId: params.integId,
    targetType:    'integration',
    targetId:      params.integId,
    payload:       { ok: res.ok, status: res.status },
    req,
  })

  return NextResponse.json({ ok: res.ok, status: res.status, response: text.slice(0, 1000) })
}
