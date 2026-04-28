// app/api/admin/v2/customers/[orgId]/snapshot/route.ts
//
// READ-ONLY snapshot for the customer-detail Snapshot tab.
//
// Returns a compact payload — KPIs + recent uploads + recent admin actions
// — sized for fast first paint. Other sub-tabs fetch their own data
// (integrations, data freshness, etc.) so we don't ship a megabyte
// payload that the user might never need.
//
// Auth: requireAdmin (verifies orgId exists and ADMIN_SECRET matches).

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { getPlan }                   from '@/lib/stripe/config'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  const db = createAdminClient()
  const todayStr = new Date().toISOString().slice(0, 10)
  const monthStart = new Date()
  monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0)

  const [orgRes, bizRes, uploadsRes, aiTodayRes, aiMonthRes, auditRes] = await Promise.all([
    db.from('organisations')
      .select('id, name, plan, is_active, trial_end, created_at, billing_email, stripe_customer_id, stripe_subscription_id')
      .eq('id', orgId)
      .maybeSingle(),
    db.from('businesses')
      .select('id, name, city, is_active, created_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: true }),
    db.from('fortnox_uploads')
      .select('id, business_id, doc_type, status, period_year, period_month, applied_at, created_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(5),
    db.from('ai_usage_daily')
      .select('query_count')
      .eq('org_id', orgId)
      .eq('date', todayStr)
      .maybeSingle(),
    db.from('ai_request_log')
      .select('cost_sek')
      .eq('org_id', orgId)
      .gte('created_at', monthStart.toISOString())
      .limit(5000),
    db.from('admin_audit_log')
      .select('action, actor, target_type, target_id, payload, created_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(5),
  ])

  if (!orgRes.data) {
    return NextResponse.json({ error: 'Organisation not found' }, { status: 404 })
  }

  const plan        = getPlan(orgRes.data.plan ?? 'trial')
  const aiToday     = Number(aiTodayRes.data?.query_count ?? 0)
  const aiCap       = plan.ai_queries_per_day === Infinity ? null : (plan.ai_queries_per_day || null)
  const aiMonthSek  = (aiMonthRes.data ?? []).reduce((s: number, r: any) => s + Number(r.cost_sek ?? 0), 0)

  return NextResponse.json({
    org: {
      id:                     orgRes.data.id,
      name:                   orgRes.data.name,
      plan:                   orgRes.data.plan ?? 'trial',
      is_active:              orgRes.data.is_active,
      trial_end:              orgRes.data.trial_end,
      created_at:             orgRes.data.created_at,
      billing_email:          orgRes.data.billing_email,
      stripe_customer_id:     orgRes.data.stripe_customer_id,
      stripe_subscription_id: orgRes.data.stripe_subscription_id,
      mrr_sek:                plan.price_sek ?? 0,
    },
    businesses:        bizRes.data ?? [],
    recent_uploads:    uploadsRes.data ?? [],
    recent_audit:      auditRes.data ?? [],
    ai: {
      queries_today:    aiToday,
      daily_cap:        aiCap,
      pct_of_cap:       aiCap && aiCap > 0 ? Math.round((aiToday / aiCap) * 100) : null,
      monthly_cost_sek: Math.round(aiMonthSek * 100) / 100,
    },
  }, { headers: { 'Cache-Control': 'no-store' } })
}
