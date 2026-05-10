// app/api/admin/forecast/run-backfill/route.ts
//
// Admin endpoint version of scripts/backfill-vero-consolidated-forecasts.ts.
// Walks any business's positive-revenue history through dailyForecast() in
// retrospective mode and populates daily_forecast_outcomes with pre-resolved
// rows so Phase A MAPE comparison has real samples on day 1.
//
// Inputs (POST JSON body):
//   business_id:    required
//   earliest_date:  optional (default 2025-01-01) — YYYY-MM-DD
//
// Returns: { ok, written, skipped, errored, mape_pct, duration_ms }
//
// Runs INLINE (not via waitUntil) so the admin sees the result. Typical
// runtime: 60-120s for 150 days. maxDuration=300 covers up to ~4 years
// of history before we'd need to chunk.

import { NextRequest, NextResponse }    from 'next/server'
import { unstable_noStore as noStore }  from 'next/cache'
import { requireAdmin }                 from '@/lib/admin/require-admin'
import { createAdminClient }            from '@/lib/supabase/server'
import { dailyForecast }                from '@/lib/forecast/daily'

export const runtime         = 'nodejs'
export const preferredRegion = 'fra1'
export const dynamic         = 'force-dynamic'
export const maxDuration     = 300

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function POST(req: NextRequest) {
  noStore()

  const body = await req.json().catch(() => ({} as any))
  const businessId   = String(body?.business_id   ?? '').trim()
  const earliestDate = String(body?.earliest_date ?? '2025-01-01').trim()

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!ISO_DATE_RE.test(earliestDate)) return NextResponse.json({ error: 'earliest_date must be YYYY-MM-DD' }, { status: 400 })

  const db = createAdminClient()

  // Look up the business's org for the requireAdmin guard
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id, name')
    .eq('id', businessId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 })

  const guard = await requireAdmin(req, { orgId: biz.org_id, businessId })
  if (!('ok' in guard)) return guard

  const startedAt = Date.now()

  // Pull every positive-revenue date from the requested window
  const yesterdayIso = ymd(addDays(new Date(), -1))
  const { data: actuals, error: actualsErr } = await db
    .from('daily_metrics')
    .select('date, revenue')
    .eq('business_id', businessId)
    .gte('date', earliestDate)
    .lte('date', yesterdayIso)
    .gt('revenue', 0)
    .order('date', { ascending: true })

  if (actualsErr) {
    return NextResponse.json({ error: `actuals fetch: ${actualsErr.message}` }, { status: 500 })
  }
  const actualsList = actuals ?? []
  if (actualsList.length === 0) {
    return NextResponse.json({
      ok:           true,
      business_id:  businessId,
      business_name: biz.name,
      message:      `No positive-revenue dates in [${earliestDate}, ${yesterdayIso}] — nothing to backfill.`,
      written:      0,
    })
  }

  let written = 0
  let errored = 0
  let totalAbsErr = 0

  for (const row of actualsList) {
    const dateIso = row.date as string
    const date    = new Date(dateIso + 'T12:00:00Z')
    const asOf    = addDays(date, -1)
    const actual  = Number(row.revenue)

    try {
      const forecast = await dailyForecast(businessId, date, {
        db,
        skipLogging:  true,         // we INSERT pre-resolved manually below
        asOfDate:     asOf,
        backfillMode: true,
      })

      const snapshot = {
        ...forecast.inputs_snapshot,
        data_quality_flags: [
          ...(forecast.inputs_snapshot.data_quality_flags ?? []),
          'backfilled_observed_as_forecast',
        ],
      }
      const errorPct = actual > 0
        ? (forecast.predicted_revenue - actual) / actual
        : null

      const { error: insErr } = await db.from('daily_forecast_outcomes').upsert({
        org_id:            biz.org_id,
        business_id:       businessId,
        forecast_date:     dateIso,
        surface:           'consolidated_daily',
        predicted_revenue: forecast.predicted_revenue,
        baseline_revenue:  forecast.baseline_revenue,
        predicted_at:      new Date().toISOString(),
        model_version:     forecast.model_version,
        snapshot_version:  forecast.snapshot_version,
        inputs_snapshot:   snapshot,
        confidence:        forecast.confidence,
        actual_revenue:    Math.round(actual),
        error_pct:         errorPct == null ? null : Math.round(errorPct * 10000) / 10000,
        resolution_status: 'resolved',
        resolved_at:       new Date().toISOString(),
      }, { onConflict: 'business_id,forecast_date,surface', ignoreDuplicates: true })

      if (insErr) {
        errored++
      } else {
        written++
        if (errorPct != null) totalAbsErr += Math.abs(errorPct)
      }
    } catch (e: any) {
      errored++
      console.error(`[forecast-backfill] ${dateIso}: ${e?.message ?? e}`)
    }
  }

  const mapePct = written > 0 ? (totalAbsErr / written) * 100 : 0

  return NextResponse.json({
    ok:            true,
    business_id:   businessId,
    business_name: biz.name,
    earliest_date: earliestDate,
    yesterday:     yesterdayIso,
    candidates:    actualsList.length,
    written,
    errored,
    mape_pct:      Math.round(mapePct * 10) / 10,
    duration_ms:   Date.now() - startedAt,
    note:          'MAPE here is optimistically biased — backfill uses observed weather as if it were forecast. Live captures going forward will give true Phase A signal.',
  })
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}
function addDays(d: Date, days: number): Date {
  const out = new Date(d)
  out.setUTCDate(out.getUTCDate() + days)
  return out
}
