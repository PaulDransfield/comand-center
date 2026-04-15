// @ts-nocheck
// app/api/cron/personalkollen-sync/route.ts
// Daily sync — pulls ALL Personalkollen data into staff_logs table
// Also updates tracker_data with staff costs and covers

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { decrypt }                   from '@/lib/integrations/encryption'
import { getStaff, getLoggedTimes, getSales } from '@/lib/pos/personalkollen'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret') ?? req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Allow historical sync with ?from=2025-01-01
  const url      = new URL(req.url)
  const fromParam = url.searchParams.get('from')
  const toParam   = url.searchParams.get('to')

  const db      = createAdminClient()
  const results = []

  const { data: integrations } = await db
    .from('integrations')
    .select('id, org_id, business_id, credentials_enc')
    .eq('provider', 'personalkollen')
    .eq('status', 'connected')

  if (!integrations?.length) {
    return NextResponse.json({ ok: true, message: 'No active Personalkollen integrations' })
  }

  for (const integ of integrations) {
    try {
      const token = decrypt(integ.credentials_enc)
      if (!token) continue

      const now      = new Date()

      // Default: sync last 90 days. For historical: use provided dates
      const fromDate = fromParam ?? new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0,10)
      const toDate   = toParam   ?? now.toISOString().slice(0,10)

      // Fetch staff list for name/group lookup
      const staff = await getStaff(token)
      const staffMap: Record<string, any> = {}
      for (const s of staff) { staffMap[s.url] = s }

      // Fetch all logged times in range
      const logged = await getLoggedTimes(token, fromDate, toDate)

      // Upsert each shift into staff_logs
      let upserted = 0
      const BATCH = 50
      for (let i = 0; i < logged.length; i += BATCH) {
        const batch = logged.slice(i, i + BATCH)
        const rows = batch.map((l: any) => {
          const member     = staffMap[l.staff_url] ?? {}
          const shiftDate  = l.start ? l.start.slice(0,10) : null
          const pYear      = shiftDate ? parseInt(shiftDate.slice(0,4)) : now.getFullYear()
          const pMonth     = shiftDate ? parseInt(shiftDate.slice(5,7)) : now.getMonth()+1
          return {
            org_id:           integ.org_id,
            business_id:      integ.business_id ?? null,
            pk_log_url:       l.url,
            pk_staff_url:     l.staff_url,
            pk_staff_id:      member.id ?? null,
            pk_workplace_url: l.workplace_url,
            staff_name:       member.name ?? null,
            staff_group:      member.group ?? null,
            staff_email:      member.email ?? null,
            shift_date:       shiftDate,
            shift_start:      l.start,
            shift_end:        l.stop,
            hours_worked:     l.hours ?? 0,
            cost_actual:      l.cost  ?? 0,
            estimated_salary: l.salary ?? 0,
            period_year:      pYear,
            period_month:     pMonth,
            updated_at:       new Date().toISOString(),
          }
        }).filter(r => r.shift_date && r.pk_log_url)

        if (rows.length) {
          const { error } = await db.from('staff_logs')
            .upsert(rows, { onConflict: 'pk_log_url' })
          if (!error) upserted += rows.length
        }
      }

      // Update tracker_data with monthly staff costs from staff_logs
      const { data: monthlyTotals } = await db
        .from('staff_logs')
        .select('period_year, period_month, hours_worked, cost_actual')
        .eq('org_id', integ.org_id)
        .gte('shift_date', fromDate)

      // Group by month
      const byMonth: Record<string, { cost: number; hours: number }> = {}
      for (const row of monthlyTotals ?? []) {
        const key = `${row.period_year}-${row.period_month}`
        if (!byMonth[key]) byMonth[key] = { cost: 0, hours: 0 }
        byMonth[key].cost  += Number(row.cost_actual  ?? 0)
        byMonth[key].hours += Number(row.hours_worked ?? 0)
      }

      // Update tracker_data for each month
      for (const [key, data] of Object.entries(byMonth)) {
        const [pYear, pMonth] = key.split('-').map(Number)
        if (!integ.business_id) continue

        const { data: existing } = await db
          .from('tracker_data')
          .select('id, revenue, food_cost')
          .eq('business_id', integ.business_id)
          .eq('period_year',  pYear)
          .eq('period_month', pMonth)
          .maybeSingle()

        if (existing) {
          const rev      = existing.revenue    ?? 0
          const food     = existing.food_cost  ?? 0
          const net      = rev - data.cost - food
          const margin   = rev > 0 ? (net / rev) * 100 : 0
          const staffPct = rev > 0 ? (data.cost / rev) * 100 : 0
          await db.from('tracker_data').update({
            staff_cost: Math.round(data.cost),
            net_profit: Math.round(net),
            margin_pct: Math.round(margin * 10) / 10,
            staff_pct:  Math.round(staffPct * 10) / 10,
          }).eq('id', existing.id)
        } else if (integ.business_id) {
          await db.from('tracker_data').insert({
            org_id:       integ.org_id,
            business_id:  integ.business_id,
            period_year:  pYear,
            period_month: pMonth,
            revenue:      0,
            staff_cost:   Math.round(data.cost),
            food_cost:    0,
            net_profit:   0,
            margin_pct:   0,
          })
        }
      }

      // Sync covers from sales
      const sales        = await getSales(token, fromDate, toDate)
      const totalCovers  = sales.reduce((s: number, sale: any) => s + (sale.covers ?? 0), 0)
      const totalRevenue = sales.reduce((s: number, sale: any) => s + sale.amount, 0)

      if (integ.business_id) {
        const byDay: Record<string, { total: number; revenue: number }> = {}
        for (const sale of sales) {
          if (!sale.sale_time) continue
          const day = sale.sale_time.slice(0,10)
          if (!byDay[day]) byDay[day] = { total: 0, revenue: 0 }
          byDay[day].total   += sale.covers ?? 0
          byDay[day].revenue += sale.amount
        }
        for (const [date, data] of Object.entries(byDay)) {
          if (data.revenue === 0) continue
          const rpc = data.total > 0 ? Math.round(data.revenue / data.total) : 0
          await db.from('covers').upsert({
            business_id: integ.business_id,
            org_id:      integ.org_id,
            date, total: data.total,
            revenue:           Math.round(data.revenue),
            revenue_per_cover: rpc,
            source:            'personalkollen',
          }, { onConflict: 'business_id,date' })
        }
      }

      await db.from('integrations').update({
        last_sync_at: new Date().toISOString(),
        last_error:   null,
      }).eq('id', integ.id)

      results.push({
        org_id:      integ.org_id,
        shifts_synced: upserted,
        months_updated: Object.keys(byMonth).length,
        covers:      totalCovers,
        pos_revenue: Math.round(totalRevenue),
        date_range:  `${fromDate} to ${toDate}`,
      })

    } catch (e: any) {
      await db.from('integrations').update({ last_error: e.message }).eq('id', integ.id)
      results.push({ org_id: integ.org_id, error: e.message })
    }
  }

  return NextResponse.json({ ok: true, synced: results.length, results })
}
