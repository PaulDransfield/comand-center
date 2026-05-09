// app/api/feature-flags/prediction-v2/route.ts
//
// Lightweight per-business flag lookup for the prediction-system v2 build.
// The page hits this on mount to know which v2 features to render. All
// flags default OFF; the response body returns ONLY the flags currently
// enabled (so the client can do `flags.includes(name)` cheaply).
//
// Why not embed in the page's existing fetches: AppShell's pages already
// fire ~16 calls per dashboard load; we don't want every page that might
// gate a v2 feature to redundantly load all of them. A single endpoint
// keeps the cost predictable and lets the wrapper module own the flag
// list canonically.
//
// See PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md Appendix Z (Stream F.2).

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { getPredictionV2FlagsEnabledForBusiness } from '@/lib/featureFlags/prediction-v2'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const businessId = req.nextUrl.searchParams.get('business_id')
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  // Cross-tenant guard — the caller's org must own this business.
  const db = createAdminClient()
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id')
    .eq('id', businessId)
    .maybeSingle()
  if (!biz || biz.org_id !== auth.orgId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const enabled = await getPredictionV2FlagsEnabledForBusiness(businessId, db)
  return NextResponse.json(
    { flags: Array.from(enabled) },
    { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } },
  )
}
