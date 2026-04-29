// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { decrypt }                   from '@/lib/integrations/encryption'
import { requireFinanceAccess, requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const getAuth = getRequestAuth

export async function GET(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // M043: forecast is finance — manager without can_view_finances denied.
  const finForbidden = requireFinanceAccess(auth)
  if (finForbidden) return finForbidden

  const businessId = new URL(req.url).searchParams.get('business_id')
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const bizForbidden = requireBusinessAccess(auth, businessId)
  if (bizForbidden) return bizForbidden

  const db   = createAdminClient()
  const year = new Date().getFullYear()

  // Get our generated forecasts
  const { data: forecasts } = await db
    .from('forecasts')
    .select('*')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .in('period_year', [year, year + 1])
    .order('period_year')
    .order('period_month')

  // Get actuals from monthly_metrics (auto-aggregated from real POS + PK syncs).
  // Previously we read tracker_data, but that table only holds manual P&L entries
  // and misses every auto-synced month. monthly_metrics is the source of truth.
  // Fall back to tracker_data for any month monthly_metrics doesn't have (legacy manual entries).
  const [mmRes, trRes] = await Promise.all([
    db.from('monthly_metrics')
      .select('year, month, revenue, staff_cost, food_cost, net_profit, margin_pct')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .in('year', [year - 1, year, year + 1])
      .order('year')
      .order('month'),
    db.from('tracker_data')
      .select('period_year, period_month, revenue, staff_cost, food_cost, net_profit, margin_pct')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .in('period_year', [year - 1, year, year + 1])
      .order('period_year')
      .order('period_month'),
  ])

  // Map monthly_metrics → tracker_data shape (page expects period_year/period_month)
  const mmRows = (mmRes.data ?? []).map((r: any) => ({
    period_year:  r.year,
    period_month: r.month,
    revenue:      r.revenue,
    staff_cost:   r.staff_cost,
    food_cost:    r.food_cost,
    net_profit:   r.net_profit,
    margin_pct:   r.margin_pct,
  }))

  // Merge: monthly_metrics wins over tracker_data for the same (year, month)
  const actualsByKey = new Map<string, any>()
  for (const t of trRes.data ?? []) actualsByKey.set(`${t.period_year}-${t.period_month}`, t)
  for (const m of mmRows)           actualsByKey.set(`${m.period_year}-${m.period_month}`, m)
  const actuals = [...actualsByKey.values()].sort((a, b) =>
    a.period_year !== b.period_year ? a.period_year - b.period_year : a.period_month - b.period_month
  )

  // Get Personalkollen sale forecasts if connected
  let pkForecasts: any[] = []
  const { data: integ } = await db
    .from('integrations')
    .select('credentials_enc')
    .eq('org_id', auth.orgId)
    .eq('provider', 'personalkollen')
    .eq('status', 'connected')
    .maybeSingle()

  if (integ?.credentials_enc) {
    try {
      const { getSaleForecast } = await import('@/lib/pos/personalkollen')
      const token = decrypt(integ.credentials_enc)
      const now   = new Date()
      const from  = `${year}-${String(now.getMonth() + 1).padStart(2,'0')}-01`
      const to    = `${year}-12-31`
      pkForecasts = await getSaleForecast(token, from, to)
    } catch {}
  }

  return NextResponse.json({ forecasts: forecasts ?? [], actuals: actuals ?? [], pk_forecasts: pkForecasts })
}
