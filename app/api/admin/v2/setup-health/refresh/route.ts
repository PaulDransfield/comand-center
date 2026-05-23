// app/api/admin/v2/setup-health/refresh/route.ts
//
// Admin trigger for a one-off readiness re-evaluation. Used by the
// admin rollup page's "Re-run" button per row, AND callable from ops
// scripts when a customer reports a setup issue.
//
// POST /api/admin/v2/setup-health/refresh
//   Body: { business_id }
// Auth: ADMIN_SECRET as Bearer.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { evaluateFortnoxReadiness } from '@/lib/integrations/fortnox-readiness'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 120

export async function POST(req: NextRequest) {
  noStore()

  const adminSecret = process.env.ADMIN_SECRET
  const auth = req.headers.get('authorization') ?? ''
  if (!adminSecret || auth !== `Bearer ${adminSecret}`) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id, name')
    .eq('id', businessId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  try {
    const result = await evaluateFortnoxReadiness(db, biz.org_id, businessId)
    return NextResponse.json({
      business: biz.name,
      overall:  result.overall,
      counts:   result.checks.reduce((acc, c) => {
        acc[c.status] = (acc[c.status] ?? 0) + 1
        return acc
      }, {} as Record<string, number>),
      duration_ms: result.duration_ms,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json({
      error:   'eval_failed',
      message: String(e?.message ?? e),
    }, { status: 502 })
  }
}
