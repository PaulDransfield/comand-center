// @ts-nocheck
// lib/ai/buildContext.ts
// Builds rich AI context from Supabase — fast DB reads, no live API calls
// Covers current year + last year for comparisons

import { createAdminClient } from '@/lib/supabase/server'

export async function buildLiveContext(orgId: string): Promise<string> {
  const db  = createAdminClient()
  const now = new Date()
  const year      = now.getFullYear()
  const lastYear  = year - 1
  const month     = now.getMonth() + 1
  let ctx = ''

  try {
    // ── Businesses ──────────────────────────────────────────────────────────
    const { data: businesses } = await db
      .from('businesses')
      .select('id, name, city, type, target_staff_pct, target_food_pct, target_margin_pct')
      .eq('org_id', orgId)
      .eq('is_active', true)
      .order('name')

    if (!businesses?.length) return 'No restaurants configured yet.'

    ctx += `RESTAURANTS (${businesses.length}):\n`
    for (const b of businesses) {
      ctx += `- ${b.name} (${b.city ?? 'No city'}) — targets: food ${b.target_food_pct}%, staff ${b.target_staff_pct}%, margin ${b.target_margin_pct}%\n`
    }

    // ── Connected integrations ──────────────────────────────────────────────
    const { data: integrations } = await db
      .from('integrations')
      .select('provider, status, last_sync_at')
      .eq('org_id', orgId)
      .eq('status', 'connected')

    if (integrations?.length) {
      ctx += `\nCONNECTED INTEGRATIONS: ${integrations.map(i => `${i.provider} (last sync: ${i.last_sync_at?.slice(0,10) ?? 'never'})`).join(', ')}\n`
    }

    // ── P&L Tracker — this year + last year ─────────────────────────────────
    const { data: tracker } = await db
      .from('tracker_data')
      .select('business_id, period_year, period_month, revenue, staff_cost, food_cost, net_profit, margin_pct, staff_pct, food_pct')
      .eq('org_id', orgId)
      .in('period_year', [lastYear, year])
      .order('period_year', { ascending: false })
      .order('period_month', { ascending: false })

    if (tracker?.length) {
      // Group by year
      const thisYearRows = tracker.filter(r => r.period_year === year)
      const lastYearRows = tracker.filter(r => r.period_year === lastYear)

      if (thisYearRows.length) {
        ctx += `\nP&L DATA — ${year}:\n`
        for (const row of thisYearRows) {
          const biz    = businesses.find(b => b.id === row.business_id)
          const rev    = Math.round(row.revenue    ?? 0)
          const staff  = Math.round(row.staff_cost ?? 0)
          const food   = Math.round(row.food_cost  ?? 0)
          const net    = Math.round(row.net_profit ?? 0)
          const margin = Number(row.margin_pct ?? 0).toFixed(1)
          const sp     = Number(row.staff_pct  ?? 0).toFixed(1)
          const fp     = Number(row.food_pct   ?? 0).toFixed(1)
          ctx += `- ${biz?.name ?? 'Unknown'} ${year}-${String(row.period_month).padStart(2,'0')}: Rev ${rev.toLocaleString()} kr | Staff ${staff.toLocaleString()} kr (${sp}%) | Food ${food.toLocaleString()} kr (${fp}%) | Net ${net.toLocaleString()} kr | Margin ${margin}%\n`
        }
        const totRevTY  = thisYearRows.reduce((s,r) => s + Number(r.revenue    ?? 0), 0)
        const totStTY   = thisYearRows.reduce((s,r) => s + Number(r.staff_cost ?? 0), 0)
        const totNetTY  = thisYearRows.reduce((s,r) => s + Number(r.net_profit ?? 0), 0)
        ctx += `  YTD TOTAL ${year}: Rev ${Math.round(totRevTY).toLocaleString()} kr | Staff ${Math.round(totStTY).toLocaleString()} kr | Net ${Math.round(totNetTY).toLocaleString()} kr\n`
      }

      if (lastYearRows.length) {
        ctx += `\nP&L DATA — ${lastYear} (for comparison):\n`
        for (const row of lastYearRows) {
          const biz    = businesses.find(b => b.id === row.business_id)
          const rev    = Math.round(row.revenue    ?? 0)
          const net    = Math.round(row.net_profit ?? 0)
          const margin = Number(row.margin_pct ?? 0).toFixed(1)
          const sp     = Number(row.staff_pct  ?? 0).toFixed(1)
          ctx += `- ${biz?.name ?? 'Unknown'} ${lastYear}-${String(row.period_month).padStart(2,'0')}: Rev ${rev.toLocaleString()} kr | Staff ${sp}% | Net ${net.toLocaleString()} kr | Margin ${margin}%\n`
        }
        const totRevLY = lastYearRows.reduce((s,r) => s + Number(r.revenue ?? 0), 0)
        const totNetLY = lastYearRows.reduce((s,r) => s + Number(r.net_profit ?? 0), 0)
        ctx += `  TOTAL ${lastYear}: Rev ${Math.round(totRevLY).toLocaleString()} kr | Net ${Math.round(totNetLY).toLocaleString()} kr\n`
      }
    }

    // ── Staff logs — this year + last year (from DB, fast) ──────────────────
    const { data: staffLogs } = await db
      .from('staff_logs')
      .select('period_year, period_month, staff_name, staff_group, hours_worked, cost_actual, estimated_salary')
      .eq('org_id', orgId)
      .in('period_year', [lastYear, year])
      .order('period_year', { ascending: false })
      .order('period_month', { ascending: false })

    if (staffLogs?.length) {
      // Monthly totals by year
      const monthlyTY: Record<string, { cost: number; hours: number }> = {}
      const monthlyLY: Record<string, { cost: number; hours: number }> = {}

      // Department totals this year
      const deptTY: Record<string, { cost: number; hours: number; count: Set<string> }> = {}

      // Per-staff totals this year
      const staffTY: Record<string, { cost: number; hours: number; group: string }> = {}

      for (const row of staffLogs) {
        const key = `${row.period_year}-${String(row.period_month).padStart(2,'0')}`
        const cost  = Number(row.cost_actual  ?? 0)
        const hours = Number(row.hours_worked ?? 0)
        const group = row.staff_group ?? 'Unknown'
        const name  = row.staff_name  ?? 'Unknown'

        if (row.period_year === year) {
          if (!monthlyTY[key]) monthlyTY[key] = { cost: 0, hours: 0 }
          monthlyTY[key].cost  += cost
          monthlyTY[key].hours += hours

          if (!deptTY[group]) deptTY[group] = { cost: 0, hours: 0, count: new Set() }
          deptTY[group].cost  += cost
          deptTY[group].hours += hours
          deptTY[group].count.add(name)

          if (!staffTY[name]) staffTY[name] = { cost: 0, hours: 0, group }
          staffTY[name].cost  += cost
          staffTY[name].hours += hours
        } else {
          if (!monthlyLY[key]) monthlyLY[key] = { cost: 0, hours: 0 }
          monthlyLY[key].cost  += cost
          monthlyLY[key].hours += hours
        }
      }

      ctx += `\nSTAFF LOGS — ${year} monthly summary:\n`
      for (const [key, data] of Object.entries(monthlyTY).sort()) {
        ctx += `- ${key}: ${Math.round(data.hours*10)/10}h, ${Math.round(data.cost).toLocaleString()} kr\n`
      }

      if (Object.keys(monthlyLY).length) {
        ctx += `\nSTAFF LOGS — ${lastYear} monthly summary (for YoY comparison):\n`
        for (const [key, data] of Object.entries(monthlyLY).sort()) {
          ctx += `- ${key}: ${Math.round(data.hours*10)/10}h, ${Math.round(data.cost).toLocaleString()} kr\n`
        }
      }

      // Department breakdown this year
      const deptSorted = Object.entries(deptTY).sort((a,b) => b[1].cost - a[1].cost)
      if (deptSorted.length) {
        ctx += `\nDEPARTMENT BREAKDOWN (${year} YTD):\n`
        for (const [dept, data] of deptSorted) {
          ctx += `- ${dept}: ${data.count.size} staff, ${Math.round(data.hours*10)/10}h, ${Math.round(data.cost).toLocaleString()} kr\n`
        }
      }

      // Top 15 staff by cost this year
      const staffSorted = Object.entries(staffTY).sort((a,b) => b[1].cost - a[1].cost).slice(0,15)
      if (staffSorted.length) {
        ctx += `\nTOP 15 STAFF BY COST (${year} YTD):\n`
        for (const [name, data] of staffSorted) {
          const cph = data.hours > 0 ? Math.round(data.cost / data.hours) : 0
          ctx += `- ${name} (${data.group}): ${Math.round(data.hours*10)/10}h, ${Math.round(data.cost).toLocaleString()} kr, ${cph} kr/h\n`
        }
      }
    }

    // ── Sale forecasts from Personalkollen ────────────────────────────────────
    // (stored in revenue_logs, gives predicted revenue per day)
    const thisMonthRevStr = `${year}-${String(month).padStart(2,'0')}-01`
    const { data: revLogs } = await db
      .from('revenue_logs')
      .select('period_year, period_month, revenue, covers')
      .eq('org_id', orgId)
      .in('period_year', [year - 1, year])
      .order('period_year', { ascending: false })
      .order('period_month', { ascending: false })
      .limit(24)

    if (revLogs?.length) {
      const byMonth: Record<string, number> = {}
      for (const r of revLogs) {
        const key = `${r.period_year}-${String(r.period_month).padStart(2,'0')}`
        byMonth[key] = (byMonth[key] ?? 0) + Number(r.revenue ?? 0)
      }
      ctx += `\nPOS REVENUE (from Personalkollen sales):\n`
      for (const [key, rev] of Object.entries(byMonth).sort().reverse().slice(0,6)) {
        ctx += `- ${key}: ${Math.round(rev).toLocaleString()} kr\n`
      }
    }

    // ── Covers this month ───────────────────────────────────────────────────
    const { data: covers } = await db
      .from('covers')
      .select('date, total, revenue, revenue_per_cover')
      .eq('org_id', orgId)
      .gte('date', `${year}-${String(month).padStart(2,'0')}-01`)
      .order('date', { ascending: false })
      .limit(31)

    if (covers?.length) {
      const totC   = covers.reduce((s,c) => s + (c.total ?? 0), 0)
      const totR   = covers.reduce((s,c) => s + (c.revenue ?? 0), 0)
      const avgRPC = totC > 0 ? Math.round(totR / totC) : 0
      ctx += `\nCOVERS (${year}-${String(month).padStart(2,'0')}): ${totC} total | ${Math.round(totR).toLocaleString()} kr | ${avgRPC} kr/cover avg\n`
    }

    // ── Forecasts ────────────────────────────────────────────────────────────
    const { data: forecasts } = await db
      .from('forecasts')
      .select('business_id, period_year, period_month, revenue_forecast, staff_cost_forecast, food_cost_forecast, net_profit_forecast, margin_forecast, confidence, method, based_on_months')
      .eq('org_id', orgId)
      .gte('period_year', year)
      .order('period_year')
      .order('period_month')
      .limit(6)

    if (forecasts?.length) {
      ctx += `\nFORECASTS (AI-generated from historical data):\n`
      for (const f of forecasts) {
        const biz = businesses.find(b => b.id === f.business_id)
        const conf = Math.round((f.confidence ?? 0) * 100)
        ctx += `- ${biz?.name ?? 'Unknown'} ${f.period_year}-${String(f.period_month).padStart(2,'0')}: `
        ctx += `Rev ${Math.round(f.revenue_forecast ?? 0).toLocaleString()} kr | Staff ${Math.round(f.staff_cost_forecast ?? 0).toLocaleString()} kr | Net ${Math.round(f.net_profit_forecast ?? 0).toLocaleString()} kr | Margin ${f.margin_forecast}% (${conf}% confidence, based on ${f.based_on_months} months)
`
      }
    }

    // ── Personalkollen sale forecasts (stored in DB) ────────────────────────
    const { data: pkSaleForecasts } = await db
      .from('pk_sale_forecasts')
      .select('forecast_date, amount, period_year, period_month')
      .eq('org_id', orgId)
      .gte('forecast_date', `${year}-01-01`)
      .order('forecast_date')

    if (pkSaleForecasts?.length) {
      // Group by month
      const byMonth: Record<string, number> = {}
      for (const f of pkSaleForecasts) {
        const key = `${f.period_year}-${String(f.period_month).padStart(2,'0')}`
        byMonth[key] = (byMonth[key] ?? 0) + Number(f.amount ?? 0)
      }
      ctx += `\nPERSONALKOLLEN REVENUE FORECAST (${year}):\n`
      for (const [key, amt] of Object.entries(byMonth).sort()) {
        ctx += `- ${key}: ${Math.round(amt).toLocaleString()} kr forecasted\n`
      }
    }

    // ── Late arrivals and OB from staff_logs ────────────────────────────────
    const { data: punctuality } = await db
      .from('staff_logs')
      .select('staff_name, staff_group, is_late, late_minutes, ob_supplement_kr, costgroup_name')
      .eq('org_id', orgId)
      .eq('period_year', year)
      .eq('period_month', month)

    if (punctuality?.length) {
      const lateShifts = punctuality.filter(r => r.is_late)
      if (lateShifts.length > 0) {
        ctx += `\nPUNCTUALITY (this month): ${lateShifts.length} late arrivals\n`
        const byStaff: Record<string, number> = {}
        for (const l of lateShifts) {
          if (l.staff_name) byStaff[l.staff_name] = (byStaff[l.staff_name] ?? 0) + 1
        }
        const repeat = Object.entries(byStaff).filter(([,v]) => v > 1).sort((a,b) => b[1]-a[1])
        if (repeat.length) ctx += `Repeat late: ${repeat.map(([n,c]) => `${n} (${c}x)`).join(', ')}\n`
      }

      // Costgroup breakdown
      const byCostgroup: Record<string, number> = {}
      for (const r of punctuality) {
        if (r.costgroup_name) {
          byCostgroup[r.costgroup_name] = (byCostgroup[r.costgroup_name] ?? 0) + 1
        }
      }
      if (Object.keys(byCostgroup).length > 0) {
        ctx += `\nSHIFTS BY SECTION (this month):\n`
        for (const [section, count] of Object.entries(byCostgroup).sort((a,b) => b[1]-a[1])) {
          ctx += `- ${section}: ${count} shifts\n`
        }
      }
    }

    // ── Active alerts ───────────────────────────────────────────────────────
    const { data: alerts } = await db
      .from('anomaly_alerts')
      .select('title, description, severity')
      .eq('org_id', orgId)
      .eq('is_dismissed', false)
      .limit(5)

    if (alerts?.length) {
      ctx += `\nACTIVE ALERTS:\n`
      for (const a of alerts) {
        ctx += `- [${a.severity.toUpperCase()}] ${a.title}: ${a.description}\n`
      }
    }

  } catch (e: any) {
    ctx += `\nContext error: ${e.message}\n`
  }

  return ctx
}
