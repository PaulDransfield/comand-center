// @ts-nocheck
// Temporary diagnostic endpoint — compare our data with PK
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.ADMIN_SECRET) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createAdminClient()
  const orgId = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'

  // First re-aggregate Vero to get fresh numbers
  const { aggregateMetrics } = await import('@/lib/sync/aggregate')
  const veroId = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
  let aggResult = null
  try {
    aggResult = await aggregateMetrics(orgId, veroId, '2026-03-01', '2026-03-31')
  } catch (e: any) { aggResult = { error: e.message } }

  // March 2026 data from all sources
  const [monthlyRes, dailyRevRes, staffRes, revLogsRes] = await Promise.all([
    // Summary tables (fresh after re-aggregation above)
    db.from('monthly_metrics').select('*').eq('year', 2026).eq('month', 3).eq('business_id', veroId),
    // Raw revenue_logs for March — Vero only
    db.from('revenue_logs').select('revenue_date, revenue, provider, business_id')
      .eq('org_id', orgId).eq('business_id', '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99')
      .gte('revenue_date', '2026-03-01').lte('revenue_date', '2026-03-31'),
    // Raw staff_logs for March — Vero only to match PK "Hela företaget"
    db.from('staff_logs').select('shift_date, cost_actual, estimated_salary, hours_worked, business_id')
      .eq('org_id', orgId).eq('business_id', '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99')
      .gte('shift_date', '2026-03-01').lte('shift_date', '2026-03-31')
      .or('cost_actual.gt.0,estimated_salary.gt.0')
      .limit(5000),
    // Revenue providers breakdown
    db.from('revenue_logs').select('provider, business_id')
      .eq('org_id', orgId).gte('revenue_date', '2026-03-01').lte('revenue_date', '2026-03-31'),
  ])

  // Analyze raw revenue by provider
  const revByProvider: Record<string, { count: number, total: number }> = {}
  for (const r of dailyRevRes.data ?? []) {
    const p = r.provider ?? 'unknown'
    if (!revByProvider[p]) revByProvider[p] = { count: 0, total: 0 }
    revByProvider[p].count++
    revByProvider[p].total += r.revenue ?? 0
  }

  // Deduped revenue (skip personalkollen when pk_* exists)
  const rawRevRows = dailyRevRes.data ?? []
  const hasDeptRows = rawRevRows.some(r => (r.provider ?? '').startsWith('pk_') || (r.provider ?? '').startsWith('inzii_'))
  const deduped = hasDeptRows ? rawRevRows.filter(r => (r.provider ?? '') !== 'personalkollen') : rawRevRows
  const dedupedTotal = deduped.reduce((s, r) => s + (r.revenue ?? 0), 0)

  // Raw staff totals
  const staffRows = staffRes.data ?? []
  const totalStaffCost = staffRows.reduce((s, r) => {
    const cost = Number(r.cost_actual ?? 0) > 0 ? Number(r.cost_actual) : Number(r.estimated_salary ?? 0)
    return s + cost
  }, 0)
  const totalHours = staffRows.reduce((s, r) => s + Number(r.hours_worked ?? 0), 0)

  // Fetch a sample sale from PK to check if items have categories
  let sampleSale = null
  try {
    const { data: integ } = await db.from('integrations').select('credentials_enc').eq('id', '2475e1ef-a4d9-4442-ab50-bffe4e831258').single()
    if (integ) {
      const { decrypt } = await import('@/lib/integrations/encryption')
      const token = decrypt(integ.credentials_enc)
      const { getSales } = await import('@/lib/pos/personalkollen')
      const sales = await getSales(token, '2026-03-15', '2026-03-16')
      if (sales.length > 0) {
        sampleSale = { count: sales.length, first: sales[0], amounts: { amount: sales[0].amount, amount_gross: sales[0].amount_gross, food: sales[0].food_revenue, drink: sales[0].drink_revenue } }
      }
    }
  } catch (e: any) { sampleSale = { error: e.message } }

  return NextResponse.json({
    sample_sale: sampleSale,
    aggregation_result: aggResult,
    pk_reference: {
      revenue: 1422650,
      staff_cost: 582571,
      staff_pct: 41,
      hours: 2390,
      rev_per_hour: 595,
      note: 'From Personalkollen dashboard, March 2026, Hela företaget'
    },
    our_monthly_metrics: (monthlyRes.data ?? []).map(m => ({
      business_id: m.business_id,
      revenue: m.revenue,
      staff_cost: m.staff_cost,
      hours: m.hours_worked,
      labour_pct: m.labour_pct,
    })),
    raw_revenue: {
      by_provider: revByProvider,
      total_all_providers: rawRevRows.reduce((s, r) => s + (r.revenue ?? 0), 0),
      total_deduped: Math.round(dedupedTotal),
      dedup_applied: hasDeptRows,
      row_count: rawRevRows.length,
    },
    raw_staff: {
      total_cost: Math.round(totalStaffCost),
      total_hours: Math.round(totalHours * 10) / 10,
      row_count: staffRows.length,
    },
    comparison: {
      our_rev_vs_pk: `${Math.round(dedupedTotal)} vs ${1422650} (diff: ${Math.round(dedupedTotal - 1422650)})`,
      our_staff_vs_pk: `${Math.round(totalStaffCost)} vs ${582571} (diff: ${Math.round(totalStaffCost - 582571)})`,
      our_hours_vs_pk: `${Math.round(totalHours)} vs ${2390} (diff: ${Math.round(totalHours - 2390)})`,
    }
  })
}
