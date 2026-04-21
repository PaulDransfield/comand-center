// @ts-nocheck
// app/api/admin/diagnose-day/route.ts
//
// Answers "where did my data go?" for one business × one date. Pulls the raw
// rows at every layer of the pipeline so we can tell instantly which stage
// failed:
//
//   1. revenue_logs       — POS sync landed?
//   2. staff_logs         — PK shift sync landed?
//   3. daily_metrics      — aggregator ran for that day?
//   4. sync_log (24h)     — any errors/timeouts/skips on this biz's integrations?
//   5. integrations       — last_sync_at per integration (did the cron fire?)
//
// GET /api/admin/diagnose-day?business_id=UUID&date=YYYY-MM-DD
// Auth: x-admin-secret header

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkAdminSecret }          from '@/lib/admin/check-secret'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  if (!checkAdminSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const u     = new URL(req.url)
  const bizId = u.searchParams.get('business_id')
  const date  = u.searchParams.get('date') ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  if (!bizId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()

  const { data: biz } = await db.from('businesses').select('id, name, org_id').eq('id', bizId).maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  const dayStart = `${date}T00:00:00`
  const dayEnd   = `${date}T23:59:59`
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const [revLogs, staffLogs, dailyMetric, integrations, syncLog] = await Promise.all([
    db.from('revenue_logs')
      .select('provider, revenue, covers, food_revenue, bev_revenue, dine_in_revenue, takeaway_revenue, tip_revenue, transactions')
      .eq('business_id', bizId)
      .eq('revenue_date', date),
    db.from('staff_logs')
      .select('provider, staff_name, staff_group, hours_worked, cost_actual, estimated_salary, pk_log_url')
      .eq('business_id', bizId)
      .eq('shift_date', date),
    db.from('daily_metrics')
      .select('*')
      .eq('business_id', bizId)
      .eq('date', date)
      .maybeSingle(),
    db.from('integrations')
      .select('id, provider, status, department, last_sync_at, last_error')
      .eq('business_id', bizId)
      .order('last_sync_at', { ascending: false }),
    db.from('sync_log')
      .select('provider, integration_id, status, created_at, error, date_from, date_to, rows_synced')
      .eq('org_id', biz.org_id)
      .gte('created_at', yesterday)
      .order('created_at', { ascending: false })
      .limit(50),
  ])

  // Roll up revenue_logs by provider
  const revByProvider: Record<string, any> = {}
  for (const r of revLogs.data ?? []) {
    const p = r.provider
    if (!revByProvider[p]) revByProvider[p] = { provider: p, revenue: 0, covers: 0, takeaway: 0, dine_in: 0, food: 0, bev: 0, tip: 0, tx: 0, rows: 0 }
    revByProvider[p].revenue  += Number(r.revenue  ?? 0)
    revByProvider[p].covers   += Number(r.covers   ?? 0)
    revByProvider[p].takeaway += Number(r.takeaway_revenue ?? 0)
    revByProvider[p].dine_in  += Number(r.dine_in_revenue  ?? 0)
    revByProvider[p].food     += Number(r.food_revenue     ?? 0)
    revByProvider[p].bev      += Number(r.bev_revenue      ?? 0)
    revByProvider[p].tip      += Number(r.tip_revenue      ?? 0)
    revByProvider[p].tx       += Number(r.transactions     ?? 0)
    revByProvider[p].rows     += 1
  }
  const revTotal = Object.values(revByProvider).reduce((s: number, r: any) => s + r.revenue, 0)

  // Roll up staff_logs (exclude scheduled-only rows — those aren't actuals)
  const actualShifts = (staffLogs.data ?? []).filter((s: any) => !String(s.pk_log_url ?? '').endsWith('_scheduled'))
  const scheduledShifts = (staffLogs.data ?? []).filter((s: any) =>  String(s.pk_log_url ?? '').endsWith('_scheduled'))
  const staffSummary = {
    actual_shifts:    actualShifts.length,
    scheduled_shifts: scheduledShifts.length,
    total_hours:      Math.round(actualShifts.reduce((s: number, r: any) => s + Number(r.hours_worked ?? 0), 0) * 10) / 10,
    total_cost:       Math.round(actualShifts.reduce((s: number, r: any) => s + (Number(r.cost_actual) > 0 ? Number(r.cost_actual) : Number(r.estimated_salary ?? 0)), 0)),
  }

  // Verdict — quick heuristic for what likely failed
  const verdict: string[] = []
  if (!(revLogs.data ?? []).length && !(staffLogs.data ?? []).length) {
    verdict.push('No revenue_logs AND no staff_logs for this date — the sync did not land any raw data. Check integration last_sync_at + sync_log for errors.')
  } else if (!(revLogs.data ?? []).length) {
    verdict.push('No revenue_logs (POS data) for this date. PK per-workplace sales sync did not pull anything. Likely PK hadn\'t finalised the day at sync time, or the cron hasn\'t run yet.')
  } else if (!(staffLogs.data ?? []).length) {
    verdict.push('No staff_logs for this date. PK shifts sync did not pull anything.')
  }
  if (revTotal > 0 && !dailyMetric.data) {
    verdict.push('revenue_logs has rows but daily_metrics DOES NOT — the aggregator did not run for this date. Re-run sync to trigger aggregateMetrics.')
  }
  if (dailyMetric.data && Number(dailyMetric.data.revenue ?? 0) === 0 && revTotal > 0) {
    verdict.push(`daily_metrics.revenue is 0 but revenue_logs sum to ${Math.round(revTotal).toLocaleString('en-GB')} kr. Aggregator ran but produced wrong total.`)
  }
  const anyInteg = (integrations.data ?? []).filter((i: any) => i.status === 'connected')
  if (anyInteg.length > 0) {
    const mostRecent = anyInteg.map((i: any) => i.last_sync_at).filter(Boolean).sort().pop()
    if (mostRecent && new Date(mostRecent) < new Date(dayStart)) {
      verdict.push(`Most-recent connected sync (${mostRecent}) is before the target date — no sync has touched this day yet.`)
    }
  }

  return NextResponse.json({
    business_id:   bizId,
    business_name: biz.name,
    date,
    verdict,
    totals: {
      revenue_logs_rows:  (revLogs.data ?? []).length,
      revenue_total:      Math.round(revTotal),
      staff_logs_rows:    (staffLogs.data ?? []).length,
      daily_metric_exists: !!dailyMetric.data,
    },
    revenue_by_provider: Object.values(revByProvider),
    staff_summary:       staffSummary,
    daily_metric:        dailyMetric.data ?? null,
    integrations:        integrations.data ?? [],
    recent_sync_log:     syncLog.data ?? [],
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}
