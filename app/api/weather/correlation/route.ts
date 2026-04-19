// @ts-nocheck
// app/api/weather/correlation/route.ts
//
// Joins weather_daily × daily_metrics for a business, groups by weather
// bucket (clear/mild/wet/snow/etc.), and returns avg revenue + labour % per
// bucket with deltas from the overall average.
//
// Used by /weather page and the AI scheduling suggestion.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { weatherBucket, BUCKET_ORDER } from '@/lib/weather/forecast'

export const dynamic = 'force-dynamic'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const bizId = req.nextUrl.searchParams.get('business_id')
  if (!bizId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()

  const { data: biz } = await db.from('businesses').select('id,org_id,name').eq('id', bizId).maybeSingle()
  if (!biz || biz.org_id !== auth.orgId) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  // Pull past weather (observed, not forecast) and daily_metrics in parallel.
  const [{ data: weather }, { data: metrics }] = await Promise.all([
    db.from('weather_daily')
      .select('date,temp_avg,precip_mm,weather_code,summary')
      .eq('business_id', bizId)
      .eq('is_forecast', false)
      .order('date', { ascending: true }),
    db.from('daily_metrics')
      .select('date,revenue,staff_cost,hours_worked,labour_pct')
      .eq('business_id', bizId)
      .order('date', { ascending: true }),
  ])

  // Index weather by date
  const wxByDate: Record<string, any> = {}
  for (const w of weather ?? []) wxByDate[w.date] = w

  // Join
  const joined = (metrics ?? [])
    .filter((r: any) => Number(r.revenue ?? 0) > 0 && wxByDate[r.date])
    .map((r: any) => ({
      date:        r.date,
      weekday:     DAYS[(new Date(r.date).getUTCDay() + 6) % 7],
      revenue:     Number(r.revenue),
      staff_cost:  Number(r.staff_cost),
      hours:       Number(r.hours_worked),
      labour_pct:  r.labour_pct != null ? Number(r.labour_pct) : null,
      weather:     wxByDate[r.date],
      bucket:      weatherBucket(wxByDate[r.date]),
    }))

  // Group
  const overall_rev    = joined.reduce((s: number, d: any) => s + d.revenue,    0) / (joined.length || 1)
  const overall_labour = joined.filter((d: any) => d.labour_pct != null).reduce((s: number, d: any) => s + (d.labour_pct ?? 0), 0) / (joined.filter((d: any) => d.labour_pct != null).length || 1)

  const byBucket: Record<string, any> = {}
  for (const d of joined) {
    if (!byBucket[d.bucket]) byBucket[d.bucket] = {
      bucket: d.bucket, days: 0, total_rev: 0, total_hours: 0, labour_pcts: [], revenues: [],
    }
    const b = byBucket[d.bucket]
    b.days++
    b.total_rev   += d.revenue
    b.total_hours += d.hours
    b.revenues.push(d.revenue)
    if (d.labour_pct != null) b.labour_pcts.push(d.labour_pct)
  }

  const buckets = BUCKET_ORDER
    .map(k => byBucket[k])
    .filter(Boolean)
    .map((b: any) => {
      const avg_rev = b.days > 0 ? b.total_rev / b.days : 0
      const avg_labour = b.labour_pcts.length > 0 ? b.labour_pcts.reduce((s: number, v: number) => s + v, 0) / b.labour_pcts.length : null
      const rev_delta_pct    = overall_rev > 0 ? ((avg_rev - overall_rev) / overall_rev) * 100 : 0
      const labour_delta_pts = avg_labour != null && overall_labour > 0 ? avg_labour - overall_labour : null
      return {
        bucket:           b.bucket,
        days:             b.days,
        avg_revenue:      Math.round(avg_rev),
        avg_labour_pct:   avg_labour != null ? Math.round(avg_labour * 10) / 10 : null,
        rev_delta_pct:    Math.round(rev_delta_pct * 10) / 10,
        labour_delta_pts: labour_delta_pts != null ? Math.round(labour_delta_pts * 10) / 10 : null,
      }
    })

  // Also return by-weekday-within-bucket slicing — the real "Friday in rain vs Friday in sun" view.
  const byWeekday: Record<string, any> = {}
  for (const d of joined) {
    const key = d.weekday
    if (!byWeekday[key]) byWeekday[key] = { weekday: key, buckets: {} }
    const b = byWeekday[key].buckets
    if (!b[d.bucket]) b[d.bucket] = { days: 0, rev_total: 0, labour_total: 0, labour_n: 0 }
    b[d.bucket].days++
    b[d.bucket].rev_total += d.revenue
    if (d.labour_pct != null) { b[d.bucket].labour_total += d.labour_pct; b[d.bucket].labour_n++ }
  }
  const weekdayBreakdown = DAYS.map(wd => {
    const row = byWeekday[wd]
    if (!row) return { weekday: wd, cells: [] }
    const cells = BUCKET_ORDER.filter(b => row.buckets[b]).map(b => {
      const c = row.buckets[b]
      return {
        bucket:      b,
        days:        c.days,
        avg_rev:     Math.round(c.rev_total / c.days),
        avg_labour:  c.labour_n > 0 ? Math.round((c.labour_total / c.labour_n) * 10) / 10 : null,
      }
    })
    return { weekday: wd, cells }
  })

  return NextResponse.json({
    business_name:      biz.name,
    days_analyzed:      joined.length,
    overall_avg_rev:    Math.round(overall_rev),
    overall_avg_labour: Math.round(overall_labour * 10) / 10,
    buckets,
    weekdayBreakdown,
    samples:            joined.slice(-14).map(d => ({
      date: d.date, weekday: d.weekday, bucket: d.bucket,
      revenue: d.revenue, labour_pct: d.labour_pct,
      weather: { summary: d.weather.summary, temp_avg: d.weather.temp_avg, precip_mm: d.weather.precip_mm },
    })),
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}
