// @ts-nocheck
// lib/sync/engine.ts
// Universal sync engine — handles all integrations
// Called on connect and by daily cron

import { createAdminClient } from '@/lib/supabase/server'
import { decrypt }           from '@/lib/integrations/encryption'

// ── Personalkollen sync ───────────────────────────────────────────────────────
async function syncPersonalkollen(db: any, integ: any, fromDate: string, toDate: string) {
  const { getStaff, getLoggedTimes, getSales } = await import('@/lib/pos/personalkollen')
  const token = decrypt(integ.credentials_enc)
  if (!token) throw new Error('Invalid credentials')

  const { getWorkPeriods } = await import('@/lib/pos/personalkollen')
  
  // Get staff once (doesn't depend on date range)
  const staff = await getStaff(token)
  
  // Calculate if we need chunked backfill (more than 3 months)
  const from = new Date(fromDate)
  const to = new Date(toDate)
  const monthsDiff = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth())
  
  let logged: any[] = []
  let sales: any[] = []
  let scheduled: any[] = []
  
  if (monthsDiff <= 3) {
    // Small date range: fetch all at once
    [logged, sales, scheduled] = await Promise.all([
      getLoggedTimes(token, fromDate, toDate),
      getSales(token, fromDate, toDate),
      getWorkPeriods(token, fromDate, toDate),
    ])
  } else {
    // Large date range: chunk by month to avoid timeouts
    console.log(`Chunked backfill: ${monthsDiff} months from ${fromDate} to ${toDate}`)
    
    // Process month by month
    for (let monthStart = new Date(from); monthStart <= to; monthStart.setMonth(monthStart.getMonth() + 1)) {
      const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0)
      if (monthEnd > to) monthEnd.setTime(to.getTime())
      
      const monthFrom = monthStart.toISOString().slice(0, 10)
      const monthTo = monthEnd.toISOString().slice(0, 10)
      
      console.log(`  Fetching ${monthFrom} to ${monthTo}`)
      
      try {
        const [monthLogged, monthSales, monthScheduled] = await Promise.all([
          getLoggedTimes(token, monthFrom, monthTo),
          getSales(token, monthFrom, monthTo),
          getWorkPeriods(token, monthFrom, monthTo),
        ])
        
        logged.push(...monthLogged)
        sales.push(...monthSales)
        scheduled.push(...monthScheduled)
        
        // Small delay between months to avoid rate limiting
        if (monthStart.getMonth() < to.getMonth() || monthStart.getFullYear() < to.getFullYear()) {
          await new Promise(resolve => setTimeout(resolve, 500))
        }
      } catch (error: any) {
        console.error(`Failed to fetch ${monthFrom}-${monthTo}:`, error.message)
        // Continue with next month instead of failing entire sync
      }
    }
  }

  // Build staff lookup
  const staffMap: Record<string, any> = {}
  for (const s of staff) staffMap[s.url] = s

  // Upsert staff_logs
  let shiftsUpserted = 0
  const BATCH = 50
  for (let i = 0; i < logged.length; i += BATCH) {
    const rows = logged.slice(i, i + BATCH).map((l: any) => {
      const member    = staffMap[l.staff_url] ?? {}
      const shiftDate = l.start ? l.start.slice(0,10) : null
      if (!shiftDate || !l.url) return null
      return {
        org_id:           integ.org_id,
        business_id:      integ.business_id ?? null,
        pk_log_url:       l.url,
        pk_staff_url:     l.staff_url,
        pk_staff_id:      member.id ?? null,
        pk_workplace_url: l.workplace_url,
        staff_name:       member.name  ?? null,
        staff_group:      member.group ?? null,
        staff_email:      member.email ?? null,
        shift_date:       shiftDate,
        shift_start:      l.start,
        shift_end:        l.stop,
        hours_worked:     l.hours  ?? 0,
        cost_actual:      l.cost   ?? 0,
        estimated_salary: l.salary ?? 0,
        period_year:      parseInt(shiftDate.slice(0,4)),
        period_month:     parseInt(shiftDate.slice(5,7)),
        updated_at:       new Date().toISOString(),
      }
    }).filter(Boolean)

    if (rows.length) {
      await db.from('staff_logs').upsert(rows, { onConflict: 'pk_log_url' })
      shiftsUpserted += rows.length
    }
  }

  // Upsert scheduled shifts (work_periods) into staff_logs
  let scheduledUpserted = 0
  for (let i = 0; i < scheduled.length; i += BATCH) {
    const rows = scheduled.slice(i, i + BATCH).map((p: any) => {
      const shiftDate = p.date ?? (p.start ? p.start.slice(0,10) : null)
      if (!shiftDate) return null
      const hours = p.start && p.end
        ? (new Date(p.end).getTime() - new Date(p.start).getTime()) / 3600000
        : 0
      return {
        org_id:           integ.org_id,
        business_id:      integ.business_id ?? null,
        pk_log_url:       p.url + '_scheduled',
        pk_staff_url:     p.staff_url,
        pk_staff_id:      null,
        staff_name:       p.staff_name ?? null,
        staff_group:      null,
        shift_date:       shiftDate,
        shift_start:      p.start,
        shift_end:        p.end,
        hours_worked:     Math.round(hours * 10) / 10,
        cost_actual:      0,
        estimated_salary: p.estimated_cost ?? 0,
        period_year:      parseInt(shiftDate.slice(0,4)),
        period_month:     parseInt(shiftDate.slice(5,7)),
        updated_at:       new Date().toISOString(),
      }
    }).filter(Boolean)

    if (rows.length) {
      await db.from('staff_logs').upsert(rows, { onConflict: 'pk_log_url' })
      scheduledUpserted += rows.length
    }
  }

  // Upsert revenue_logs from sales
  let revenueUpserted = 0
  const byDay: Record<string, any> = {}
  for (const sale of sales) {
    if (!sale.sale_time) continue
    const date = sale.sale_time.slice(0,10)
    if (!byDay[date]) byDay[date] = { revenue: 0, covers: 0, transactions: 0, tip: 0, takeaway: 0, dine_in: 0, food: 0, drink: 0 }
    byDay[date].revenue      += sale.amount
    byDay[date].covers       += sale.covers ?? 0
    byDay[date].transactions += 1
    byDay[date].tip          += sale.tip ?? 0
    byDay[date].food         += sale.food_revenue ?? 0
    byDay[date].drink        += sale.drink_revenue ?? 0
    if (sale.is_takeaway)      byDay[date].takeaway += sale.amount
    else                       byDay[date].dine_in  += sale.amount
  }

  const revRows = Object.entries(byDay).map(([date, data]: any) => ({
    org_id:            integ.org_id,
    business_id:       integ.business_id ?? null,
    provider:          'personalkollen',
    revenue_date:      date,
    revenue:           Math.round(data.revenue * 100) / 100,
    covers:            data.covers,
    revenue_per_cover: data.covers > 0 ? Math.round(data.revenue / data.covers) : 0,
    transactions:      data.transactions,
    period_year:       parseInt(date.slice(0,4)),
    period_month:      parseInt(date.slice(5,7)),
  }))

  if (revRows.length) {
    await db.from('revenue_logs').upsert(revRows, { onConflict: 'org_id,business_id,provider,revenue_date' })
    revenueUpserted = revRows.length
  }

  // Also sync to covers table for backward compat
  if (integ.business_id) {
    const coverRows = Object.entries(byDay).map(([date, data]: any) => ({
      business_id:       integ.business_id,
      org_id:            integ.org_id,
      date,
      total:             data.covers,
      revenue:           Math.round(data.revenue),
      revenue_per_cover: data.covers > 0 ? Math.round(data.revenue / data.covers) : 0,
      source:            'personalkollen',
    })).filter(r => r.revenue > 0)

    if (coverRows.length) {
      await db.from('covers').upsert(coverRows, { onConflict: 'business_id,date' })
    }
  }

  // Sync Personalkollen sale forecasts into DB
  let forecastsUpserted = 0
  try {
    const { getSaleForecast } = await import('@/lib/pos/personalkollen')
    const now       = new Date()
    const forecastFrom = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`
    const forecastTo   = `${now.getFullYear()}-12-31`
    const pkForecasts  = await getSaleForecast(token, forecastFrom, forecastTo)

    if (pkForecasts.length && integ.business_id) {
      const fRows = pkForecasts.map((f: any) => ({
        org_id:       integ.org_id,
        business_id:  integ.business_id,
        forecast_date: f.date,
        amount:        f.amount,
        workplace_url: f.workplace_url ?? null,
        period_year:   parseInt(f.date.slice(0,4)),
        period_month:  parseInt(f.date.slice(5,7)),
      })).filter((r: any) => r.forecast_date)

      if (fRows.length) {
        await db.from('pk_sale_forecasts').upsert(fRows, { onConflict: 'org_id,business_id,forecast_date' })
        forecastsUpserted = fRows.length
      }
    }
  } catch (e: any) {
    console.error('Sale forecast sync error:', e.message)
  }

  return { shifts: shiftsUpserted, scheduled: scheduledUpserted, revenue_days: revenueUpserted, staff_count: staff.length, forecasts: forecastsUpserted }
}

// ── Fortnox sync ──────────────────────────────────────────────────────────────
async function syncFortnox(db: any, integ: any, fromDate: string, toDate: string) {
  // Get fresh access token
  const { data: tokenData } = await db
    .from('integrations')
    .select('credentials_enc')
    .eq('id', integ.id)
    .single()

  const creds = JSON.parse(decrypt(tokenData.credentials_enc) ?? '{}')
  if (!creds.access_token) throw new Error('No Fortnox access token')

  const baseUrl = 'https://api.fortnox.se/3'
  const headers = {
    'Authorization': `Bearer ${creds.access_token}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  }

  let invoicesUpserted = 0

  // Fetch supplier invoices
  try {
    const fromYear  = fromDate.slice(0,4)
    const fromMonth = fromDate.slice(5,7)
    const res = await fetch(`${baseUrl}/supplierinvoices?filter=all&fromdate=${fromDate}&todate=${toDate}&limit=500`, { headers })
    if (res.ok) {
      const data = await res.json()
      const invoices = data.SupplierInvoices ?? []

      for (const inv of invoices) {
        const invDate = inv.InvoiceDate ?? inv.BookKeepingDate
        if (!invDate) continue
        const amount = parseFloat(inv.Total ?? inv.GrossAmount ?? 0)
        const vat    = parseFloat(inv.VAT ?? 0)

        await db.from('financial_logs').upsert({
          org_id:           integ.org_id,
          business_id:      integ.business_id ?? null,
          provider:         'fortnox',
          source_id:        `inv-${inv.GivenNumber ?? inv.InvoiceNumber}`,
          log_type:         'invoice',
          amount:           amount,
          vat_amount:       vat,
          vendor_name:      inv.SupplierName ?? null,
          vendor_number:    inv.SupplierNumber ?? null,
          transaction_date: invDate,
          period_year:      parseInt(invDate.slice(0,4)),
          period_month:     parseInt(invDate.slice(5,7)),
          description:      inv.Comments ?? null,
          raw_data:         inv,
          updated_at:       new Date().toISOString(),
        }, { onConflict: 'org_id,provider,source_id' })
        invoicesUpserted++
      }
    }
  } catch (e: any) {
    console.error('Fortnox invoices error:', e.message)
  }

  // Fetch vouchers/journal entries
  let vouchersUpserted = 0
  try {
    const res = await fetch(`${baseUrl}/vouchers?fromdate=${fromDate}&todate=${toDate}`, { headers })
    if (res.ok) {
      const data = await res.json()
      const vouchers = data.Vouchers ?? []
      for (const v of vouchers) {
        const vDate = v.TransactionDate
        if (!vDate) continue
        await db.from('financial_logs').upsert({
          org_id:           integ.org_id,
          business_id:      integ.business_id ?? null,
          provider:         'fortnox',
          source_id:        `voucher-${v.VoucherSeries}-${v.VoucherNumber}`,
          log_type:         'journal',
          amount:           parseFloat(v.TransactionInformation ?? 0),
          transaction_date: vDate,
          period_year:      parseInt(vDate.slice(0,4)),
          period_month:     parseInt(vDate.slice(5,7)),
          description:      v.Description ?? null,
          raw_data:         v,
          updated_at:       new Date().toISOString(),
        }, { onConflict: 'org_id,provider,source_id' })
        vouchersUpserted++
      }
    }
  } catch (e: any) {
    console.error('Fortnox vouchers error:', e.message)
  }

  return { invoices: invoicesUpserted, vouchers: vouchersUpserted }
}

