// app/api/admin/reaggregate/route.ts
//
// Admin-only helper to force aggregateMetrics() for a given (business, year).
// Exists to backfill monthly_metrics for Fortnox data that was applied
// BEFORE the 2026-04-22 aggregator fix (92f41a1) — those tracker_data
// rows exist but never seeded monthly_metrics because the aggregator
// used to skip months without POS data.
//
// POST /api/admin/reaggregate
// Body: { business_id, from_year, to_year?, org_id? }
//   - to_year defaults to from_year
//   - org_id defaults to the business's org

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin }      from '@/lib/admin/require-admin'
import { log }               from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 120

export async function POST(req: NextRequest) {
  const body       = await req.json().catch(() => ({} as any))
  const businessId = body.business_id as string | undefined
  const fromYear   = Number(body.from_year)
  const toYear     = Number(body.to_year ?? body.from_year)
  const orgId      = body.org_id as string | undefined

  if (!businessId)       return NextResponse.json({ error: 'business_id required' },                     { status: 400 })
  if (!fromYear)         return NextResponse.json({ error: 'from_year required' },                       { status: 400 })
  if (toYear < fromYear) return NextResponse.json({ error: 'to_year must be >= from_year' },             { status: 400 })
  if (toYear - fromYear > 5) return NextResponse.json({ error: 'Range capped at 6 years' },              { status: 400 })

  const db = createAdminClient()

  // Resolve org from business if not supplied; requireAdmin verifies scope.
  let effectiveOrgId = orgId
  if (!effectiveOrgId) {
    const { data: biz } = await db.from('businesses').select('org_id').eq('id', businessId).maybeSingle()
    if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 })
    effectiveOrgId = biz.org_id
  }

  const guard = await requireAdmin(req, { orgId: effectiveOrgId!, businessId })
  if ('ok' in guard === false) return guard as NextResponse

  const NO_CACHE = { 'Cache-Control': 'no-store, max-age=0, must-revalidate' }

  const started = Date.now()
  const { aggregateMetrics } = await import('@/lib/sync/aggregate')
  const results: any[] = []

  for (let y = fromYear; y <= toYear; y++) {
    try {
      const res = await aggregateMetrics(effectiveOrgId!, businessId, `${y}-01-01`, `${y}-12-31`)
      results.push({ year: y, ok: true, ...res })
    } catch (e: any) {
      results.push({ year: y, ok: false, error: e?.message ?? String(e) })
    }
  }

  const errors = results.filter(r => !r.ok).length
  log.info('admin-reaggregate complete', {
    route:       'admin/reaggregate',
    duration_ms: Date.now() - started,
    org_id:      effectiveOrgId,
    business_id: businessId,
    from_year:   fromYear,
    to_year:     toYear,
    years:       toYear - fromYear + 1,
    errors,
    status:      errors === 0 ? 'success' : 'partial',
  })

  return NextResponse.json({ ok: errors === 0, years: results }, { headers: NO_CACHE })
}
