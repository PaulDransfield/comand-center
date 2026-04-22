// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { runSync }        from '@/lib/sync/engine'
import { requireAdmin }   from '@/lib/admin/require-admin'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  try {
    const { integration_id, org_id, from } = await req.json()
    if (!integration_id || !org_id) return NextResponse.json({ error: 'integration_id and org_id required' }, { status: 400 })

    // Previously UNAUTHED — anyone on the internet could trigger a sync
    // on any tenant's integration. requireAdmin also verifies the org
    // actually exists before dispatching. Fixed 2026-04-22.
    const guard = await requireAdmin(req, { orgId: org_id })
    if ('ok' in guard === false) return guard as NextResponse

    // Default to 90 days ago for manual syncs (fast)
    // Full backfill on first connect uses earliest_date from test-connection
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const fromDate = from ?? ninetyDaysAgo
    const toDate   = new Date().toISOString().slice(0, 10)

    const result = await runSync(org_id, 'personalkollen', fromDate, toDate, integration_id)
    return NextResponse.json({ ok: true, ...result })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