// ── Caspeco sync ─────────────────────────────────────────────────────────────
async function syncCaspeco(db: any, integ: any, fromDate: string, toDate: string) {
  const { getCaspecoShifts, getCaspecoEmployees } = await import('@/lib/pos/caspeco')
  const token = decrypt(integ.credentials_enc)
  if (!token) throw new Error('Invalid credentials')

  const [employees, shifts] = await Promise.all([
    getCaspecoEmployees(token),
    getCaspecoShifts(token, fromDate, toDate),
  ])

  const empMap: Record<string, any> = {}
  for (const e of employees) empMap[String(e.id)] = e

  let upserted = 0
  const BATCH = 50
  for (let i = 0; i < shifts.length; i += BATCH) {
    const rows = shifts.slice(i, i + BATCH).map((s: any) => {
      const emp = empMap[String(s.employee_id)] ?? {}
      if (!s.date) return null
      return {
        org_id:           integ.org_id,
        business_id:      integ.business_id ?? null,
        pk_log_url:       `caspeco-${s.id}`,
        pk_staff_url:     `caspeco-staff-${s.employee_id}`,
        pk_staff_id:      s.employee_id,
        staff_name:       s.employee_name ?? emp.name ?? null,
        staff_group:      s.department ?? null,
        staff_email:      emp.email ?? null,
        shift_date:       s.date,
        shift_start:      s.start,
        shift_end:        s.end,
        hours_worked:     s.hours ?? 0,
        cost_actual:      s.cost ?? 0,
        estimated_salary: 0,
        period_year:      parseInt(s.date.slice(0,4)),
        period_month:     parseInt(s.date.slice(5,7)),
        updated_at:       new Date().toISOString(),
      }
    }).filter(Boolean)

    if (rows.length) {
      await db.from('staff_logs').upsert(rows, { onConflict: 'pk_log_url' })
      upserted += rows.length
    }
  }

  return { shifts: upserted, employees: employees.length }
}

