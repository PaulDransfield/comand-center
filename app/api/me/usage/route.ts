// app/api/me/usage/route.ts
//
// Lightweight endpoint the site-wide <AiUsageBanner /> polls. Returns
// current daily + monthly AI usage and any active warnings. No gating —
// just snapshot the state.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { checkAiLimit } from '@/lib/ai/usage'
import { unstable_noStore } from 'next/cache'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const preferredRegion = 'fra1'

export async function GET(req: NextRequest) {
  unstable_noStore()
  const auth = await getRequestAuth(req)
  if (!auth) {
    return NextResponse.json({ authenticated: false }, { status: 401 })
  }

  const db = createAdminClient()
  const gate = await checkAiLimit(db, auth.orgId, auth.plan ?? 'trial')
  if (gate.ok === false) {
    // Already blocked — surface that too so the banner can show "AI paused".
    return NextResponse.json({
      authenticated: true,
      orgId:   auth.orgId,
      plan:    auth.plan,
      blocked: true,
      reason:  (gate as any).body?.reason,
    }, { headers: { 'Cache-Control': 'private, max-age=15, stale-while-revalidate=60' } })
  }

  return NextResponse.json({
    authenticated:   true,
    orgId:           auth.orgId,
    plan:            auth.plan,
    blocked:         false,
    used:            gate.used,
    limit:           gate.limit,
    booster:         gate.booster,
    monthly_used_sek:    gate.monthly_used_sek,
    monthly_ceiling_sek: gate.monthly_ceiling_sek,
    warning:         gate.warning ?? null,
    monthly_warning: gate.monthly_warning ?? null,
  }, { headers: { 'Cache-Control': 'private, max-age=15, stale-while-revalidate=60' } })
}
