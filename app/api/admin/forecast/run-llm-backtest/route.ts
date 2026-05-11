// app/api/admin/forecast/run-llm-backtest/route.ts
//
// Admin backtest for Piece 4 (LLM adjustment layer). For each closed-day
// actual in the requested window, runs BOTH the deterministic forecaster
// AND the LLM adjustment layer in retrospective mode, then writes
// pre-resolved rows to daily_forecast_outcomes for surfaces:
//   - consolidated_daily   (Piece 2 — already exists; we may overwrite)
//   - llm_adjusted         (Piece 4 — what we're testing)
//
// Returns side-by-side MAPE so the operator gets an immediate answer
// to "did the LLM help on January's failure mode?"
//
// Inputs (POST JSON):
//   business_id:    required
//   earliest_date:  optional (default 2026-01-01) — YYYY-MM-DD
//   latest_date:    optional (default yesterday)  — YYYY-MM-DD
//   max_days:       optional (default 30, hard cap 90) — bounds Haiku spend
//                   at ~$0.001/call → $0.09 worst case at 90 days.
//
// Returns: { ok, written_consolidated, written_llm, mape_consolidated_pct,
//            mape_llm_pct, bias_consolidated_pct, bias_llm_pct, ... }
//
// Cost discipline: each LLM call is real Haiku spend. Caller controls the
// window via earliest_date + max_days. The endpoint enforces max_days ≤ 90
// regardless of caller input.
//
// maxDuration=300 covers ~150 LLM calls at 2s each before timing out;
// in practice 30-60 days finishes in <90s.

import { NextRequest, NextResponse }    from 'next/server'
import { unstable_noStore as noStore }  from 'next/cache'
import { requireAdmin }                 from '@/lib/admin/require-admin'
import { createAdminClient }            from '@/lib/supabase/server'
import { dailyForecast }                from '@/lib/forecast/daily'
import { llmAdjustForecast, LLM_ADJUST_MODEL_VERSION } from '@/lib/forecast/llm-adjust'
import { isProvisional }                from '@/lib/finance/period-closure'

export const runtime         = 'nodejs'
export const preferredRegion = 'fra1'
export const dynamic         = 'force-dynamic'
export const maxDuration     = 300

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const HARD_MAX_DAYS = 90
const DEFAULT_MAX_DAYS = 30

