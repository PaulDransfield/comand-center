// app/api/admin/onboard/status/route.ts
//
// Read-model for the concierge onboarding board. Returns the live state of
// every onboarding stage for one business. Polled every ~5s by the board.
//
// GET /api/admin/onboard/status?business_id=X
//   Auth: ADMIN_SECRET (x-admin-secret header / cookie), org-scoped via
//   requireAdmin once the business's org is resolved.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/admin/require-admin'
import { buildOnboardSnapshot } from '@/lib/onboard/snapshot'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(req: NextRequest) {
  noStore()

  const businessId = (new URL(req.url).searchParams.get('business_id') ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()

  // Resolve org so requireAdmin can verify the (admin secret, org, business) tuple.
  const { data: biz } = await db
    .from('businesses')
    .select('org_id')
    .eq('id', businessId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  const guard = await requireAdmin(req, { orgId: biz.org_id, businessId })
  if (!('ok' in guard)) return guard

  const snap = await buildOnboardSnapshot(db, businessId)
  if (!snap) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  // Strip the internal `raw` block — the board only needs business + stages.
  return NextResponse.json({
    business: snap.business,
    stages:   snap.stages,
    all_done: snap.allDone,
    at:       new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}
