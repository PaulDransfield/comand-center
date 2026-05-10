// app/api/forecast/daily/route.ts
//
// Public endpoint for the consolidated daily forecaster (Piece 2 + 4). Thin
// wrapper around `dailyForecast()`:
//   - Authenticates the caller
//   - Verifies the business is in their org
//   - Per-business flag gate (PREDICTION_V2_FORECAST_API)
//   - Calls the function
//   - If PREDICTION_V2_LLM_ADJUSTMENT also enabled (Piece 4):
//       - Re-uses any llm_adjusted row written in the last 6 hours
//       - Otherwise calls llmAdjustForecast() and captures surface='llm_adjusted'
//       - Caps per-business LLM calls to MAX_LLM_CALLS_PER_DAY to bound cost
//   - Returns the deterministic forecast + (optionally) the LLM-adjusted output
//
// Capture for surface='consolidated_daily' happens INSIDE dailyForecast() via
// Piece 1's helper. Capture for surface='llm_adjusted' happens HERE so the
// reconciler grades both side-by-side (Phase A measurement).
//
// Body: { business_id, date }   (date as YYYY-MM-DD)

import { NextRequest, NextResponse }    from 'next/server'
import { unstable_noStore as noStore }  from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { dailyForecast }                from '@/lib/forecast/daily'
import { isPredictionV2FlagEnabled }    from '@/lib/featureFlags/prediction-v2'
import { llmAdjustForecast, LLM_ADJUST_MODEL_VERSION } from '@/lib/forecast/llm-adjust'
import { captureForecastOutcome }       from '@/lib/forecast/audit'

