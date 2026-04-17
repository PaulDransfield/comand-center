// @ts-nocheck
// app/api/admin/customers/[orgId]/route.ts
// Everything needed to render the customer god-page in one shot.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkAdminSecret } from '@/lib/admin/check-secret'

export const dynamic = 'force-dynamic'

function checkAuth(req: NextRequest): boolean {
  return checkAdminSecret(req)
}

export async function GET(req: NextRequest, { params }: { params: { orgId: string } }) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const orgId = params.orgId
  const db = createAdminClient()
  const todayStr = new Date().toISOString().slice(0, 10)
  const firstOfMonth = todayStr.slice(0, 8) + '01'

  const [org, members, bizs, integs, onboarding, notes, alerts, aiToday, aiMonth, staffCount, revCount] = await Promise.all([
    db.from('organisations').select('*').eq('id', orgId).maybeSingle(),
    db.from('organisation_members').select('user_id, role, created_at').eq('org_id', orgId),
    db.from('businesses').select('id, name, city, is_active, created_at').eq('org_id', orgId),
    db.from('integrations').select('id, provider, status, business_id, last_sync_at, last_error, department, created_at, updated_at').eq('org_id', orgId),
    db.from('onboarding_progress').select('*').eq('org_id', orgId).maybeSingle(),
    db.from('support_notes').select('*').eq('org_id', orgId).order('created_at', { ascending: false }),
    db.from('anomaly_alerts').select('severity, title, created_at, is_read, is_dismissed').eq('org_id', orgId).order('created_at', { ascending: false }).limit(10),
    db.from('ai_usage_daily').select('query_count').eq('org_id', orgId).eq('date', todayStr).maybeSingle(),
    db.from('ai_usage_daily').select('query_count').eq('org_id', orgId).gte('date', firstOfMonth),
    db.from('staff_logs').select('id', { count: 'exact', head: true }).eq('org_id', orgId),
    db.from('revenue_logs').select('id', { count: 'exact', head: true }).eq('org_id', orgId),
  ])

  if (!org.data) return NextResponse.json({ error: 'Organisation not found' }, { status: 404 })

  // Fetch emails for each member via auth admin API
  const memberRows: any[] = []
  for (const m of members.data ?? []) {
    const { data: { user } } = await db.auth.admin.getUserById(m.user_id)
    memberRows.push({
      user_id:       m.user_id,
      role:          m.role,
      member_since:  m.created_at,
      email:         user?.email ?? null,
      last_sign_in:  user?.last_sign_in_at ?? null,
      email_confirmed_at: user?.email_confirmed_at ?? null,
    })
  }

  // Data health — raw counts + last timestamps per business
  const dataHealth = {
    staff_logs_total:   staffCount.count ?? 0,
    revenue_logs_total: revCount.count  ?? 0,
    businesses_total:   (bizs.data ?? []).length,
    businesses_active:  (bizs.data ?? []).filter((b: any) => b.is_active).length,
  }

  // AI usage this month
  const aiMonthTotal = (aiMonth.data ?? []).reduce((s: number, r: any) => s + Number(r.query_count ?? 0), 0)
  const aiTodayTotal = Number(aiToday.data?.query_count ?? 0)

  return NextResponse.json({
    org:        org.data,
    members:    memberRows,
    businesses: bizs.data ?? [],
    integrations: integs.data ?? [],
    onboarding: onboarding.data ?? null,
    support_notes: notes.data ?? [],
    recent_alerts: alerts.data ?? [],
    ai_usage: {
      today: aiTodayTotal,
      month: aiMonthTotal,
    },
    data_health: dataHealth,
  })
}