// ── Inzii sync ────────────────────────────────────────────────────────────────
async function syncInzii(db: any, integ: any, fromDate: string, toDate: string) {
  const { getInziiDailySummary } = await import('@/lib/pos/inzii')
  const token = decrypt(integ.credentials_enc)
  if (!token) throw new Error('Invalid credentials')

  const department = integ.department ?? 'pos'
  const daily      = await getInziiDailySummary(token, fromDate, toDate)
  let upserted     = 0

  // Use provider = 'inzii_<dept>' so each department can store its own rows
  // without conflicting on the (org_id, business_id, provider, revenue_date) unique key
  const providerKey = `inzii_${department.toLowerCase().replace(/[^a-z0-9]/g, '_')}`

  const rows = daily.map((d: any) => ({
    org_id:            integ.org_id,
    business_id:       integ.business_id ?? null,
    provider:          providerKey,
    revenue_date:      d.date,
    revenue:           Math.round(d.revenue * 100) / 100,
    covers:            d.covers ?? 0,
    revenue_per_cover: d.covers > 0 ? Math.round(d.revenue / d.covers) : 0,
    transactions:      d.transactions ?? 0,
    food_revenue:      Math.round((d.food_revenue ?? 0) * 100) / 100,
    bev_revenue:       Math.round((d.bev_revenue  ?? 0) * 100) / 100,
    period_year:       parseInt(d.date.slice(0,4)),
    period_month:      parseInt(d.date.slice(5,7)),
  })).filter((r: any) => r.revenue > 0)

  if (rows.length) {
    await db.from('revenue_logs').upsert(rows, { onConflict: 'org_id,business_id,provider,revenue_date' })
    upserted = rows.length

    // Aggregate all Inzii departments for the covers table (daily total per business)
    if (integ.business_id) {
      // Sum across all inzii_ providers for this business per date
      const { data: allInzii } = await db
        .from('revenue_logs')
        .select('revenue_date, revenue, covers, revenue_per_cover')
        .eq('business_id', integ.business_id)
        .like('provider', 'inzii_%')

      const byDate: Record<string, { revenue: number; covers: number }> = {}
      for (const r of allInzii ?? []) {
        if (!byDate[r.revenue_date]) byDate[r.revenue_date] = { revenue: 0, covers: 0 }
        byDate[r.revenue_date].revenue += Number(r.revenue ?? 0)
        byDate[r.revenue_date].covers  += Number(r.covers  ?? 0)
      }

      const coverRows = Object.entries(byDate).map(([date, data]: any) => ({
        business_id:       integ.business_id,
        org_id:            integ.org_id,
        date,
        total:             data.covers,
        revenue:           Math.round(data.revenue),
        revenue_per_cover: data.covers > 0 ? Math.round(data.revenue / data.covers) : 0,
        source:            'inzii',
      }))
      if (coverRows.length) await db.from('covers').upsert(coverRows, { onConflict: 'business_id,date' })
    }
  }

  return { revenue_days: upserted, department }
}

