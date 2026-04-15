// @ts-nocheck
// app/api/stripe/usage/route.ts
//
// Returns current usage data for the authenticated org.
// Used by the upgrade page to show usage meters.
//
// GET /api/stripe/usage
// Returns: { plan, trialDaysLeft, hasSubscription, costUsdThisMonth, meters }

import { NextRequest, NextResponse } from 'next/server'
import { getOrgFromRequest }         from '@/lib/auth/get-org'
import { createAdminClient }         from '@/lib/supabase/server'
import { getLimits }                 from '@/lib/stripe/config'

export async function GET(req: NextRequest) {
  const auth = await getOrgFromRequest(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const supabase  = createAdminClient()
  const now       = new Date()
  const month     = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`
  const monthStart= new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

  // Get org plan + trial info
  const { data: org } = await supabase
    .from('organisations')
    .select('plan, trial_end, is_active, stripe_subscription_id')
    .eq('id', auth.orgId)
    .single()

  const plan   = org?.plan ?? 'trial'
  const limits = getLimits(plan)

  // Run all usage counts in parallel â€” much faster than sequential queries
  const [bizR, docR, usageR, memberR, audioR, schedR] = await Promise.all([
    supabase.from('businesses').select('id', {count:'exact',head:true}).eq('org_id',auth.orgId).eq('is_active',true),
    supabase.from('notebook_documents').select('id', {count:'exact',head:true}).eq('org_id',auth.orgId),
    supabase.from('ai_usage').select('total_tokens,total_requests,total_cost_usd').eq('org_id',auth.orgId).eq('month',month).maybeSingle(),
    supabase.from('organisation_members').select('id', {count:'exact',head:true}).eq('org_id',auth.orgId),
    supabase.from('ai_request_log').select('id', {count:'exact',head:true}).eq('org_id',auth.orgId).eq('request_type','audio_script').gte('created_at',monthStart),
    supabase.from('export_schedules').select('id', {count:'exact',head:true}).eq('org_id',auth.orgId).eq('is_active',true),
  ])

  function meter(used: number, limit: number) {
    const pct       = limit === Infinity ? 0 : Math.min(100, Math.round(used / limit * 100))
    return { used, limit, pct, nearLimit: pct >= 80, atLimit: used >= limit }
  }

  const u = usageR.data

  const trialEnd      = org?.trial_end ? new Date(org.trial_end) : null
  const trialDaysLeft = trialEnd ? Math.max(0, Math.ceil((trialEnd.getTime() - now.getTime()) / 86400000)) : null

  return NextResponse.json({
    plan,
    trialDaysLeft,
    hasSubscription:  !!org?.stripe_subscription_id,
    costUsdThisMonth: parseFloat(u?.total_cost_usd ?? '0'),
    meters: {
      businesses:       meter(bizR.count    ?? 0, limits.businesses),
      documents:        meter(docR.count    ?? 0, limits.documents),
      monthly_tokens:   meter(u?.total_tokens    ?? 0, limits.monthly_tokens),
      monthly_requests: meter(u?.total_requests  ?? 0, limits.monthly_requests),
      team_members:     meter(memberR.count ?? 0, limits.team_members),
      audio_overviews:  meter(audioR.count  ?? 0, limits.audio_overviews),
      export_schedules: meter(schedR.count  ?? 0, limits.export_schedules),
    },
  })
}