export async function POST(req: NextRequest) {
  noStore()

  const body = await req.json().catch(() => ({} as any))
  const businessId   = String(body?.business_id   ?? '').trim()
  const earliestDate = String(body?.earliest_date ?? '2026-01-01').trim()
  const latestDateIn = String(body?.latest_date   ?? '').trim()
  const maxDaysRaw   = Number(body?.max_days ?? DEFAULT_MAX_DAYS)
  const maxDays = Number.isFinite(maxDaysRaw)
    ? Math.min(HARD_MAX_DAYS, Math.max(1, Math.floor(maxDaysRaw)))
    : DEFAULT_MAX_DAYS

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!ISO_DATE_RE.test(earliestDate)) return NextResponse.json({ error: 'earliest_date must be YYYY-MM-DD' }, { status: 400 })
  if (latestDateIn && !ISO_DATE_RE.test(latestDateIn)) return NextResponse.json({ error: 'latest_date must be YYYY-MM-DD' }, { status: 400 })

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
  const yesterdayIso = ymd(addDays(new Date(), -1))
  const latestIso    = latestDateIn || yesterdayIso

  // Pull positive-revenue closed days in the window, capped at maxDays
  const { data: actuals, error: actualsErr } = await db
    .from('daily_metrics')
    .select('date, revenue')
    .eq('business_id', businessId)
    .gte('date', earliestDate)
    .lte('date', latestIso)
    .gt('revenue', 0)
    .order('date', { ascending: true })
    .limit(maxDays)

  if (actualsErr) {
    return NextResponse.json({ error: `actuals fetch: ${actualsErr.message}` }, { status: 500 })
  }
  const actualsList = actuals ?? []
  if (actualsList.length === 0) {
    return NextResponse.json({
      ok:           true,
      business_id:  businessId,
      business_name: biz.name,
      message:      `No positive-revenue dates in [${earliestDate}, ${latestIso}] — nothing to backtest.`,
      written_consolidated: 0,
      written_llm:          0,
    })
  }

  let writtenConsolidated  = 0
  let writtenLlm           = 0
  let llmNullReturns       = 0
  let errored              = 0
  let skippedProvisional   = 0
  let consolidatedAbsErr   = 0
  let consolidatedSignedErr= 0
  let llmAbsErr            = 0
  let llmSignedErr         = 0

  // Token usage rollup (cost transparency)
  let totalInputTokens     = 0
  let totalOutputTokens    = 0
  let totalCacheReadTokens = 0
  let totalCacheCreateTokens = 0

  // Per-date sample log so the operator can spot-check
  const samples: Array<{
    date: string
    actual: number
    consolidated: number
    consolidated_err_pct: number | null
    llm: number | null
    llm_factor: number | null
    llm_err_pct: number | null
    llm_reasoning: string | null
    llm_confidence: 'high' | 'medium' | 'low' | null
    raw_usage?: Record<string, unknown> | null
  }> = []

  for (const row of actualsList) {
    const dateIso = row.date as string
    const date    = new Date(dateIso + 'T12:00:00Z')
    const asOf    = addDays(date, -1)
    const asOfIso = ymd(asOf)
    const actual  = Number(row.revenue)

    // Same provisional-month skip as run-backfill — partial actuals corrupt MAPE.
    if (isProvisional(date.getUTCFullYear(), date.getUTCMonth() + 1)) {
      skippedProvisional++
      continue
    }

    try {
      // ── Deterministic forecast ────────────────────────────────────────
      const forecast = await dailyForecast(businessId, date, {
        db,
        skipLogging:  true,
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
      const consolidatedErrPct = actual > 0
        ? (forecast.predicted_revenue - actual) / actual
        : null

      const { error: consInsErr } = await db.from('daily_forecast_outcomes').upsert({
        org_id:               biz.org_id,
        business_id:          businessId,
        forecast_date:        dateIso,
        surface:              'consolidated_daily',
        predicted_revenue:    forecast.predicted_revenue,
        baseline_revenue:     forecast.baseline_revenue,
        first_predicted_at:   asOf.toISOString(),
        first_predicted_date: asOfIso,
        predicted_at:         asOf.toISOString(),
        model_version:        forecast.model_version,
        snapshot_version:     forecast.snapshot_version,
        inputs_snapshot:      snapshot,
        confidence:           forecast.confidence,
        actual_revenue:       Math.round(actual),
        error_pct:            consolidatedErrPct == null ? null : Math.round(consolidatedErrPct * 10000) / 10000,
        resolution_status:    'resolved',
        resolved_at:          new Date().toISOString(),
      }, { onConflict: 'business_id,forecast_date,surface', ignoreDuplicates: false })

      if (!consInsErr) {
        writtenConsolidated++
        if (consolidatedErrPct != null) {
          consolidatedAbsErr    += Math.abs(consolidatedErrPct)
          consolidatedSignedErr += consolidatedErrPct
        }
      }

      // ── LLM adjustment ────────────────────────────────────────────────
      const llmResult = await llmAdjustForecast({
        db,
        orgId:        biz.org_id,
        businessId,
        forecastDate: dateIso,
        forecast,
        skipQuotaGate: true,   // admin backtest bypasses per-org quota
      })

      if (!llmResult) {
        llmNullReturns++
        samples.push({
          date: dateIso,
          actual: Math.round(actual),
          consolidated: forecast.predicted_revenue,
          consolidated_err_pct: consolidatedErrPct == null ? null : Math.round(consolidatedErrPct * 1000) / 1000,
          llm: null,
          llm_factor: null,
          llm_err_pct: null,
          llm_reasoning: null,
          llm_confidence: null,
        })
        continue
      }

      totalInputTokens       += llmResult.usage.input_tokens
      totalOutputTokens      += llmResult.usage.output_tokens
      totalCacheReadTokens   += llmResult.usage.cache_read_tokens     ?? 0
      totalCacheCreateTokens += llmResult.usage.cache_creation_tokens ?? 0

      const llmErrPct = actual > 0
        ? (llmResult.adjusted_revenue - actual) / actual
        : null

      const llmSnapshot = {
        adjustment_factor:   llmResult.adjustment_factor,
        deterministic_input: snapshot,
        llm_usage:           llmResult.usage,
      }

      const { error: llmInsErr } = await db.from('daily_forecast_outcomes').upsert({
        org_id:               biz.org_id,
        business_id:          businessId,
        forecast_date:        dateIso,
        surface:              'llm_adjusted',
        predicted_revenue:    llmResult.adjusted_revenue,
        baseline_revenue:     forecast.baseline_revenue,
        first_predicted_at:   asOf.toISOString(),
        first_predicted_date: asOfIso,
        predicted_at:         asOf.toISOString(),
        model_version:        llmResult.model,
        snapshot_version:     forecast.snapshot_version,
        inputs_snapshot:      llmSnapshot,
        llm_reasoning:        llmResult.reasoning,
        confidence:           llmResult.confidence,
        actual_revenue:       Math.round(actual),
        error_pct:            llmErrPct == null ? null : Math.round(llmErrPct * 10000) / 10000,
        resolution_status:    'resolved',
        resolved_at:          new Date().toISOString(),
      }, { onConflict: 'business_id,forecast_date,surface', ignoreDuplicates: false })

      if (!llmInsErr) {
        writtenLlm++
        if (llmErrPct != null) {
          llmAbsErr    += Math.abs(llmErrPct)
          llmSignedErr += llmErrPct
        }
      }

      samples.push({
        date: dateIso,
        actual: Math.round(actual),
        consolidated: forecast.predicted_revenue,
        consolidated_err_pct: consolidatedErrPct == null ? null : Math.round(consolidatedErrPct * 1000) / 1000,
        llm: llmResult.adjusted_revenue,
        llm_factor: llmResult.adjustment_factor,
        llm_err_pct: llmErrPct == null ? null : Math.round(llmErrPct * 1000) / 1000,
        llm_reasoning: llmResult.reasoning,
        llm_confidence: llmResult.confidence,
        // Include only on the first call to keep response payload small —
        // diagnostic for cache miss investigation.
        raw_usage:    samples.length === 0 ? llmResult.usage.raw ?? null : null,
      })
    } catch (e: any) {
      errored++
      console.error(`[llm-backtest] ${dateIso}: ${e?.message ?? e}`)
    }
  }

  const consolidatedMape = writtenConsolidated > 0 ? (consolidatedAbsErr    / writtenConsolidated) * 100 : 0
  const consolidatedBias = writtenConsolidated > 0 ? (consolidatedSignedErr / writtenConsolidated) * 100 : 0
  const llmMape          = writtenLlm > 0 ? (llmAbsErr    / writtenLlm) * 100 : 0
  const llmBias          = writtenLlm > 0 ? (llmSignedErr / writtenLlm) * 100 : 0

  return NextResponse.json({
    ok:                          true,
    business_id:                 businessId,
    business_name:               biz.name,
    window: { earliest_date: earliestDate, latest_date: latestIso, max_days: maxDays },
    candidates:                  actualsList.length,
    written_consolidated:        writtenConsolidated,
    written_llm:                 writtenLlm,
    llm_null_returns:            llmNullReturns,
    skipped_provisional:         skippedProvisional,
    errored,
    mape_consolidated_pct:       Math.round(consolidatedMape * 10) / 10,
    mape_llm_pct:                Math.round(llmMape * 10) / 10,
    mape_delta_pp:               Math.round((consolidatedMape - llmMape) * 10) / 10,
    bias_consolidated_pct:       Math.round(consolidatedBias * 10) / 10,
    bias_llm_pct:                Math.round(llmBias * 10) / 10,
    duration_ms:                 Date.now() - startedAt,
    llm_model_version:           LLM_ADJUST_MODEL_VERSION,
    llm_token_usage: {
      input_tokens:           totalInputTokens,
      output_tokens:          totalOutputTokens,
      cache_read_tokens:      totalCacheReadTokens,
      cache_creation_tokens:  totalCacheCreateTokens,
    },
    // First sample's raw Anthropic usage object — diagnostic for cache
    // miss investigation. Tells us exactly what fields the API returned.
    first_call_raw_usage:        (samples.find(s => s.llm != null) as any)?.raw_usage ?? null,
    samples,
    note: 'Provisional months excluded. Both surfaces written with horizon=1 (asOfDate = forecast_date - 1) so v_forecast_mape_by_surface picks them up. Re-runnable — upsert key is (business_id, forecast_date, surface).',
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