// ── Ancon sync ────────────────────────────────────────────────────────────────
async function syncAncon(db: any, integ: any, fromDate: string, toDate: string) {
  const { getAnconDailySummary } = await import('@/lib/pos/ancon')
  const token = decrypt(integ.credentials_enc)
  if (!token) throw new Error('Invalid credentials')

  const daily = await getAnconDailySummary(token, fromDate, toDate)
  let upserted = 0

  const rows = daily.map((d: any) => ({
    org_id:            integ.org_id,
    business_id:       integ.business_id ?? null,
    provider:          'ancon',
    revenue_date:      d.date,
    revenue:           Math.round(d.revenue * 100) / 100,
    covers:            d.covers ?? 0,
    revenue_per_cover: d.covers > 0 ? Math.round(d.revenue / d.covers) : 0,
    transactions:      d.transactions ?? 0,
    food_revenue:      Math.round((d.food_revenue ?? 0) * 100) / 100,
    bev_revenue:       Math.round((d.bev_revenue  ?? 0) * 100) / 100,
    period_year:       parseInt(d.date.slice(0,4)),
    period_month:      parseInt(d.date.slice(5,7)),
  })).filter((r: any) => r.revenue > 0)

  if (rows.length) {
    await db.from('revenue_logs').upsert(rows, { onConflict: 'org_id,business_id,provider,revenue_date' })
    upserted = rows.length

    // Also sync to covers table
    if (integ.business_id) {
      const coverRows = rows.filter((r: any) => r.covers > 0).map((r: any) => ({
        business_id: integ.business_id, org_id: integ.org_id,
        date: r.revenue_date, total: r.covers,
        revenue: Math.round(r.revenue), revenue_per_cover: r.revenue_per_cover,
        source: 'ancon',
      }))
      if (coverRows.length) await db.from('covers').upsert(coverRows, { onConflict: 'business_id,date' })
    }
  }

  return { revenue_days: upserted }
}

