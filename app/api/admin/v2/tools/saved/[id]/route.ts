// app/api/admin/v2/tools/saved/[id]/route.ts
//
// Single saved investigation — DELETE only (hard delete; the query
// itself is non-PII and the audit row already captured label + chars).

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'

export const dynamic = 'force-dynamic'

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params
  const guard = await requireAdmin(req)
  if ('ok' in guard === false) return guard as NextResponse

  const db = createAdminClient()

  const { data: existing, error: loadErr } = await db
    .from('admin_saved_queries')
    .select('id, label, org_id, query')
    .eq('id', id)
    .maybeSingle()
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 })
  if (!existing) return NextResponse.json({ error: 'saved query not found' }, { status: 404 })

  const { error } = await db.from('admin_saved_queries').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await recordAdminAction(db as any, {
    action:     ADMIN_ACTIONS.INVESTIGATION_DELETE,
    orgId:      existing.org_id ?? null,
    targetType: existing.org_id ? 'org' : 'system',
    targetId:   existing.org_id ?? null,
    payload:    { surface: 'admin_v2', saved_query_id: id, label: existing.label, query_chars: existing.query.length },
    req,
  })

  return NextResponse.json({ ok: true })
}
