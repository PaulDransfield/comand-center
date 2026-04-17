// @ts-nocheck
// app/api/admin/customers/route.ts
// Pipeline view data for /admin/customers — one row per org with enough info to
// classify it into a lifecycle stage and show at-a-glance stats.
//
// Stages:
//   new       — signed up, no integration connected yet
//   setup     — integration(s) connected, no successful sync yet
//   active    — synced in the last 14 days
//   at_risk   — no sync in 14-30 days, or payment failed
//   churned   — is_active = false
//
// Auth: x-admin-secret header (matches the rest of the admin APIs)

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

function checkAuth(req: NextRequest): boolean {
  const secret = req.headers.get('x-admin-secret') ?? req.cookies.get('admin_secret')?.value
  return secret === process.env.ADMIN_SECRET
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createAdminClient()
  const now = Date.now()
  const day = 86_400_000
  const todayStr = new Date().toISOString().slice(0, 10)

  const [orgsRes, membersRes, integsRes, onboardingRes, aiUsageRes] = await Promise.all([
    db.from('organisations').select('id, name, plan, is_active, trial_ends_at, created_at, stripe_customer_id').order('created_at', { ascending: false }),
    db.from('organisation_members').select('org_id, user_id, role, created_at'),
    db.from('integrations').select('org_id, provider, status, last_sync_at, last_error'),
    db.from('onboarding_progress').select('org_id, step, metadata, current_step, steps_completed, completed_at'),
    db.from('ai_usage_daily').select('org_id, query_count').eq('date', todayStr),
  ])

  const orgs = orgsRes.data ?? []
  const members = membersRes.data ?? []
  const integrations = integsRes.data ?? []
  const onboardings = onboardingRes.data ?? []
  const aiUsage = aiUsageRes.data ?? []

  // Lookup auth emails for first member of each org (for display + contact)
  const firstMemberByOrg: Record<string, string> = {}
  for (const m of members) {
    if (!firstMemberByOrg[m.org_id]) firstMemberByOrg[m.org_id] = m.user_id
  }
  const uniqueUserIds = [...new Set(Object.values(firstMemberByOrg))]
  const emailByUserId: Record<string, string> = {}
  for (const uid of uniqueUserIds) {
    const { data } = await db.auth.admin.getUserById(uid)
    if (data?.user?.email) emailByUserId[uid] = data.user.email
  }

  const enriched = orgs.map((o: any) => {
    const integs = integrations.filter((i: any) => i.org_id === o.id)
    const connected = integs.filter((i: any) => i.status === 'connected')
    const lastSync = integs
      .map((i: any) => i.last_sync_at ? new Date(i.last_sync_at).getTime() : 0)
      .reduce((a, b) => Math.max(a, b), 0)
    const lastSyncDays = lastSync > 0 ? Math.floor((now - lastSync) / day) : null
    const daysOnPlatform = Math.floor((now - new Date(o.created_at).getTime()) / day)
    const memberCount = members.filter((m: any) => m.org_id === o.id).length
    const firstUserId = firstMemberByOrg[o.id]
    const email = firstUserId ? emailByUserId[firstUserId] : null

    const onboarding = onboardings.find((ob: any) => ob.org_id === o.id)
    const setupRequested = onboarding?.step === 'setup_requested'
    const setupData = onboarding?.metadata ?? null

    const aiQueriesToday = aiUsage.find((a: any) => a.org_id === o.id)?.query_count ?? 0

    const hasError = integs.some((i: any) => i.status === 'error' || i.last_error)

    // Stage classification
    let stage: 'new' | 'setup' | 'active' | 'at_risk' | 'churned'
    if (!o.is_active) stage = 'churned'
    else if (connected.length === 0) stage = 'new'
    else if (lastSync === 0) stage = 'setup'
    else if (lastSyncDays !== null && lastSyncDays > 14) stage = 'at_risk'
    else stage = 'active'

    return {
      id:                o.id,
      name:              o.name,
      plan:              o.plan,
      is_active:         o.is_active,
      email,
      days_on_platform:  daysOnPlatform,
      trial_ends_at:     o.trial_ends_at,
      has_stripe:        !!o.stripe_customer_id,
      member_count:      memberCount,
      integrations_total:     integs.length,
      integrations_connected: connected.length,
      last_sync_at:      lastSync > 0 ? new Date(lastSync).toISOString() : null,
      last_sync_days_ago: lastSyncDays,
      has_integration_error: hasError,
      ai_queries_today:  aiQueriesToday,
      setup_requested:   setupRequested,
      setup_data:        setupData,
      stage,
    }
  })

  // Counts per stage for the header chips
  const counts = {
    total:    enriched.length,
    new:      enriched.filter((o: any) => o.stage === 'new').length,
    setup:    enriched.filter((o: any) => o.stage === 'setup').length,
    active:   enriched.filter((o: any) => o.stage === 'active').length,
    at_risk:  enriched.filter((o: any) => o.stage === 'at_risk').length,
    churned:  enriched.filter((o: any) => o.stage === 'churned').length,
  }

  return NextResponse.json({ customers: enriched, counts })
}
