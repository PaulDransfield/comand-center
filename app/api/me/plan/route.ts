// app/api/me/plan/route.ts
//
// Lightweight endpoint used by the client-side PlanGate to decide whether
// the logged-in user's org has an active paid subscription. Returns a
// boolean `requiresUpgrade` flag which the gate uses to redirect to /upgrade.
//
// Uses getRequestAuth (the codebase's proven cookie parser) rather than
// createClient().auth.getUser() — the latter was returning authenticated:false
// on this project's @supabase/ssr v0.3 cookie layout.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { unstable_noStore } from 'next/cache'

// Paid plans + legacy aliases (`starter`, `pro`) so existing DB rows from
// before the 2026-04-23 rename still count as paid. Only `trial` and
// `past_due` (and anything unrecognised) trigger the upgrade redirect.
const PAID_PLANS = new Set(['founding', 'solo', 'group', 'chain', 'enterprise', 'starter', 'pro'])

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
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
  const { data: org } = await db
    .from('organisations')
    .select('id, name, plan, trial_end, is_active')
    .eq('id', auth.orgId)
    .maybeSingle()

  if (!org) {
    return NextResponse.json({
      authenticated:   true,
      orgId:           null,
      plan:            null,
      requiresUpgrade: true,
      reason:          'no_org',
    }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
  }

  const plan            = String(org.plan ?? 'trial')
  const requiresUpgrade = !PAID_PLANS.has(plan)

  return NextResponse.json({
    authenticated:   true,
    orgId:           org.id,
    orgName:         org.name,
    plan,
    trialEnd:        org.trial_end ?? null,
    requiresUpgrade,
    reason:          requiresUpgrade ? (plan === 'past_due' ? 'past_due' : 'needs_plan') : null,
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}
