// app/api/admin/v2/customers/[orgId]/reaggregate/route.ts
//
// v2 wrapper for "rebuild monthly_metrics for this org's businesses".
// Takes a typed reason, records audit, calls aggregateMetrics for each
// business + year. Replaces the existing /api/admin/reaggregate which
// requires explicit business_id + from_year and doesn't audit.
//
// Body: { reason: string, from_year?: number, to_year?: number, business_id?: string }

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction }         from '@/lib/admin/audit'

export const dynamic     = 'force-dynamic'
export const maxDuration = 120

const REASON_MIN = 10

export async function POST(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  let body: any = {}
  try { body = await req.json() } catch {}

  const reason     = String(body?.reason ?? '').trim()
  const businessId = body?.business_id ? String(body.business_id) : undefined
  const fromYear   = Number(body?.from_year ?? new Date().getUTCFullYear())
  const toYear     = Number(body?.to_year   ?? fromYear)

  if (reason.length < REASON_MIN) {
    return NextResponse.json({ error: `reason required (min ${REASON_MIN} chars)` }, { status: 400 })
  }
  if (!fromYear || toYear < fromYear || toYear - fromYear > 5) {
    return NextResponse.json({ error: 'invalid year range (max span 6 years)' }, { status: 400 })
  }

  const guard = await requireAdmin(req, { orgId, businessId })
  if ('ok' in guard === false) return guard as NextResponse

  const db = createAdminClient()

  // Resolve the business(es) to reaggregate. If none specified, all
  // active businesses in the org.
  let bizQuery = db.from('businesses').select('id, name').eq('org_id', orgId)
  if (businessId) bizQuery = bizQuery.eq('id', businessId)
  const { data: bizList } = await bizQuery
  if (!bizList?.length) {
    return NextResponse.json({ error: 'No businesses found' }, { status: 404 })
  }

  // Audit BEFORE the action.
  await recordAdminAction(db, {
    action:     'reaggregate',           // not in ADMIN_ACTIONS const yet — fine, audit accepts string
    orgId,
    targetType: 'org',
    targetId:   orgId,
    payload:    {
      reason,
      surface:        'admin_v2',
      business_id:    businessId ?? null,
      from_year:      fromYear,
      to_year:        toYear,
      business_count: bizList.length,
    },
    req,
  })

  const { aggregateMetrics } = await import('@/lib/sync/aggregate')
  const results: any[] = []
  for (const b of bizList) {
    for (let y = fromYear; y <= toYear; y++) {
      try {
        const r = await aggregateMetrics(orgId, b.id, `${y}-01-01`, `${y}-12-31`)
        results.push({ business_id: b.id, business_name: b.name, year: y, ok: true, ...r })
      } catch (e: any) {
        results.push({ business_id: b.id, business_name: b.name, year: y, ok: false, error: e?.message ?? 'reaggregate failed' })
      }
    }
  }

  return NextResponse.json({
    ok:       results.every(r => r.ok),
    results,
    reason,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
