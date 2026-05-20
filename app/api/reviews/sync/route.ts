// app/api/reviews/sync/route.ts
//
// Owner-triggered manual sync for a single business. Reuses the same
// per-business work as the daily cron via lib/reviews/sync, so the
// behaviour is identical — just instant instead of waiting until 04:20
// UTC tomorrow.
//
// POST { business_id } → 200 with summary, 401/403/400 otherwise.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { canAccessBusiness }                 from '@/lib/auth/permissions'
import { syncReviewsForBusiness }            from '@/lib/reviews/sync'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  // Manager+ can fire a sync — viewer can't (it spends Anthropic credits).
  if (auth.role !== 'owner' && auth.role !== 'manager') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return NextResponse.json({
      error: 'Google Places API key not configured on the server. Add GOOGLE_PLACES_API_KEY to environment variables.',
    }, { status: 503 })
  }

  let body: any = {}
  try { body = await req.json() } catch {}
  const businessId = String(body?.business_id ?? '')
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const subject = {
    role:              auth.role as any,
    business_ids:      (auth as any).businessIds ?? null,
    can_view_finances: true,
  }
  if (!canAccessBusiness(subject, businessId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = createAdminClient()
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id, name, google_place_id')
    .eq('id', businessId)
    .maybeSingle()

  if (!biz) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 })
  }
  if (!biz.google_place_id) {
    return NextResponse.json({
      error: 'No Google Place linked to this business. Use the connect flow on /reviews first.',
    }, { status: 400 })
  }

  const t0 = Date.now()
  const summary = await syncReviewsForBusiness(db, biz as any)

  return NextResponse.json({
    ...summary,
    duration_ms: Date.now() - t0,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
