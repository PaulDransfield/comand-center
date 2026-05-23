// app/api/integrations/fortnox/readiness/route.ts
//
// Phase 1 — Day-1 Fortnox setup readiness check. Returns the 10-validator
// report for a single business. Designed to be polled every ~3 s from
// the post-OAuth verify screen.
//
// GET /api/integrations/fortnox/readiness?business_id=X
//   → JSON ReadinessResult (see lib/integrations/fortnox-readiness.ts)

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { canAccessBusiness } from '@/lib/auth/permissions'
import { evaluateFortnoxReadiness } from '@/lib/integrations/fortnox-readiness'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  noStore()

  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const subject = {
    role:              auth.role as any,
    business_ids:      (auth as any).businessIds ?? null,
    can_view_finances: true,
  }

  const bizId = (new URL(req.url).searchParams.get('business_id') ?? '').trim()
  if (!bizId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!canAccessBusiness(subject, bizId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const db = createAdminClient()
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id')
    .eq('id', bizId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 })

  try {
    const result = await evaluateFortnoxReadiness(db, biz.org_id, bizId)
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
    })
  } catch (e: any) {
    return NextResponse.json({
      error:   'readiness_check_failed',
      message: String(e?.message ?? e),
    }, { status: 502 })
  }
}
