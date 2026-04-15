// lib/alerts/detector.ts
// Anomaly detection engine — runs daily via cron
// Compares current metrics against rolling 4-week averages

import { createAdminClient } from '@/lib/supabase/server'

interface Alert {
  org_id:         string
  business_id:    string
  alert_type:     string
  severity:       'low' | 'medium' | 'high' | 'critical'
  title:          string
  description:    string
  metric_value:   number
  expected_value: number
  deviation_pct:  number
  period_date:    string
}

function severity(deviationPct: number, thresholds: [number, number, number]): 'low' | 'medium' | 'high' | 'critical' {
  const abs = Math.abs(deviationPct)
  if (abs >= thresholds[2]) return 'critical'
  if (abs >= thresholds[1]) return 'high'
  if (abs >= thresholds[0]) return 'medium'
  return 'low'
}

export async function runAnomalyDetection(orgId?: string): Promise<Alert[]> {
  const db      = createAdminClient()
  const today   = new Date()
  const alerts: Alert[] = []

  // Get orgs to check
  let orgsQuery = db.from('organisations').select('id, name').eq('is_active', true)
  if (orgId) orgsQuery = orgsQuery.eq('id', orgId)
  const { data: orgs } = await orgsQuery
  if (!orgs?.length) return []

  for (const org of orgs) {
    const { data: businesses } = await db
      .from('businesses')
      .select('id, name')
      .eq('org_id', org.id)
      .eq('is_active', true)

    if (!businesses?.length) continue

    for (const biz of businesses) {
      const bizAlerts = await checkBusiness(db, org.id, biz.id, biz.name, today)
      alerts.push(...bizAlerts)
    }
  }

  // Save new alerts to DB (avoid duplicates for same day)
  if (alerts.length > 0) {
    const todayStr = today.toISOString().slice(0, 10)
    for (const alert of alerts) {
      // Check if this alert already exists for today
      const { data: existing } = await db
        .from('anomaly_alerts')
        .select('id')
        .eq('business_id', alert.business_id)
        .eq('alert_type', alert.alert_type)
        .eq('period_date', alert.period_date)
        .single()

      if (!existing) {
        await db.from('anomaly_alerts').insert(alert)
      }
    }
  }

  return alerts
}

