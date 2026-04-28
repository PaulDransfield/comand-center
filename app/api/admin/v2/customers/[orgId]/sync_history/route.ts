// app/api/admin/v2/customers/[orgId]/sync_history/route.ts
// READ-ONLY sync log for the Sync History sub-tab.
// Last 50 sync runs across all integrations for this org.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  const db = createAdminClient()

  const { data: logs } = await db
    .from('sync_log')
    .select('id, provider, status, records_synced, date_from, date_to, error_msg, duration_ms, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(50)

  return NextResponse.json({
    logs: logs ?? [],
    total: (logs ?? []).length,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
