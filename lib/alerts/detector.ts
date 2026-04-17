// lib/alerts/detector.ts
// Anomaly detection engine — runs daily via cron
// Compares current metrics against rolling 4-week averages
// Follows spec in claude_code_agents_prompt.md

import { createAdminClient } from '@/lib/supabase/server'
import { AI_MODELS, MAX_TOKENS } from '@/lib/ai/models'

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

async function explainAnomalyDescriptions(alerts: Alert[], businessName: string) {
  if (!process.env.ANTHROPIC_API_KEY || !alerts.length) return

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

    for (const alert of alerts) {
      const prompt = `You are analysing restaurant financial data for ${businessName}. Write ONE sentence explaining this anomaly to a restaurant owner. Be specific, practical, and suggest a likely cause.

Anomaly type: ${alert.alert_type}
Title: ${alert.title}
Metric value: ${alert.metric_value}
Expected value: ${alert.expected_value}
Deviation: ${Math.abs(alert.deviation_pct).toFixed(1)}%
Period: ${alert.period_date}

Write only one sentence. No preamble.`

      try {
        const response = await claude.messages.create({
          model:      AI_MODELS.AGENT,
          max_tokens: MAX_TOKENS.AGENT_EXPLANATION,
          messages:   [{ role: 'user', content: prompt }],
        })
        const text = (response.content?.[0] as any)?.text?.trim()
        if (text) alert.description = text
      } catch (err: any) {
        console.error('AI anomaly explanation failed:', err)
      }
    }
  } catch (err: any) {
    console.error('Failed to load Anthropic SDK for anomaly explanations:', err)
  }
}

