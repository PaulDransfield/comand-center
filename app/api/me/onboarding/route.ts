// app/api/me/onboarding/route.ts
//
// Lightweight endpoint used by the client-side OnboardingGate to decide
// whether the logged-in user has finished the onboarding wizard. Returns
// `{ completed: boolean }`. The gate redirects to /onboarding when false.
//
// Same shape + caching policy as /api/me/plan — short SWR window because
// the answer flips at most once per account (when the user finishes
// onboarding) and stays stable forever after.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { unstable_noStore } from 'next/cache'

export const runtime         = 'nodejs'
export const dynamic         = 'force-dynamic'
export const preferredRegion = 'fra1'

export async function GET(req: NextRequest) {
  unstable_noStore()
  const auth = await getRequestAuth(req)
  if (!auth) {
    return NextResponse.json({ authenticated: false }, {
      status: 401,
      headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
    })
  }

  const db = createAdminClient()

  // We treat the org as "onboarded" when EITHER:
  //   1. onboarding_progress.completed_at is set (the wizard's finish()
  //      step writes this), OR
  //   2. there's at least one business in the org (legacy customers may
  //      pre-date the onboarding_progress table — they have data, so
  //      they're definitively done).
  // Without #2, every legacy customer would get bounced to /onboarding
  // on next login, which would be unwelcome.
  const [progressRes, bizRes] = await Promise.all([
    db.from('onboarding_progress')
      .select('completed_at')
      .eq('org_id', auth.orgId)
      .maybeSingle(),
    db.from('businesses')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', auth.orgId)
      .limit(1),
  ])

  const wizardDone = !!progressRes.data?.completed_at
  const hasBusiness = (bizRes.count ?? 0) > 0
  const completed = wizardDone || hasBusiness

  return NextResponse.json({
    authenticated: true,
    completed,
    completed_at:  progressRes.data?.completed_at ?? null,
  }, {
    // Same SWR pattern as plan: rare flips, allow short cache.
    headers: { 'Cache-Control': 'private, max-age=15, stale-while-revalidate=60' },
  })
}
