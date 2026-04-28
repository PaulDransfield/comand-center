// app/api/admin/v2/customers/[orgId]/data/route.ts
//
// READ-ONLY data freshness probes for the Data sub-tab. Per business:
//   - Latest revenue_logs date + row count last 30d
//   - Latest staff_logs date + row count last 30d
//   - Latest daily_metrics date
//   - Latest monthly_metrics row + count of months covered current year
//   - Latest tracker_data row
//
// Surfaces "the aggregator hasn't run since X" or "PK hasn't pushed
// data since Y" gaps that would be invisible from the integrations
// status alone.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const DAY_MS = 86_400_000

export async function GET(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  const db = createAdminClient()
  const now = Date.now()
  const thirtyAgo = new Date(now - 30 * DAY_MS).toISOString().slice(0, 10)
  const yearNow   = new Date().getUTCFullYear()

  // Get the businesses first.
  const { data: bizList } = await db
    .from('businesses')
    .select('id, name')
    .eq('org_id', orgId)
    .order('name', { ascending: true })

  const businesses: any[] = []
  for (const b of bizList ?? []) {
    const [revLatest, revCount, staffLatest, staffCount, dailyLatest, monthlyRows, trackerLatest] = await Promise.all([
      db.from('revenue_logs')
        .select('revenue_date')
        .eq('business_id', b.id)
        .order('revenue_date', { ascending: false })
        .limit(1)
        .maybeSingle(),
      db.from('revenue_logs')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', b.id)
        .gte('revenue_date', thirtyAgo),
      db.from('staff_logs')
        .select('shift_date')
        .eq('business_id', b.id)
        .order('shift_date', { ascending: false })
        .limit(1)
        .maybeSingle(),
      db.from('staff_logs')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', b.id)
        .gte('shift_date', thirtyAgo),
      db.from('daily_metrics')
        .select('date, updated_at')
        .eq('business_id', b.id)
        .order('date', { ascending: false })
        .limit(1)
        .maybeSingle(),
      db.from('monthly_metrics')
        .select('year, month, updated_at')
        .eq('business_id', b.id)
        .eq('year', yearNow)
        .order('month', { ascending: true }),
      db.from('tracker_data')
        .select('period_year, period_month, source, updated_at')
        .eq('business_id', b.id)
        .order('period_year', { ascending: false })
        .order('period_month', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])
    businesses.push({
      id: b.id,
      name: b.name,
      revenue_logs: {
        latest_date:    revLatest.data?.revenue_date ?? null,
        rows_last_30d:  revCount.count ?? 0,
        age_days:       revLatest.data?.revenue_date
          ? Math.floor((now - new Date(revLatest.data.revenue_date + 'T23:59:59Z').getTime()) / DAY_MS)
          : null,
      },
      staff_logs: {
        latest_date:    staffLatest.data?.shift_date ?? null,
        rows_last_30d:  staffCount.count ?? 0,
        age_days:       staffLatest.data?.shift_date
          ? Math.floor((now - new Date(staffLatest.data.shift_date + 'T23:59:59Z').getTime()) / DAY_MS)
          : null,
      },
      daily_metrics: {
        latest_date:    dailyLatest.data?.date ?? null,
        last_aggregated: dailyLatest.data?.updated_at ?? null,
        age_days:       dailyLatest.data?.date
          ? Math.floor((now - new Date(dailyLatest.data.date + 'T23:59:59Z').getTime()) / DAY_MS)
          : null,
      },
      monthly_metrics: {
        months_in_year:  (monthlyRows.data ?? []).length,
        latest_month:    (monthlyRows.data ?? []).slice(-1)[0]?.month ?? null,
        last_aggregated: (monthlyRows.data ?? []).reduce((m: string, r: any) => r.updated_at > m ? r.updated_at : m, ''),
      },
      tracker_data: {
        latest_period: trackerLatest.data
          ? `${trackerLatest.data.period_year}-${String(trackerLatest.data.period_month ?? 0).padStart(2, '0')}`
          : null,
        latest_source: trackerLatest.data?.source ?? null,
        last_updated:  trackerLatest.data?.updated_at ?? null,
      },
    })
  }

  return NextResponse.json({
    businesses,
    generated_at: new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