async function sendCriticalAlertEmail(alert: Alert, businessName: string, ownerEmail: string) {
  if (!process.env.RESEND_API_KEY || alert.severity !== 'critical') return

  try {
    const subject = `Critical Alert: ${businessName} — ${alert.title}`
    const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif">
        <div style="max-width:600px;margin:0 auto;padding:24px 12px">
          <div style="background:#ffffff;border:1px solid #dc2626;border-radius:12px;padding:24px;margin-bottom:16px">
            <div style="display:inline-block;background:#dc2626;color:white;font-weight:800;font-size:12px;letter-spacing:.05em;border-radius:6px;padding:4px 10px;margin-bottom:14px">CRITICAL ALERT</div>
            <h1 style="font-family:Georgia,serif;font-size:20px;color:#111827;margin:0 0 8px">${businessName}</h1>
            <h2 style="font-size:16px;font-weight:600;color:#dc2626;margin:0 0 16px">${alert.title}</h2>
            
            <div style="background:#fef2f2;border-radius:8px;padding:16px;margin-bottom:16px">
              <div style="font-size:14px;color:#111827;margin-bottom:8px">${alert.description}</div>
              <div style="font-size:12px;color:#6b7280">
                <div>Metric: ${alert.metric_value.toLocaleString('en-GB')}</div>
                <div>Expected: ${alert.expected_value.toLocaleString('en-GB')}</div>
                <div>Deviation: ${Math.abs(alert.deviation_pct).toFixed(1)}%</div>
                <div>Period: ${alert.period_date}</div>
              </div>
            </div>
            
            <div style="text-align:center;padding-top:16px;border-top:1px solid #e5e7eb">
              <a href="https://comandcenter.se/alerts" style="display:inline-block;background:#1e3a5f;color:white;font-weight:600;font-size:14px;text-decoration:none;border-radius:8px;padding:10px 20px">View in CommandCenter</a>
            </div>
          </div>
          
          <div style="text-align:center;padding:20px 0;border-top:1px solid #e5e7eb;margin-top:8px">
            <p style="font-size:11px;color:#9ca3af;margin:0">CommandCenter — Restaurant Intelligence Platform</p>
          </div>
        </div>
      </body>
      </html>`

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'CommandCenter <alerts@comandcenter.se>',
        to: [ownerEmail],
        subject,
        html,
      }),
    })

    console.log(`Critical alert email sent to ${ownerEmail} for ${businessName}`)
  } catch (err: any) {
    console.error('Failed to send critical alert email:', err)
  }
}

export async function runAnomalyDetection(orgId?: string): Promise<Alert[]> {
  const db      = createAdminClient()
  const today   = new Date()
  const alerts: Alert[] = []

  // Get orgs to check
  let orgsQuery = db.from('organisations').select('id, name, billing_email').eq('is_active', true)
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

      // Send critical alert emails
      for (const alert of bizAlerts) {
        if (alert.severity === 'critical' && org.billing_email) {
          await sendCriticalAlertEmail(alert, biz.name, org.billing_email)
        }
      }
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

  // ── 1. Check revenue and cost metrics from monthly_metrics ────────
  // Source of truth is monthly_metrics (auto-aggregated POS + PK sync). tracker_data
  // only has manually-entered food/rent/other costs, so we merge it in for food_cost.
  // Prior to 2026-04-17 this read tracker_data directly, which meant anomaly alerts
  // compared real synced current-month revenue against mostly-empty manual baselines
  // and fired false positives.
  const [mmCur, trCur] = await Promise.all([
    db.from('monthly_metrics')
      .select('revenue, food_cost, staff_cost, margin_pct, year, month')
      .eq('business_id', bizId).eq('year', year).eq('month', month).maybeSingle(),
    db.from('tracker_data')
      .select('food_cost')
      .eq('business_id', bizId).eq('period_year', year).eq('period_month', month).maybeSingle(),
  ])

  const current = mmCur.data
    ? {
        revenue:      mmCur.data.revenue,
        food_cost:    Number(mmCur.data.food_cost ?? 0) > 0 ? mmCur.data.food_cost : (trCur.data?.food_cost ?? 0),
        staff_cost:   mmCur.data.staff_cost,
        margin_pct:   mmCur.data.margin_pct,
        period_year:  mmCur.data.year,
        period_month: mmCur.data.month,
      }
    : null

  // Get last 4 months for rolling average
  const pastMonths: { year: number; month: number }[] = []
  for (let i = 1; i <= 4; i++) {
    const d = new Date(year, month - 1 - i, 1)
    pastMonths.push({ year: d.getFullYear(), month: d.getMonth() + 1 })
  }

  const pastYears = [...new Set(pastMonths.map(m => m.year))]
  const [mmHist, trHist] = await Promise.all([
    db.from('monthly_metrics')
      .select('revenue, food_cost, staff_cost, year, month')
      .eq('business_id', bizId)
      .in('year', pastYears),
    db.from('tracker_data')
      .select('food_cost, period_year, period_month')
      .eq('business_id', bizId)
      .in('period_year', pastYears),
  ])

  // Build tracker food_cost lookup to fill gaps
  const trFoodByKey: Record<string, number> = {}
  for (const t of trHist.data ?? []) {
    trFoodByKey[`${t.period_year}-${t.period_month}`] = Number(t.food_cost ?? 0)
  }

  const filteredHistory = (mmHist.data ?? [])
    .filter((r: any) => pastMonths.some(m => m.year === r.year && m.month === r.month))
    .map((r: any) => ({
      revenue:      r.revenue,
      staff_cost:   r.staff_cost,
      food_cost:    Number(r.food_cost ?? 0) > 0 ? r.food_cost : (trFoodByKey[`${r.year}-${r.month}`] ?? 0),
      period_year:  r.year,
      period_month: r.month,
    }))
    .filter((r: any) => Number(r.revenue ?? 0) > 0) // only months with real revenue inform the baseline

  if (current && filteredHistory.length >= 2) {
    const avgRevenue   = filteredHistory.reduce((s: number, r: any) => s + Number(r.revenue ?? 0), 0) / filteredHistory.length
    const avgFoodCost  = filteredHistory.reduce((s: number, r: any) => s + (Number(r.food_cost ?? 0) / Math.max(Number(r.revenue ?? 1), 1)) * 100, 0) / filteredHistory.length
    const avgStaffCost = filteredHistory.reduce((s: number, r: any) => s + (Number(r.staff_cost ?? 0) / Math.max(Number(r.revenue ?? 1), 1)) * 100, 0) / filteredHistory.length

    const curRevenue   = Number(current.revenue ?? 0)
    const curFoodPct   = curRevenue > 0 ? (Number(current.food_cost ?? 0) / curRevenue) * 100 : 0
    const curStaffPct  = curRevenue > 0 ? (Number(current.staff_cost ?? 0) / curRevenue) * 100 : 0

    const periodDate = `${year}-${String(month).padStart(2, '0')}-01`

    // Revenue drop - threshold: -15% (spec: revenue_drop_pct: -15)
    if (avgRevenue > 0) {
      const revDev = ((curRevenue - avgRevenue) / avgRevenue) * 100
      if (revDev <= -15) {
        alerts.push({
          org_id: orgId, business_id: bizId,
          alert_type: 'revenue_drop',
          severity: severity(revDev, [15, 25, 35]), // low: 15%, medium: 25%, high: 35%, critical: 35%+
          title: `Revenue down ${Math.abs(revDev).toFixed(0)}% — ${bizName}`,
          description: `Revenue is ${Math.round(curRevenue).toLocaleString('en-GB')} kr vs ${Math.round(avgRevenue).toLocaleString('en-GB')} kr average over the last 4 months.`,
          metric_value: curRevenue, expected_value: avgRevenue,
          deviation_pct: revDev, period_date: periodDate,
        })
      }
    }

    // Food cost spike - threshold: +5pp (spec: food_cost_spike_pp: 5)
    if (avgFoodCost > 0) {
      const foodDev = curFoodPct - avgFoodCost
      if (foodDev >= 5) {
        alerts.push({
          org_id: orgId, business_id: bizId,
          alert_type: 'food_cost_spike',
          severity: severity(foodDev, [5, 8, 12]), // low: 5pp, medium: 8pp, high: 12pp, critical: 12pp+
          title: `Food cost spike +${foodDev.toFixed(1)}pp — ${bizName}`,
          description: `Food cost is ${curFoodPct.toFixed(1)}% of revenue vs ${avgFoodCost.toFixed(1)}% average. Check recent supplier invoices.`,
          metric_value: curFoodPct, expected_value: avgFoodCost,
          deviation_pct: foodDev, period_date: periodDate,
        })
      }
    }

    // Staff cost spike - threshold: +8pp (spec: staff_cost_spike_pp: 8)
    if (avgStaffCost > 0) {
      const staffDev = curStaffPct - avgStaffCost
      if (staffDev >= 8) {
        alerts.push({
          org_id: orgId, business_id: bizId,
          alert_type: 'staff_cost_spike',
          severity: severity(staffDev, [8, 12, 16]), // low: 8pp, medium: 12pp, high: 16pp, critical: 16pp+
          title: `Staff cost spike +${staffDev.toFixed(1)}pp — ${bizName}`,
          description: `Staff cost is ${curStaffPct.toFixed(1)}% of revenue vs ${avgStaffCost.toFixed(1)}% average. Check schedules and overtime.`,
          metric_value: curStaffPct, expected_value: avgStaffCost,
          deviation_pct: staffDev, period_date: periodDate,
        })
      }
    }
  }

  // ── 2. Check OB supplement spikes from staff_logs ─────────────────
  // Check last 7 days vs previous 28 days average
  const sevenDaysAgo = new Date(today); sevenDaysAgo.setDate(today.getDate() - 7)
  const thirtyFiveDaysAgo = new Date(today); thirtyFiveDaysAgo.setDate(today.getDate() - 35)

  const { data: recentOB } = await db
    .from('staff_logs')
    .select('ob_supplement_kr')
    .eq('business_id', bizId)
    .gte('shift_date', sevenDaysAgo.toISOString().slice(0, 10))
    .lte('shift_date', today.toISOString().slice(0, 10))

  const { data: historicOB } = await db
    .from('staff_logs')
    .select('ob_supplement_kr')
    .eq('business_id', bizId)
    .gte('shift_date', thirtyFiveDaysAgo.toISOString().slice(0, 10))
    .lt('shift_date', sevenDaysAgo.toISOString().slice(0, 10))

  if (recentOB?.length && historicOB?.length >= 7) {
    const recentTotal = recentOB.reduce((s: number, r: any) => s + Number(r.ob_supplement_kr ?? 0), 0)
    const historicTotal = historicOB.reduce((s: number, r: any) => s + Number(r.ob_supplement_kr ?? 0), 0)
    
    const recentAvg = recentTotal / recentOB.length
    const historicAvg = historicTotal / historicOB.length

    if (historicAvg > 0) {
      const obDev = ((recentAvg - historicAvg) / historicAvg) * 100
      // OB supplement spike - threshold: +40% (spec: ob_supplement_spike_pct: 40)
      if (obDev >= 40) {
        alerts.push({
          org_id: orgId, business_id: bizId,
          alert_type: 'ob_supplement_spike',
          severity: severity(obDev, [40, 60, 80]), // low: 40%, medium: 60%, high: 80%, critical: 80%+
          title: `OB supplement spike +${obDev.toFixed(0)}% — ${bizName}`,
          description: `OB supplement is ${Math.round(recentAvg).toLocaleString('en-GB')} kr/shift vs ${Math.round(historicAvg).toLocaleString('en-GB')} kr/shift average. Check for unplanned overtime.`,
          metric_value: recentAvg, expected_value: historicAvg,
          deviation_pct: obDev, period_date: today.toISOString().slice(0, 10),
        })
      }
    }
  }

  if (alerts.length) {
    await explainAnomalyDescriptions(alerts, bizName)
  }

  return alerts
}