async function checkBusiness(db: any, orgId: string, bizId: string, bizName: string, today: Date): Promise<Alert[]> {
  const alerts: Alert[] = []
  const year  = today.getFullYear()
  const month = today.getMonth() + 1

  // ── 1. Check revenue and cost metrics from tracker_data ───────────
  // Get current month
  const { data: current } = await db
    .from('tracker_data')
    .select('revenue, food_cost, staff_cost, margin_pct, period_year, period_month')
    .eq('business_id', bizId)
    .eq('period_year', year)
    .eq('period_month', month)
    .single()

  // Get last 4 months for rolling average
  const pastMonths: { year: number; month: number }[] = []
  for (let i = 1; i <= 4; i++) {
    const d = new Date(year, month - 1 - i, 1)
    pastMonths.push({ year: d.getFullYear(), month: d.getMonth() + 1 })
  }

  const { data: history } = await db
    .from('tracker_data')
    .select('revenue, food_cost, staff_cost, period_year, period_month')
    .eq('business_id', bizId)
    .in('period_year', [...new Set(pastMonths.map(m => m.year))])

  const filteredHistory = (history ?? []).filter((r: any) =>
    pastMonths.some(m => m.year === r.period_year && m.month === r.period_month)
  )

  if (current && filteredHistory.length >= 2) {
    const avgRevenue   = filteredHistory.reduce((s: number, r: any) => s + Number(r.revenue ?? 0), 0) / filteredHistory.length
    const avgFoodCost  = filteredHistory.reduce((s: number, r: any) => s + (Number(r.food_cost ?? 0) / Math.max(Number(r.revenue ?? 1), 1)) * 100, 0) / filteredHistory.length
    const avgStaffCost = filteredHistory.reduce((s: number, r: any) => s + (Number(r.staff_cost ?? 0) / Math.max(Number(r.revenue ?? 1), 1)) * 100, 0) / filteredHistory.length

    const curRevenue   = Number(current.revenue ?? 0)
    const curFoodPct   = curRevenue > 0 ? (Number(current.food_cost ?? 0) / curRevenue) * 100 : 0
    const curStaffPct  = curRevenue > 0 ? (Number(current.staff_cost ?? 0) / curRevenue) * 100 : 0

    const periodDate = `${year}-${String(month).padStart(2, '0')}-01`

    // Revenue drop
    if (avgRevenue > 0) {
      const revDev = ((curRevenue - avgRevenue) / avgRevenue) * 100
      if (revDev <= -20) {
        alerts.push({
          org_id: orgId, business_id: bizId,
          alert_type: 'revenue_drop',
          severity: severity(revDev, [20, 30, 40]),
          title: `Revenue down ${Math.abs(revDev).toFixed(0)}% — ${bizName}`,
          description: `Revenue is ${Math.round(curRevenue).toLocaleString('sv-SE')} kr vs ${Math.round(avgRevenue).toLocaleString('sv-SE')} kr average over the last 4 months.`,
          metric_value: curRevenue, expected_value: avgRevenue,
          deviation_pct: revDev, period_date: periodDate,
        })
      }
    }

    // Food cost spike
    if (avgFoodCost > 0) {
      const foodDev = curFoodPct - avgFoodCost
      if (foodDev >= 5) {
        alerts.push({
          org_id: orgId, business_id: bizId,
          alert_type: 'food_cost_spike',
          severity: severity(foodDev, [5, 8, 12]),
          title: `Food cost spike +${foodDev.toFixed(1)}pp — ${bizName}`,
          description: `Food cost is ${curFoodPct.toFixed(1)}% of revenue vs ${avgFoodCost.toFixed(1)}% average. Check recent supplier invoices.`,
          metric_value: curFoodPct, expected_value: avgFoodCost,
          deviation_pct: foodDev, period_date: periodDate,
        })
      }
    }

    // Staff cost spike
    if (avgStaffCost > 0) {
      const staffDev = curStaffPct - avgStaffCost
      if (staffDev >= 5) {
        alerts.push({
          org_id: orgId, business_id: bizId,
          alert_type: 'staff_cost_spike',
          severity: severity(staffDev, [5, 8, 12]),
          title: `Staff cost spike +${staffDev.toFixed(1)}pp — ${bizName}`,
          description: `Staff cost is ${curStaffPct.toFixed(1)}% of revenue vs ${avgStaffCost.toFixed(1)}% average. Check schedules and overtime.`,
          metric_value: curStaffPct, expected_value: avgStaffCost,
          deviation_pct: staffDev, period_date: periodDate,
        })
      }
    }
  }

  // ── 2. Check covers from covers table ────────────────────────────
  const lastWeekEnd   = new Date(today); lastWeekEnd.setDate(today.getDate() - today.getDay())
  const lastWeekStart = new Date(lastWeekEnd); lastWeekStart.setDate(lastWeekEnd.getDate() - 6)

  const { data: lastWeekCovers } = await db
    .from('covers')
    .select('total, revenue, revenue_per_cover')
    .eq('business_id', bizId)
    .gte('date', lastWeekStart.toISOString().slice(0, 10))
    .lte('date', lastWeekEnd.toISOString().slice(0, 10))

  // Get 4-week average
  const fourWeeksAgo = new Date(lastWeekStart); fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28)
  const { data: historicCovers } = await db
    .from('covers')
    .select('total, revenue_per_cover')
    .eq('business_id', bizId)
    .gte('date', fourWeeksAgo.toISOString().slice(0, 10))
    .lt('date', lastWeekStart.toISOString().slice(0, 10))

  if (lastWeekCovers?.length && historicCovers?.length >= 7) {
    const lwTotal    = lastWeekCovers.reduce((s: number, c: any) => s + (c.total ?? 0), 0)
    const lwDays     = lastWeekCovers.length
    const lwAvgDaily = lwTotal / lwDays

    const histAvgDaily = historicCovers.reduce((s: number, c: any) => s + (c.total ?? 0), 0) / historicCovers.length

    if (histAvgDaily > 0) {
      const coversDev = ((lwAvgDaily - histAvgDaily) / histAvgDaily) * 100
      if (coversDev <= -25) {
        alerts.push({
          org_id: orgId, business_id: bizId,
          alert_type: 'covers_drop',
          severity: severity(coversDev, [25, 35, 50]),
          title: `Covers down ${Math.abs(coversDev).toFixed(0)}% last week — ${bizName}`,
          description: `${Math.round(lwAvgDaily)} covers/day last week vs ${Math.round(histAvgDaily)} covers/day 4-week average.`,
          metric_value: lwAvgDaily, expected_value: histAvgDaily,
          deviation_pct: coversDev, period_date: lastWeekEnd.toISOString().slice(0, 10),
        })
      }
    }
  }

  // ── 3. Check invoice spikes ───────────────────────────────────────
  const thirtyDaysAgo = new Date(today); thirtyDaysAgo.setDate(today.getDate() - 30)
  const { data: recentInvoices } = await db
    .from('invoices')
    .select('vendor, amount, created_at')
    .eq('business_id', bizId)
    .gte('created_at', thirtyDaysAgo.toISOString())
    .order('created_at', { ascending: false })

  if (recentInvoices?.length) {
    // Group by vendor and check latest vs vendor average
    const byVendor: Record<string, number[]> = {}
    for (const inv of recentInvoices) {
      const vendor = inv.vendor?.toLowerCase() ?? 'unknown'
      if (!byVendor[vendor]) byVendor[vendor] = []
      byVendor[vendor].push(Number(inv.amount ?? 0))
    }

    for (const [vendor, amounts] of Object.entries(byVendor)) {
      if (amounts.length < 2) continue
      const latest = amounts[0]
      const avgPrev = amounts.slice(1).reduce((s, a) => s + a, 0) / (amounts.length - 1)
      if (avgPrev > 0 && latest > avgPrev * 3) {
        const dev = ((latest - avgPrev) / avgPrev) * 100
        alerts.push({
          org_id: orgId, business_id: bizId,
          alert_type: 'invoice_spike',
          severity: 'high',
          title: `Unusual invoice from ${vendor} — ${bizName}`,
          description: `Latest invoice ${Math.round(latest).toLocaleString('sv-SE')} kr is ${dev.toFixed(0)}% higher than usual (avg ${Math.round(avgPrev).toLocaleString('sv-SE')} kr). Check for errors.`,
          metric_value: latest, expected_value: avgPrev,
          deviation_pct: dev, period_date: today.toISOString().slice(0, 10),
        })
      }
    }
  }

  return alerts
}
