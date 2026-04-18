// @ts-nocheck
// app/api/ai/usage/route.ts
//
// Customer-facing AI usage meter. Powers the sidebar badge and the AskAI
// warning banner. Returns today's count, the effective daily cap, whether
// a Booster is active, and whether they're approaching the limit.
//
// GET /api/ai/usage

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { getEffectiveDailyLimit }    from '@/lib/ai/usage'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const today = new Date().toISOString().slice(0, 10)

  // Today's usage
  const { data: usage, error: usageErr } = await db
    .from('ai_usage_daily')
    .select('query_count, org_id, date')
    .eq('org_id', auth.orgId)
    .eq('date', today)
    .maybeSingle()

  const used = usage?.query_count ?? 0

  // Also peek at whatever rows exist for this org (ignoring date) so we can
  // see if it's a date-matching issue vs org-matching issue.
  const { data: anyRows } = await db
    .from('ai_usage_daily')
    .select('date, query_count')
    .eq('org_id', auth.orgId)
    .order('date', { ascending: false })
    .limit(3)

  console.log('[ai-usage] debug', {
    auth_orgId:   auth.orgId,
    auth_userId:  auth.userId,
    auth_plan:    auth.plan,
    today,
    row_found:    !!usage,
    row_count:    used,
    err:          usageErr?.message ?? null,
    latest_rows:  anyRows,
  })

  // Effective cap (plan base + active Boosters)
  const { base, booster, total: limit } = await getEffectiveDailyLimit(db, auth.orgId, auth.plan)

  // Monthly cost-to-date
  const monthStart = new Date()
  monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0)
  const { data: monthRows } = await db
    .from('ai_request_log')
    .select('cost_sek')
    .eq('org_id', auth.orgId)
    .gte('created_at', monthStart.toISOString())
  const monthCostSek = (monthRows ?? []).reduce((s: number, r: any) => s + Number(r.cost_sek ?? 0), 0)

  const percent = limit > 0 ? Math.round((used / limit) * 100) : 0

  return NextResponse.json({
    plan:        auth.plan,
    used,
    limit,
    base,
    booster,
    percent,
    warning:     percent >= 80,
    blocked:     used >= limit,
    month_cost_sek: Math.round(monthCostSek * 100) / 100,
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  })
}