export const runtime         = 'nodejs'
export const preferredRegion = 'fra1'
export const dynamic         = 'force-dynamic'
export const maxDuration     = 60   // bumped from 30 to fit the optional LLM call

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const LLM_CACHE_HOURS = 6
const MAX_LLM_CALLS_PER_DAY_PER_BUSINESS = 24

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({} as any))
  const businessId = String(body?.business_id ?? '').trim()
  const dateStr    = String(body?.date ?? '').trim()

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!ISO_DATE_RE.test(dateStr)) return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 })

  const db = createAdminClient()

  // Verify the business is in the caller's org
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id')
    .eq('id', businessId)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'Business not found in your org' }, { status: 404 })

  // Per-business flag gate. The function is callable from anywhere
  // (other server-side code, future Pieces, scripts) — but the public
  // endpoint is gated for safe rollout. Cutover plan in architecture §11.
  const flagOn = await isPredictionV2FlagEnabled(businessId, 'PREDICTION_V2_FORECAST_API', db)
  if (!flagOn) {
    return NextResponse.json({
      error:   'flag_disabled',
      message: 'PREDICTION_V2_FORECAST_API is not enabled for this business yet (Phase A capture-only mode).',
    }, { status: 403 })
  }

  try {
    const date = new Date(dateStr + 'T12:00:00Z')
    const forecast = await dailyForecast(businessId, date, { db })

    // ── Optional Piece 4 LLM adjustment ─────────────────────────────────
    // Independent flag — a business can be on the deterministic v2
    // endpoint without paying for LLM calls. Soft-fail throughout: any
    // failure returns the deterministic forecast unchanged.
    let llmAdjusted: Awaited<ReturnType<typeof maybeAdjustWithLlm>> = null
    const llmFlagOn = await isPredictionV2FlagEnabled(businessId, 'PREDICTION_V2_LLM_ADJUSTMENT', db)
    if (llmFlagOn) {
      llmAdjusted = await maybeAdjustWithLlm({
        db,
        orgId:        biz.org_id,
        businessId,
        forecastDate: dateStr,
        forecast,
      })
    }

    return NextResponse.json({
      ...forecast,
      llm_adjusted: llmAdjusted,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err: any) {
    return NextResponse.json({
      error:  'forecast_failed',
      detail: err?.message ?? String(err),
    }, { status: 500 })
  }
}

// ──────────────────────────────────────────────────────────────────────────
// LLM adjustment orchestration
//
// Decision tree:
//   1. Is there an existing llm_adjusted row for (business, forecast_date)
//      whose predicted_at is within the last LLM_CACHE_HOURS? → return it
//      from cache. Reasoning: dashboard re-renders shouldn't burn Haiku
//      quota; signals don't change much within 6 hours.
//   2. Has this business already used MAX_LLM_CALLS_PER_DAY_PER_BUSINESS
//      adjustments today? → skip the call (return null). Reasoning: cost
//      ceiling — even at $0.001/call, a runaway loop on a busy dashboard
//      could rack up calls we don't want to pay for.
//   3. Otherwise call llmAdjustForecast() and capture surface='llm_adjusted'.
//      Soft-fail at every step.
//
// Returns the cached/fresh adjustment in the same shape the UI consumes.
// ──────────────────────────────────────────────────────────────────────────
async function maybeAdjustWithLlm(args: {
  db:            any
  orgId:         string
  businessId:    string
  forecastDate:  string
  forecast:      Awaited<ReturnType<typeof dailyForecast>>
}): Promise<{
  adjustment_factor: number
  adjusted_revenue:  number
  reasoning:         string
  confidence:        'high' | 'medium' | 'low'
  model:             string
  cached:            boolean
} | null> {
  // ── Cache lookup ────────────────────────────────────────────────────
  try {
    const sixHoursAgoIso = new Date(Date.now() - LLM_CACHE_HOURS * 3600_000).toISOString()
    const { data: cached } = await args.db
      .from('daily_forecast_outcomes')
      .select('predicted_revenue, llm_reasoning, confidence, predicted_at, model_version, inputs_snapshot')
      .eq('business_id', args.businessId)
      .eq('forecast_date', args.forecastDate)
      .eq('surface', 'llm_adjusted')
      .gte('predicted_at', sixHoursAgoIso)
      .order('predicted_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (cached?.predicted_revenue && args.forecast.predicted_revenue > 0) {
      // Reconstruct the factor from cached predicted vs current
      // deterministic. Slight drift is fine — we only need approximate
      // attribution for the UI; the canonical authoritative source is
      // the row in daily_forecast_outcomes.
      const factor = Number(cached.predicted_revenue) / Number(args.forecast.predicted_revenue)
      return {
        adjustment_factor: Math.round(factor * 1000) / 1000,
        adjusted_revenue:  Number(cached.predicted_revenue),
        reasoning:         String(cached.llm_reasoning ?? ''),
        confidence:        (cached.confidence as 'high' | 'medium' | 'low') ?? 'low',
        model:             String(cached.model_version ?? LLM_ADJUST_MODEL_VERSION),
        cached:            true,
      }
    }
  } catch {
    // Cache miss / table issue / RLS hiccup → fall through to fresh call.
  }

  // ── Daily call cap ──────────────────────────────────────────────────
  // Counts ALL llm_adjusted rows written for this business since
  // midnight Stockholm. Goal is a hard ceiling on per-business cost
  // independent of any other gate (org-wide AI quota in usage.ts is
  // the other line of defence).
  try {
    const todayMidnightIso = stockholmMidnightIso()
    const { count } = await args.db
      .from('daily_forecast_outcomes')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', args.businessId)
      .eq('surface', 'llm_adjusted')
      .gte('predicted_at', todayMidnightIso)
    if ((count ?? 0) >= MAX_LLM_CALLS_PER_DAY_PER_BUSINESS) {
      return null
    }
  } catch {
    // If the cap check fails, fail closed — better to skip the LLM call
    // than blow past an unmeasured budget.
    return null
  }

  // ── Fresh LLM call ──────────────────────────────────────────────────
  const result = await llmAdjustForecast({
    db:           args.db,
    orgId:        args.orgId,
    businessId:   args.businessId,
    forecastDate: args.forecastDate,
    forecast:     args.forecast,
  })
  if (!result) return null

  // Capture surface='llm_adjusted'. The reconciler grades it the same
  // way it grades 'consolidated_daily' — uniform pipeline.
  await captureForecastOutcome({
    org_id:            args.orgId,
    business_id:       args.businessId,
    forecast_date:     args.forecastDate,
    surface:           'llm_adjusted',
    predicted_revenue: result.adjusted_revenue,
    baseline_revenue:  args.forecast.baseline_revenue,
    model_version:     result.model,
    snapshot_version:  'consolidated_v1',
    inputs_snapshot:   {
      // We snapshot the deterministic inputs that drove the adjustment,
      // plus the LLM-specific metadata. Keeps reconciler-side debugging
      // straightforward — every llm_adjusted row carries its source
      // forecast inline.
      adjustment_factor:   result.adjustment_factor,
      deterministic_input: args.forecast.inputs_snapshot,
      llm_usage:           result.usage,
    },
    llm_reasoning:     result.reasoning,
    confidence:        result.confidence,
  }, { db: args.db })

  return {
    adjustment_factor: result.adjustment_factor,
    adjusted_revenue:  result.adjusted_revenue,
    reasoning:         result.reasoning,
    confidence:        result.confidence,
    model:             result.model,
    cached:            false,
  }
}

/** ISO timestamp for 00:00:00 Stockholm "today" — the daily-cap window boundary. */
function stockholmMidnightIso(): string {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm' }).format(new Date())
  // Stockholm is UTC+1 in winter, UTC+2 in summer. We want the UTC instant
  // corresponding to local 00:00:00; building from the Stockholm-formatted
  // YYYY-MM-DD with a 'T00:00:00' suffix gives a Date interpreted in local
  // tz. Easier: parse as UTC and subtract a Stockholm offset estimate.
  // For purposes of a daily call cap a 1-2 hour skew is fine — we round
  // to the next UTC midnight and accept the imprecision.
  return `${ymd}T00:00:00Z`
}