// ── Swess sync ────────────────────────────────────────────────────────────────
async function syncSwess(db: any, integ: any, fromDate: string, toDate: string) {
  const { getSwessDailySummary } = await import('@/lib/pos/swess')
  const token = decrypt(integ.credentials_enc)
  if (!token) throw new Error('Invalid credentials')

  const daily = await getSwessDailySummary(token, fromDate, toDate)
  let upserted = 0

  const rows = daily.map((d: any) => ({
    org_id:            integ.org_id,
    business_id:       integ.business_id ?? null,
    provider:          'swess',
    revenue_date:      d.date,
    revenue:           Math.round(d.revenue * 100) / 100,
    covers:            d.covers ?? 0,
    revenue_per_cover: d.covers > 0 ? Math.round(d.revenue / d.covers) : 0,
    transactions:      d.transactions ?? 0,
    food_revenue:      Math.round((d.food_revenue ?? 0) * 100) / 100,
    bev_revenue:       Math.round((d.bev_revenue  ?? 0) * 100) / 100,
    period_year:       parseInt(d.date.slice(0,4)),
    period_month:      parseInt(d.date.slice(5,7)),
  })).filter((r: any) => r.revenue > 0)

  if (rows.length) {
    await db.from('revenue_logs').upsert(rows, { onConflict: 'org_id,business_id,provider,revenue_date' })
    upserted = rows.length
    if (integ.business_id) {
      const coverRows = rows.filter((r: any) => r.covers > 0).map((r: any) => ({
        business_id: integ.business_id, org_id: integ.org_id,
        date: r.revenue_date, total: r.covers,
        revenue: Math.round(r.revenue), revenue_per_cover: r.revenue_per_cover,
        source: 'swess',
      }))
      if (coverRows.length) await db.from('covers').upsert(coverRows, { onConflict: 'business_id,date' })
    }
  }

  return { revenue_days: upserted }
}

