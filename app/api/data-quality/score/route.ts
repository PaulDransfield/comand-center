// app/api/data-quality/score/route.ts
//
// A1.9 — Data quality score endpoint. GET /api/data-quality/score?business_id=…
// returns the five-dimension breakdown + overall 0-100 score.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { computeDataQualityScore } from '@/lib/data-quality/score'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const businessId = new URL(req.url).searchParams.get('business_id')
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  const score = await computeDataQualityScore(db, businessId)
  return NextResponse.json(score, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}
