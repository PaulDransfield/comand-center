// @ts-nocheck
// app/api/scheduling/ai-suggestion/route.ts
//
// Returns the current PK schedule for next week AND an AI-suggested one
// derived from 8 weeks of actual revenue-per-hour patterns. Side-by-side
// display, owner decides what to act on.
//
// Shape:
// {
//   weekStart: "2026-04-20",
//   current:  [{ date, weekday, shifts, hours, est_cost, dept_breakdown }],
//   suggested:[{ date, weekday, hours, est_cost, est_revenue, rev_per_hour,
//                delta_hours, delta_cost, reasoning }],
//   summary:  { current_hours, suggested_hours, saving_kr, rationale }
// }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { fetchAllPaged } from '@/lib/supabase/page'

export const dynamic = 'force-dynamic'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const bizId = req.nextUrl.searchParams.get('business_id')
  if (!bizId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()

  // Confirm the caller owns this business.
  const { data: biz } = await db.from('businesses').select('id,org_id,name').eq('id', bizId).maybeSingle()
  if (!biz || biz.org_id !== auth.orgId) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  // Target week = next calendar Monday → Sunday
  const now = new Date()
  const daysUntilMon = ((1 - now.getDay() + 7) % 7) || 7
  const nextMon = new Date(now); nextMon.setDate(now.getDate() + daysUntilMon); nextMon.setHours(0,0,0,0)
  const nextSun = new Date(nextMon); nextSun.setDate(nextMon.getDate() + 6)
  const weekFrom = nextMon.toISOString().slice(0,10)
  const weekTo   = nextSun.toISOString().slice(0,10)

  // ── Current PK schedule for next week ──────────────────────────────────────
  // staff_logs with pk_log_url ending '_scheduled' are the scheduled shifts PK
  // returned (vs logged-actual shifts). They carry estimated_salary + hours.
  const scheduledRows = await fetchAllPaged(async (lo, hi) =>
    db.from('staff_logs')
      .select('shift_date, staff_name, staff_group, hours_worked, estimated_salary, cost_actual')
      .eq('business_id', bizId)
      .gte('shift_date', weekFrom)
      .lte('shift_date', weekTo)
      .like('pk_log_url', '%_scheduled')
      .order('shift_date', { ascending: true })
      .range(lo, hi)
  ).catch(() => [])

  const currentByDate: Record<string, any> = {}
  for (let d = new Date(nextMon); d <= nextSun; d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10)
    currentByDate[iso] = {
      date:            iso,
      weekday:         DAYS[(new Date(iso).getUTCDay() + 6) % 7],
      shifts:          0,
      hours:           0,
      est_cost:        0,
      dept_breakdown:  {} as Record<string, { hours: number; cost: number }>,
    }
  }
  for (const s of scheduledRows) {
    const row = currentByDate[s.shift_date]
    if (!row) continue
    const hours = Number(s.hours_worked ?? 0)
    const cost  = Number(s.estimated_salary ?? 0) > 0 ? Number(s.estimated_salary) : Number(s.cost_actual ?? 0)
    row.shifts += 1
    row.hours  += hours
    row.est_cost += cost
    const dept = s.staff_group ?? 'Unknown'
    if (!row.dept_breakdown[dept]) row.dept_breakdown[dept] = { hours: 0, cost: 0 }
    row.dept_breakdown[dept].hours += hours
    row.dept_breakdown[dept].cost  += cost
  }

  // ── Historical pattern: last 8 complete weeks of daily_metrics ─────────────
  const histEnd = new Date(nextMon); histEnd.setDate(nextMon.getDate() - 1)  // last Sunday
  const histStart = new Date(histEnd); histStart.setDate(histEnd.getDate() - 7 * 8)
  const { data: daily } = await db
    .from('daily_metrics')
    .select('date, revenue, staff_cost, hours_worked, labour_pct')
    .eq('business_id', bizId)
    .gte('date', histStart.toISOString().slice(0, 10))
    .lte('date', histEnd.toISOString().slice(0, 10))

  // Per-weekday historical averages (ignore days with zero rev — closed days
  // would drag the average down artificially).
  const byDow: Record<number, { rev: number[]; hours: number[]; revPerHour: number[]; labourPct: number[] }> = {}
  for (let i = 0; i < 7; i++) byDow[i] = { rev: [], hours: [], revPerHour: [], labourPct: [] }
  for (const r of (daily ?? [])) {
    if (!r.date || Number(r.revenue ?? 0) <= 0) continue
    const dow = (new Date(r.date).getUTCDay() + 6) % 7
    const rev = Number(r.revenue ?? 0)
    const hrs = Number(r.hours_worked ?? 0)
    byDow[dow].rev.push(rev)
    byDow[dow].hours.push(hrs)
    if (hrs > 0) byDow[dow].revPerHour.push(rev / hrs)
    if (r.labour_pct != null) byDow[dow].labourPct.push(Number(r.labour_pct))
  }
  const avg = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0
  const median = (a: number[]) => {
    if (!a.length) return 0
    const s = [...a].sort((x, y) => x - y)
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }

  // ── Suggested schedule: target rev-per-hour at 75th percentile of history ─
  // If last 8 weeks Mon averaged 25k rev at 40h (= 625 kr/h), and the best Mons
  // ran 800 kr/h with 32h, target 32h next Monday on a 25k forecast = "8h less
  // than current if they have 40h scheduled".
  //
  // Choice of P75 rev-per-hour as target: aggressive enough to save hours, not
  // so aggressive that service suffers. P50 would be "match average" = no
  // gain. P90 would risk understaffing on high-demand days.
  const suggested: any[] = []
  for (const date of Object.keys(currentByDate).sort()) {
    const dow = (new Date(date).getUTCDay() + 6) % 7
    const d   = byDow[dow]
    const avgRev   = Math.round(avg(d.rev))
    const avgHours = Math.round(avg(d.hours) * 10) / 10
    const sortedRph = [...d.revPerHour].sort((a, b) => a - b)
    const p75Rph    = sortedRph.length ? sortedRph[Math.floor(sortedRph.length * 0.75)] : 0
    const targetHours = avgRev > 0 && p75Rph > 0 ? Math.round((avgRev / p75Rph) * 10) / 10 : avgHours

    const current   = currentByDate[date]
    const deltaHrs  = Math.round((targetHours - current.hours) * 10) / 10
    // Estimate cost delta: use the weekday's average cost-per-hour from history.
    const avgCostPerHour = current.hours > 0 ? current.est_cost / current.hours : 0
    const deltaCost = Math.round(deltaHrs * avgCostPerHour)
    const rationale = (() => {
      if (d.rev.length < 3)                        return 'Not enough history for this weekday yet — holding as-scheduled.'
      if (Math.abs(deltaHrs) < 2)                   return 'Current schedule roughly matches historical optimum.'
      if (deltaHrs < 0)                             return `Your best ${DAYS[dow]}s in the last 8 weeks ran ${Math.round(p75Rph)} kr/hour. At the day's average revenue (${fmtKr(avgRev)}), that's ${targetHours}h.`
      return `Historical average on ${DAYS[dow]} is ${avgHours}h worked; current schedule is ${current.hours}h — consider adding hours if demand rising.`
    })()

    suggested.push({
      date,
      weekday:       current.weekday,
      hours:         targetHours,
      est_cost:      Math.round(current.est_cost + deltaCost),
      est_revenue:   avgRev,
      rev_per_hour:  Math.round(p75Rph),
      delta_hours:   deltaHrs,
      delta_cost:    deltaCost,
      reasoning:     rationale,
    })
  }

  const curHours = Object.values(currentByDate).reduce((s: number, r: any) => s + r.hours, 0)
  const sugHours = suggested.reduce((s: number, r: any) => s + r.hours, 0)
  const savingKr = Math.round(suggested.reduce((s: number, r: any) => s + (r.delta_cost < 0 ? -r.delta_cost : 0), 0))
  const addCost  = Math.round(suggested.reduce((s: number, r: any) => s + (r.delta_cost > 0 ?  r.delta_cost : 0), 0))

  return NextResponse.json({
    week_from:       weekFrom,
    week_to:         weekTo,
    business_name:   biz.name,
    current:         Object.values(currentByDate),
    suggested,
    summary: {
      current_hours:    Math.round(curHours * 10) / 10,
      suggested_hours:  Math.round(sugHours * 10) / 10,
      saving_kr:        savingKr,
      added_cost_kr:    addCost,
      net_saving_kr:    savingKr - addCost,
      rationale:        'Hours sized to match 75th-percentile rev-per-hour from last 8 weeks of the same weekday. Conservative target — keeps a safety margin over historical average.',
    },
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}

function fmtKr(n: number): string {
  return Math.round(n).toLocaleString('en-GB') + ' kr'
}
