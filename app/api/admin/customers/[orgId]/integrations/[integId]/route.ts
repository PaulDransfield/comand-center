// @ts-nocheck
// app/api/admin/customers/[orgId]/integrations/[integId]/route.ts
// DELETE — remove an integration. Also drops the cached discovery + api-discoveries-enhanced rows.
// POST   — { action: 'run_discovery' } — trigger Enhanced API Discovery for just this integration.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function checkAuth(req: NextRequest): boolean {
  const secret = req.headers.get('x-admin-secret') ?? req.cookies.get('admin_secret')?.value
  return secret === process.env.ADMIN_SECRET
}

export async function DELETE(req: NextRequest, { params }: { params: { orgId: string; integId: string } }) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createAdminClient()

  // Verify the integration belongs to this org (defense in depth)
  const { data: integ } = await db.from('integrations')
    .select('id, provider, org_id')
    .eq('id', params.integId)
    .eq('org_id', params.orgId)
    .maybeSingle()
  if (!integ) return NextResponse.json({ error: 'Integration not found for this org' }, { status: 404 })

  // Cascade-delete related rows first (api_discoveries, api_discoveries_enhanced, implementation_plans).
  // Ignore errors — tables may not exist in all environments.
  await Promise.all([
    db.from('api_discoveries').delete().eq('integration_id', params.integId).catch(() => null),
    db.from('api_discoveries_enhanced').delete().eq('integration_id', params.integId).catch(() => null),
    db.from('implementation_plans').delete().eq('integration_id', params.integId).catch(() => null),
  ])

  const { error } = await db.from('integrations').delete().eq('id', params.integId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Audit log
  try {
    await db.from('admin_log').insert({
      admin_email: 'admin',
      action:      'delete_integration',
      target_type: 'integration',
      target_id:   params.integId,
      details:     { provider: integ.provider, org_id: params.orgId },
    })
  } catch { /* non-fatal */ }

  return NextResponse.json({ ok: true })
}

// Trigger Enhanced Discovery for this one integration
export async function POST(req: NextRequest, { params }: { params: { orgId: string; integId: string } }) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
  return NextResponse.json({ ok: res.ok, status: res.status, response: text.slice(0, 1000) })
}
