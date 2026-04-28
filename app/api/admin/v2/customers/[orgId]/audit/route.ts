// app/api/admin/v2/customers/[orgId]/audit/route.ts
// READ-ONLY admin audit log for the Audit sub-tab.
// Last 100 admin_audit_log rows scoped to this org.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  const db = createAdminClient()

  const { data: rows } = await db
    .from('admin_audit_log')
    .select('id, action, actor, target_type, target_id, payload, ip_address, user_agent, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(100)

  return NextResponse.json({
    entries: rows ?? [],
    total:   (rows ?? []).length,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
