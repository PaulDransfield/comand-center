// app/api/audit/provenance/route.ts
//
// A1.10 — owner-facing provenance lookup for any tracked metric.
// GET /api/audit/provenance?business_id=&metric=&from=&to=

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { getMetricProvenance, type Metric } from '@/lib/audit/provenance'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VALID_METRICS = new Set<Metric>(['revenue', 'staff_cost', 'food_cost', 'net_profit', 'covers'])

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const u = new URL(req.url)
  const businessId = u.searchParams.get('business_id')
  const metric     = u.searchParams.get('metric') as Metric | null
  const from       = u.searchParams.get('from')
  const to         = u.searchParams.get('to')

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!metric || !VALID_METRICS.has(metric)) return NextResponse.json({ error: `metric must be one of ${Array.from(VALID_METRICS).join('|')}` }, { status: 400 })
  if (!from || !to) return NextResponse.json({ error: 'from + to required (YYYY-MM-DD)' }, { status: 400 })

  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  try {
    const out = await getMetricProvenance(db, businessId, metric, from, to)
    return NextResponse.json(out, {
      headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'provenance_failed' }, { status: 500 })
  }
}
