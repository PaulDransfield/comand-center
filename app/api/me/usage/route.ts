// app/api/me/usage/route.ts
//
// Lightweight endpoint the site-wide <AiUsageBanner /> polls. Returns
// current daily + monthly AI usage and any active warnings. No gating —
// just snapshot the state.

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { checkAiLimit } from '@/lib/ai/usage'
import { unstable_noStore } from 'next/cache'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const preferredRegion = 'fra1'

export async function GET(_req: NextRequest) {
  unstable_noStore()

  const auth = createClient()
  const { data: { user } } = await auth.auth.getUser()
  if (!user) {
    return NextResponse.json({ authenticated: false }, { status: 401 })
  }

  const db = createAdminClient()
  const { data: membership } = await db
    .from('organisation_members')
    .select('org_id, organisations(id, plan)')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  const org: any = membership?.organisations
  if (!org) return NextResponse.json({ authenticated: true, orgId: null })

  const gate = await checkAiLimit(db, org.id, org.plan ?? 'trial')
  if (gate.ok === false) {
    // Already blocked — surface that too so the banner can show "AI paused".
    return NextResponse.json({
      authenticated: true,
      orgId: org.id,
      plan:  org.plan,
      blocked: true,
      reason: (gate as any).body?.reason,
    }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
  }

  return NextResponse.json({
    authenticated:   true,
    orgId:           org.id,
    plan:            org.plan,
    blocked:         false,
    used:            gate.used,
    limit:           gate.limit,
    booster:         gate.booster,
    monthly_used_sek:    gate.monthly_used_sek,
    monthly_ceiling_sek: gate.monthly_ceiling_sek,
    warning:         gate.warning ?? null,
    monthly_warning: gate.monthly_warning ?? null,
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}