// ── Update tracker_data from stored logs ──────────────────────────────────────
async function updateTrackerFromLogs(db: any, orgId: string, businessId: string | null) {
  if (!businessId) return

  // Get monthly staff cost totals from staff_logs
  const { data: staffMonths } = await db
    .from('staff_logs')
    .select('period_year, period_month, cost_actual, hours_worked')
    .eq('org_id', orgId)
    .eq('business_id', businessId)

  const byMonth: Record<string, { cost: number; hours: number }> = {}
  for (const row of staffMonths ?? []) {
    const key = `${row.period_year}-${row.period_month}`
    if (!byMonth[key]) byMonth[key] = { cost: 0, hours: 0 }
    byMonth[key].cost  += Number(row.cost_actual  ?? 0)
    byMonth[key].hours += Number(row.hours_worked ?? 0)
  }

  // Determine the correct revenue source per DATA_SOURCES.md:
  // If Inzii data exists → use only Inzii (more accurate, direct POS)
  // Otherwise → use whatever is available (personalkollen, ancon, etc.)
  const { data: allProviders } = await db
    .from('revenue_logs')
    .select('provider')
    .eq('business_id', businessId)

  const providerSet = [...new Set((allProviders ?? []).map((p: any) => p.provider))]
  const inziiProviders = providerSet.filter((p: any) => String(p).startsWith('inzii'))
  const revenueProviders = inziiProviders.length > 0 ? inziiProviders : providerSet

  // Get monthly revenue from revenue_logs — filtered to correct source
  const { data: revMonths } = await db
    .from('revenue_logs')
    .select('period_year, period_month, revenue, covers')
    .eq('org_id', orgId)
    .eq('business_id', businessId)
    .in('provider', revenueProviders.length > 0 ? revenueProviders : ['__none__'])

  const revByMonth: Record<string, { revenue: number; covers: number }> = {}
  for (const row of revMonths ?? []) {
    const key = `${row.period_year}-${row.period_month}`
    if (!revByMonth[key]) revByMonth[key] = { revenue: 0, covers: 0 }
    revByMonth[key].revenue += Number(row.revenue ?? 0)
    revByMonth[key].covers  += Number(row.covers  ?? 0)
  }

  // Update tracker_data for each month we have data for
  const allKeys = new Set([...Object.keys(byMonth), ...Object.keys(revByMonth)])
  for (const key of allKeys) {
    const [pYear, pMonth] = key.split('-').map(Number)
    const staffCost = byMonth[key]?.cost       ?? 0
    const posRev    = revByMonth[key]?.revenue ?? 0

    const { data: existing } = await db
      .from('tracker_data')
      .select('id, revenue, food_cost')
      .eq('business_id', businessId)
      .eq('period_year',  pYear)
      .eq('period_month', pMonth)
      .maybeSingle()

    // Revenue: use POS revenue if available, otherwise keep existing manual entry
    const rev    = posRev > 0 ? posRev : (existing?.revenue ?? 0)
    const food   = existing?.food_cost ?? 0
    const net    = rev - staffCost - food
    const margin = rev > 0 ? (net / rev) * 100 : 0
    const sp     = rev > 0 ? (staffCost / rev) * 100 : 0
    const fp     = rev > 0 ? (food / rev) * 100 : 0

    if (existing) {
      await db.from('tracker_data').update({
        revenue:    posRev > 0 ? Math.round(posRev) : existing.revenue,
        staff_cost: Math.round(staffCost),
        net_profit: Math.round(net),
        margin_pct: Math.round(margin * 10) / 10,
        staff_pct:  Math.round(sp * 10) / 10,
        food_pct:   Math.round(fp * 10) / 10,
      }).eq('id', existing.id)
    } else if (staffCost > 0 || posRev > 0) {
      await db.from('tracker_data').insert({
        org_id:      orgId,
        business_id: businessId,
        period_year:  pYear,
        period_month: pMonth,
        revenue:    Math.round(posRev),
        staff_cost: Math.round(staffCost),
        food_cost:  0,
        net_profit: Math.round(net),
        margin_pct: Math.round(margin * 10) / 10,
        staff_pct:  Math.round(sp * 10) / 10,
      })
    }
  }
}

