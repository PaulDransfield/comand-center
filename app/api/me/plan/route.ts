// app/api/me/plan/route.ts
//
// Lightweight endpoint used by the client-side PlanGate to decide whether
// the logged-in user's org has an active paid subscription. Returns a
// boolean `requiresUpgrade` flag which the gate uses to redirect to /upgrade.
//
// Response shape:
//   { orgId, plan, requiresUpgrade, trialEnd }
//
// 'requiresUpgrade' is true for `trial`, `past_due`, or any unknown plan.
// Paid plans (founding, solo, group, chain, enterprise) return false.

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { unstable_noStore }          from 'next/cache'

// Paid plans + legacy aliases (`starter`, `pro`) so existing DB rows from
// before the 2026-04-23 rename still count as paid. Only `trial` and
// `past_due` (and anything unrecognised) trigger the upgrade redirect.
const PAID_PLANS = new Set(['founding', 'solo', 'group', 'chain', 'enterprise', 'starter', 'pro'])

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const preferredRegion = 'fra1'

export async function GET(_req: NextRequest) {
  unstable_noStore()
  const db = createClient()

  const { data: { user } } = await db.auth.getUser()
  if (!user) {
    return NextResponse.json({ authenticated: false }, {
      status: 401,
      headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
    })
  }

  // First org membership — for now we're single-org-per-user. If that changes,
  // the caller can switch via a separate endpoint and this returns the active one.
  const { data: membership } = await db
    .from('organisation_members')
    .select('org_id, organisations(id, name, plan, trial_end, is_active)')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  const org: any = membership?.organisations
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