// ── Generate forecasts ────────────────────────────────────────────────────────
async function generateForecasts(db: any, orgId: string, businessId: string | null) {
  if (!businessId) return

  const { data: rawHistory } = await db
    .from('tracker_data')
    .select('period_year, period_month, revenue, staff_cost, food_cost, net_profit, margin_pct')
    .eq('business_id', businessId)
    .order('period_year', { ascending: true })
    .order('period_month', { ascending: true })

  // Fill in revenue from revenue_logs where tracker has 0
  const { data: revLogs } = await db
    .from('revenue_logs')
    .select('period_year, period_month, revenue')
    .eq('business_id', businessId)
    .order('period_year', { ascending: true })
    .order('period_month', { ascending: true })

  const revLogMap: Record<string, number> = {}
  for (const r of revLogs ?? []) {
    const key = `${r.period_year}-${r.period_month}`
    revLogMap[key] = (revLogMap[key] ?? 0) + Number(r.revenue ?? 0)
  }

  const history = (rawHistory ?? []).map(row => {
    const key = `${row.period_year}-${row.period_month}`
    const rev = Number(row.revenue ?? 0) > 0 ? Number(row.revenue) : (revLogMap[key] ?? 0)
    const staff = Number(row.staff_cost ?? 0)
    const food  = Number(row.food_cost  ?? 0)
    const net   = rev - staff - food
    const margin = rev > 0 ? (net / rev) * 100 : 0
    return { ...row, revenue: rev, net_profit: net, margin_pct: margin }
  }).filter(row => Number(row.revenue ?? 0) > 0 || Number(row.staff_cost ?? 0) > 0)

  if (!history || history.length < 2) return // need at least 2 months

  const now  = new Date()
  const year = now.getFullYear()

  // Generate forecasts for ALL 12 months of current year + next 3 months
  const monthsToForecast: Array<{ year: number; month: number }> = []

  // All 12 months of current year
  for (let m = 1; m <= 12; m++) {
    monthsToForecast.push({ year, month: m })
  }
  // Next 3 months (may spill into next year)
  for (let i = 1; i <= 3; i++) {
    const d = new Date(year, now.getMonth() + i, 1)
    if (d.getFullYear() > year) {
      monthsToForecast.push({ year: d.getFullYear(), month: d.getMonth() + 1 })
    }
  }

  for (const { year: fYear, month: fMonth } of monthsToForecast) {
    // Method 1: same month last year
    const sameMonthLY = history.find(r => r.period_year === fYear - 1 && r.period_month === fMonth)

    // Method 2: 3-month rolling average using months before this one
    const priorMonths = history.filter(r =>
      r.period_year < fYear || (r.period_year === fYear && r.period_month < fMonth)
    ).slice(-3)

    if (priorMonths.length === 0) continue

    const rolling = {
      revenue:    priorMonths.reduce((s,r) => s + Number(r.revenue    ?? 0), 0) / priorMonths.length,
      staff_cost: priorMonths.reduce((s,r) => s + Number(r.staff_cost ?? 0), 0) / priorMonths.length,
      food_cost:  priorMonths.reduce((s,r) => s + Number(r.food_cost  ?? 0), 0) / priorMonths.length,
    }

    let forecast: any
    if (sameMonthLY && Number(sameMonthLY.revenue ?? 0) > 0) {
      forecast = {
        revenue_forecast:    Math.round(Number(sameMonthLY.revenue    ?? 0) * 0.6 + rolling.revenue    * 0.4),
        staff_cost_forecast: Math.round(Number(sameMonthLY.staff_cost ?? 0) * 0.6 + rolling.staff_cost * 0.4),
        food_cost_forecast:  Math.round(Number(sameMonthLY.food_cost  ?? 0) * 0.6 + rolling.food_cost  * 0.4),
        confidence:          0.75,
        method:              'same_month_ly+rolling',
      }
    } else {
      // Apply seasonal factor based on month position
      const seasonalFactors: Record<number, number> = {
        1: 0.85, 2: 0.88, 3: 0.95, 4: 1.02, 5: 1.08,
        6: 1.15, 7: 1.20, 8: 1.18, 9: 1.05, 10: 0.98,
        11: 0.92, 12: 1.10
      }
      const factor = seasonalFactors[fMonth] ?? 1.0
      forecast = {
        revenue_forecast:    Math.round(rolling.revenue    * factor),
        staff_cost_forecast: Math.round(rolling.staff_cost * factor),
        food_cost_forecast:  Math.round(rolling.food_cost  * factor),
        confidence:          0.45,
        method:              'rolling_avg+seasonal',
      }
    }

    forecast.net_profit_forecast = forecast.revenue_forecast - forecast.staff_cost_forecast - forecast.food_cost_forecast
    forecast.margin_forecast     = forecast.revenue_forecast > 0
      ? Math.round((forecast.net_profit_forecast / forecast.revenue_forecast) * 1000) / 10
      : 0
    forecast.based_on_months = priorMonths.length

    await db.from('forecasts').upsert({
      org_id: orgId, business_id: businessId,
      period_year: fYear, period_month: fMonth,
      ...forecast,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'org_id,business_id,period_year,period_month' })
  }
}

// ── Main sync function ────────────────────────────────────────────────────────
export async function runSync(orgId: string, provider: string, fromDate?: string, toDate?: string, integrationId?: string) {
  const db      = createAdminClient()
  const now     = new Date()
  const start   = Date.now()
  const from    = fromDate ?? new Date(now.getFullYear() - 2, 0, 1).toISOString().slice(0,10) // 2 years back
  const to      = toDate   ?? now.toISOString().slice(0,10)

  // Get integration — if businessId provided, get specific one, else get first connected
  // Get specific integration by ID if provided, otherwise get first connected
  let integ: any = null
  if (integrationId) {
    const { data } = await db
      .from('integrations')
      .select('id, org_id, business_id, credentials_enc, provider, last_sync_at')
      .eq('id', integrationId)
      .eq('status', 'connected')
      .maybeSingle()
    integ = data
  } else {
    const { data } = await db
      .from('integrations')
      .select('id, org_id, business_id, credentials_enc, provider, last_sync_at')
      .eq('org_id', orgId)
      .eq('provider', provider)
      .eq('status', 'connected')
      .limit(1)
      .maybeSingle()
    integ = data
  }

  if (!integ) return { error: `No connected ${provider} integration` }

  const { data: business } = integ.business_id
    ? await db.from('businesses').select('id, name, city').eq('id', integ.business_id).maybeSingle()
    : { data: null }

  let result: any = {}
  let status = 'success'

  try {
    if (provider === 'personalkollen') {
      result = await syncPersonalkollen(db, integ, from, to)
    } else if (provider === 'fortnox') {
      result = await syncFortnox(db, integ, from, to)
    } else if (provider === 'caspeco') {
      result = await syncCaspeco(db, integ, from, to)
    } else if (provider === 'ancon') {
      result = await syncAncon(db, integ, from, to)
    } else if (provider === 'swess') {
      result = await syncSwess(db, integ, from, to)
    } else if (provider === 'inzii') {
      result = await syncInzii(db, integ, from, to)
    }

    // Update tracker_data from stored logs
    await updateTrackerFromLogs(db, orgId, integ.business_id)

    // Generate forecasts
    await generateForecasts(db, orgId, integ.business_id)

    // Update integration last_sync
    await db.from('integrations').update({
      last_sync_at: now.toISOString(),
      last_error:   null,
    }).eq('id', integ.id)

    if (provider === 'personalkollen' && result.shifts > 0 && !integ.last_sync_at) {
      try {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://comandcenter.se'
        await fetch(`${appUrl}/api/agents/onboarding-success`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-cron-secret': process.env.CRON_SECRET ?? '',
          },
          body: JSON.stringify({
            org_id: orgId,
            business_id: integ.business_id,
            integration_id: integ.id,
            business_name: business?.name ?? null,
            city: business?.city ?? null,
            systems: { personalkollen: 'connected' },
            result,
          }),
        })
      } catch (err: any) {
        console.error('Onboarding success agent failed:', err)
      }
    }

  } catch (e: any) {
    status = 'error'
    result = { error: e.message }
    await db.from('integrations').update({ last_error: e.message }).eq('id', integ.id)
  }

  // Log the sync run
  const totalRecords = Object.values(result).filter(v => typeof v === 'number').reduce((s: number, v: any) => s + v, 0)
  await db.from('sync_log').insert({
    org_id:         orgId,
    provider:       provider,
    status:         status,
    records_synced: totalRecords,
    date_from:      from,
    date_to:        to,
    error_msg:      result.error ?? null,
    duration_ms:    Date.now() - start,
  })

  return { ok: status === 'success', provider, from, to, duration_ms: Date.now() - start, ...result }
}
