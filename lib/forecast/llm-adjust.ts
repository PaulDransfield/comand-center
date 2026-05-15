// lib/forecast/llm-adjust.ts
//
// Piece 4 — LLM adjustment layer for the consolidated daily forecaster.
//
// Wraps a deterministic DailyForecast in a Haiku 4.5 review pass. The model
// inspects the prediction and its inputs_snapshot, decides whether ANY of
// the deterministic signals are missing context the model knows about
// (e.g. owner-noted events, demand patterns the recency window can't see,
// edge cases like January post-Christmas decay), and returns a single
// multiplicative adjustment in [0.5, 1.5] plus a one-paragraph reasoning.
//
// Architectural rules (per PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md
// Section 7 + PIECE-4-IMPLEMENTATION-PROMPT.md):
//
//   1. Enrichment, never load-bearing. The deterministic forecast is the
//      prediction the system stands behind; the LLM-adjusted prediction
//      is a parallel enriched output. Caller (endpoint) decides which to
//      surface to the UI based on the per-business flag.
//   2. Soft-fail. Any error / timeout / abort / over-quota → return null
//      and let the caller fall back to the deterministic forecast.
//   3. Haiku 4.5 ONLY. Sonnet is too expensive for daily-per-business calls.
//   4. Prompt caching mandatory — SCOPE_NOTE + base instructions cached
//      so most of the prompt cost is paid once per cold-start, not per call.
//   5. Tool-use for structured output. No regex-JSON. tool_choice forces
//      the call so we always get a parseable adjustment_factor.
//   6. Adjustment factor clamped to [0.5, 1.5] server-side. The prompt asks
//      for the same clamp but we enforce it regardless of what the model
//      returns — never trust unbounded LLM output to multiply revenue.
//   7. SCOPE_NOTE injected. The model only sees business-level data the
//      forecaster also sees; no department-level cross-talk.
//   8. Capture path: caller writes a separate daily_forecast_outcomes row
//      with surface='llm_adjusted' so the reconciler grades it side-by-side
//      with surface='consolidated_daily'. Two MAPE numbers per business per
//      day → Phase A measurement → cutover criterion ≥3pp better → Phase B.
//
// What this file does NOT do (lives in the caller):
//   - Per-business flag check (PREDICTION_V2_LLM_ADJUSTMENT)
//   - The 6-hour cache (avoid hitting Haiku 5× for the same forecast date)
//   - The capture write — caller composes the captureForecastOutcome row
//   - Daily call cap per business (cost ceiling)
//
// Cost note: Haiku 4.5 is ~$1/M input cached, ~$5/M input uncached, ~$1/M
// output. With caching the per-call cost is ~$0.0005-0.001 — at one call
// per business per day across 50 customers that's <$2/month total.

import { AI_MODELS, MAX_TOKENS } from '@/lib/ai/models'
import { SCOPE_NOTE }            from '@/lib/ai/scope'
import { logAiRequest, checkAndIncrementAiLimit } from '@/lib/ai/usage'
import type { DailyForecast }    from '@/lib/forecast/daily'

// ── Public types ──────────────────────────────────────────────────────────

export interface LlmAdjustResult {
  /** Multiplicative factor applied to predicted_revenue. Clamped to [0.5, 1.5]. */
  adjustment_factor: number
  /** Adjusted prediction = round(deterministic.predicted_revenue × adjustment_factor). */
  adjusted_revenue:  number
  /** One-paragraph plain-English reasoning, ≤400 chars. Stored on
   *  daily_forecast_outcomes.llm_reasoning so the reconciler can later
   *  attribute error to specific pieces of LLM judgment. */
  reasoning:         string
  /** Self-reported confidence. Independent of the deterministic forecaster's
   *  confidence — the LLM may be confident even when the underlying signals
   *  are thin (it has the snapshot to reason about). */
  confidence:        'high' | 'medium' | 'low'
  /** Model identifier — pinned for audit so we can attribute MAPE to a model. */
  model:             string
  /** Token / duration metadata for cost reconciliation. */
  usage: {
    input_tokens:        number
    output_tokens:       number
    cache_read_tokens?:  number
    cache_creation_tokens?: number
    duration_ms:         number
    /** Raw `usage` object from Anthropic — preserved for diagnostics so
     *  we can see EVERY field the API returns (cache, server tools, etc.)
     *  without re-deploying. The structured fields above mirror common
     *  ones; this is the full source of truth. */
    raw?:                Record<string, unknown>
  }
}

export interface LlmAdjustInput {
  businessId:        string
  orgId:             string
  forecastDate:      string                 // YYYY-MM-DD
  forecast:          DailyForecast          // deterministic output
  /** Pre-built admin client. Saves a connection per call when the caller
   *  already has one. Optional — usage helpers handle their own client. */
  db?:               any
  /** Skip the AI quota gate (for backfill scripts). DO NOT set true from
   *  user-facing endpoints. */
  skipQuotaGate?:    boolean
}

// ── Constants ─────────────────────────────────────────────────────────────

const MODEL_VERSION_DEFAULT = 'llm_adjust_v1.1.0'   // 2026-05-10: added Example D for clamped-at-floor cases; prevents uniform-dampening of under-prediction days
const MIN_FACTOR = 0.5
const MAX_FACTOR = 1.5
const TIMEOUT_MS = 30_000
const MAX_REASONING_LEN = 400
const RETRY_BACKOFF_MS = 1_000
const MAX_ATTEMPTS = 2              // 1 initial + 1 retry on transient failures

// ── Tool schema (strict — no fluff) ───────────────────────────────────────

const submitAdjustmentTool = {
  name: 'submit_revenue_adjustment',
  description:
    'Submit a multiplicative adjustment to the deterministic revenue forecast. ' +
    'Use 1.0 to leave the forecast unchanged. Only deviate from 1.0 when you ' +
    'see context the deterministic signals could not see.',
  input_schema: {
    type: 'object',
    properties: {
      adjustment_factor: {
        type: 'number',
        description:
          'Multiplicative factor in [0.5, 1.5]. 1.0 = no change. Values >1 mean ' +
          'you expect higher revenue than the deterministic forecast; <1 means lower.',
      },
      reasoning: {
        type: 'string',
        description:
          'One paragraph (≤400 chars) plain English explaining the adjustment. ' +
          'Cite the specific signal you are reacting to. If adjustment_factor is 1.0, ' +
          'briefly note that the deterministic signals look complete.',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description:
          'Your confidence in the adjustment direction (not magnitude). High = ' +
          'you have a clear signal. Low = mostly speculation; prefer 1.0 in that case.',
      },
    },
    required: ['adjustment_factor', 'reasoning', 'confidence'],
  },
} as const

// ── System prompt (cached) ────────────────────────────────────────────────
//
// The system prompt is the bulk of input tokens and changes rarely — split
// into two cache-friendly blocks per Anthropic's prompt-caching guidance.
// The first block is verbatim across every call (SCOPE_NOTE + role + rules);
// the second block contains the static schema description. Both get a
// cache_control marker so they're served from the cache after the first
// call.

const ROLE_AND_RULES = `You are a forecast review agent for a Swedish restaurant business intelligence product (CommandCenter). Each call hands you ONE deterministic daily revenue forecast — a number with a structured snapshot of how it was computed (weekday baseline, weather lift, holiday flag, klämdag detection, school-holiday flag, salary cycle, this-week scaler, anomaly contamination check, and a data-quality-flags list). Your job is to decide whether the deterministic prediction needs adjustment based on context the deterministic signals cannot see.

${SCOPE_NOTE}

WHEN TO ADJUST (factor ≠ 1.0):
- The data_quality_flags list contains a flag the deterministic forecaster cannot itself correct (e.g. 'short_history_mode_4w_unweighted' on a January date — the recency window may be anchoring on December peak even though the seasonal pattern is reset).
- A signal is "available: false" with a reason that suggests systematic bias (e.g. weather_lift unavailable + a clear unusual weather pattern; yoy_same_month unavailable + the business is in a known seasonal trough).
- The this_week_scaler is clamped at floor or ceil — the deterministic forecaster has already capped its own correction; consider whether that cap is wrong this week.
- The salary_cycle phase is 'around_payday' but the deterministic factor is near 1.0 — uncommon enough to flag.

WHEN NOT TO ADJUST (return factor = 1.0):
- All signals look complete, factors are within normal range, no data_quality_flags.
- You do not have specific contextual evidence that overrides a signal — speculation is worse than unchanged.
- The deterministic forecast is already aware of and applying the same lift you would propose (e.g. holiday is detected and already lifted — do not double-count).
- ALWAYS prefer 1.0 over a small adjustment. Adjustments below 0.95 or above 1.05 should be rare and well-justified.
- ASYMMETRIC GUARDRAIL: if this_week_scaler is clamped at FLOOR (clamped_at_min=true) AND the weekday_baseline has thin samples (recent_28d_samples ≤ 4), do NOT pile additional dampening on top — the deterministic has already hit its dampening guardrail and additional dampening compounds noise. Default to 1.0 in that case unless you have a specific reason to lift (e.g. named event the baseline can't see). Same in reverse: if this_week_scaler is clamped at CEIL with thin baseline, default to 1.0 unless you have a specific reason to lift further.
- HOLIDAY-FILTER GUARDRAIL (2026-05-11): when data_quality_flags contains 'cold_start_holiday_samples_excluded', the deterministic forecaster has ALREADY removed Christmas/New Year peak samples from the baseline. Do NOT pile further "post-holiday decay" dampening on top — the baseline now reflects regular-trading days only. Default to 1.0 unless you have a non-holiday reason. Conversely, if the flag is 'cold_start_holiday_filter_fellback_too_few_samples', the filter wanted to fire but couldn't (would have left < 2 samples) — the baseline IS still holiday-contaminated and modest dampening (~0.85×) is still warranted.

CLAMP RULES:
- adjustment_factor MUST be in [0.5, 1.5]. The runtime will clamp regardless, so values outside that range are wasted output.
- Asymmetric defaults: lifts > 1.10 require a strong, specific signal (named holiday, named weather event). Dampening < 0.90 same standard.
- "I'm not sure" → 1.0 with confidence='low'. Never paper over uncertainty with a small adjustment.

OUTPUT VIA TOOL:
- You MUST submit the result via the submit_revenue_adjustment tool. No prose outside the tool call.
- reasoning ≤400 chars. Cite the SPECIFIC signal you reacted to (snapshot field name). Do not say "I noticed" or "perhaps" — be direct.
- confidence='high' only when the snapshot itself contains the evidence (named flag, clamped scaler, missing signal with reason).`

const SCHEMA_AND_EXAMPLES = `INPUT SHAPE — every call you receive a JSON payload with these top-level keys:

  forecast_date         (YYYY-MM-DD)         the date the prediction is for
  predicted_revenue     (integer SEK)        the deterministic prediction
  baseline_revenue      (integer SEK)        weekday baseline before multipliers
  components            (object)             multiplicative factors applied:
                                             weekday_baseline, yoy_same_month_anchor (or null),
                                             weather_lift_pct, weather_change_pct,
                                             holiday_lift_pct, klamdag_pct, school_holiday_pct,
                                             salary_cycle_pct, this_week_scaler
  confidence            ('high'|'medium'|'low')
  inputs_snapshot       (object)             structured snapshot of every signal,
                                             including .available flags, .reason strings
                                             on missing signals, .data_quality_flags array,
                                             and per-signal sample-counts.
  business_country      ('SE'|'NO'|'GB'|...)
  weekday_name          ('Monday'|...)
  is_weekend            (boolean)

You should focus on inputs_snapshot.data_quality_flags and the .available=false branches first — that's where the deterministic forecaster admits its gaps. The components object is what got applied; if any factor is at its clamp boundary (this_week_scaler at floor/ceil, salary_cycle at 0.7 or 1.3) the deterministic logic has already hit a guardrail and may be partially wrong.

SIGNAL REFERENCE — what each input means and how the deterministic forecaster uses it:

  weekday_baseline      Recency-weighted average revenue for this weekday over the last 12 weeks
                        (or 4 weeks if shortHistoryMode). Recent 28 days count 2× older days.
                        Filters out confirmed-anomaly dates and (in shortHistoryMode + Jan/early-Feb)
                        excludes Dec 20-Jan 6 Christmas-period samples. The .recent_28d_samples
                        count is the most important field — when it's ≤ 4, the average is fragile
                        and one outlier (good or bad) materially shifts the prediction.

  yoy_same_month        Trailing-12-month growth rate applied as a multiplier. Disabled in
                        shortHistoryMode and when the prior-12 sum is < 50% of last-12 (Vero
                        cold-start guard). When applied, value is between 0.5× and 1.5×.

  yoy_same_weekday      Activates at 365+ days history. 30% weight blended with weekday_baseline.
                        Captures seasonal transitions the 12-week window misses. Currently
                        unavailable for Vero (opened Dec 2025); will activate Nov 2026.

  weather_lift          Multiplier from historical revenue at this weather bucket vs overall.
                        Available only when ≥ 10 prior days in the same bucket. Range 0.6-1.3.

  weather_change_vs_seasonal  Piece 3 — multi-year seasonal weather norm comparison. Compares
                        forecast-day weather against same-week-of-year historical norm. Available
                        only with ≥ 1 prior-year same-week observation.

  holiday               Binary detection from country-specific holiday module. lift_factor is
                        baked into the prediction; we do NOT override holidays the deterministic
                        already detected.

  klamdag               "Squeeze day" between a public holiday and a weekend. Lift of 1.5× by
                        default in Sweden (high coffee + lunch traffic). klamdag_pct in components
                        is what got applied.

  school_holiday        Active when kommun-aware Swedish school break overlaps. Lift varies by
                        break (Jullov, Sportlov, Höstlov). Region-resolved when business has kommun
                        and lan set; falls back to national if not.

  salary_cycle          Phase based on Swedish 25th-of-month payday convention. Lifts revenue
                        around_payday (~1.3×), dampens end_month (~0.9×). Applied as a
                        multiplicative factor before this_week_scaler.

  this_week_scaler      Median ratio of actual / predicted for completed days of the current week.
                        Clamped to [0.75, 1.25] to keep one weird day from doubling the rest of the
                        week. clamped_at_min=true means actuals are running below model and the
                        cap is being hit (deterministic has already dampened by 25%). clamped_at_max
                        is the opposite.

  anomaly_contamination Confirmed revenue anomalies in the baseline window. The deterministic
                        forecaster has already excluded these from weekday_baseline; you do not
                        need to second-guess.

  data_quality_flags    The most important field for your job. Each flag indicates a structural
                        problem the deterministic forecaster has admitted but cannot fully
                        correct. Known flags and their interpretation:
                          'low_history'                                     < 60 days history
                          'short_history_mode_4w_unweighted'                < 180 days history
                          'anomaly_window_uncertain'                        owner-confirmed anomalies in baseline
                          'cold_start_holiday_samples_excluded'             Dec 20-Jan 6 samples dropped from baseline
                          'cold_start_holiday_filter_fellback_too_few_samples'  filter wanted to drop, couldn't
                          'weekday_baseline_zero_fallback_overall_mean'     no rows for this weekday in window — baseline is the mean across ALL weekdays. Crude anchor; magnitude is approximate. Prefer factor=1.0 unless you have a SPECIFIC contextual signal — additional adjustment on an already-approximate base compounds noise.

WORKED EXAMPLES (do not echo, just for calibration):

  Example A — January, short_history_mode + holiday filter ACTIVE:
    Input: data_quality_flags=['short_history_mode_4w_unweighted','cold_start_holiday_samples_excluded'],
           weekday_baseline.holiday_filter_active=true, weekday_baseline.holiday_samples_excluded=2,
           predicted_revenue 92k (Friday in January)
    Output: adjustment_factor=1.0, confidence='medium'
    Reason: deterministic has already removed Christmas-period samples from the baseline; further
            post-holiday dampening would double-count the correction. Defer to deterministic.

  Example A2 — January, short_history_mode but holiday filter FELL BACK (too few samples):
    Input: data_quality_flags=['short_history_mode_4w_unweighted','cold_start_holiday_filter_fellback_too_few_samples'],
           weekday_baseline.holiday_filter_active=false, predicted_revenue 92k (Friday in January)
    Output: adjustment_factor=0.85, confidence='high'
    Reason: holiday filter wanted to fire but couldn't (< 2 surviving samples). Baseline IS still
            holiday-contaminated; ~15% post-holiday dampening still warranted.

  Example B — normal Tuesday in May, all signals present:
    Input: no data_quality_flags, all components within ±5% of 1.0, confidence='high'
    Output: adjustment_factor=1.0, confidence='high'
    Reason: Deterministic signals look complete — weekday baseline, weather, salary cycle
            all available with healthy sample counts. No override.

  Example C — this_week_scaler clamped at 1.25 (max), salary phase 'around_payday':
    Input: scaler.applied=1.25, scaler.clamped_at_max=true, salary phase 'around_payday'
    Output: adjustment_factor=1.05, confidence='medium'
    Reason: this-week-scaler hit ceiling 1.25 — deterministic capped its own lift. Combined
            with payday Friday, modest additional lift to 1.05× is supported.

  Example D — this_week_scaler clamped at FLOOR (0.75) with thin baseline:
    Input: scaler.applied=0.75, scaler.clamped_at_min=true, weekday_baseline.recent_28d_samples=3
    Output: adjustment_factor=1.0, confidence='medium'
    Reason: deterministic has already capped its own dampening at the floor 0.75. Piling
            additional dampening on top of a 3-sample baseline compounds noise — the floor
            exists precisely because thin-history weekday averages are unreliable, not
            because the day is genuinely depressed. Prefer 1.0 unless a specific signal
            justifies further movement. (Inverse of Example C — symmetric rule.)

  Example E — weather_lift unavailable + harsh weather forecast:
    Input: weather_lift.available=false, reason='insufficient_bucket_samples',
           weather_forecast.bucket='heavy_snow', weather_forecast.temp_max=-8,
           weekday_name='Saturday', is_weekend=true
    Output: adjustment_factor=0.90, confidence='medium'
    Reason: weather_lift cannot quantify the heavy-snow effect (no prior samples in this bucket),
            but a -8°C heavy-snow Saturday systematically depresses Stockholm restaurant revenue
            10-20%. Modest dampening is warranted as a "signal-the-model-cannot-see" override.

  Example F — yoy_same_weekday available but disagrees with weekday_baseline:
    Input: yoy_same_weekday.available=true, yoy_same_weekday.revenue=180000,
           weekday_baseline.recency_weighted_avg=90000, predicted_revenue 117k
    Output: adjustment_factor=1.0, confidence='high'
    Reason: deterministic already blends YoY same-weekday at 30% weight with the weekday baseline
            (the 117k prediction is the 70/30 blend). The divergence is captured in the model.
            Do not double-count by lifting further toward the YoY signal.

  Example G — confidence='low' from a thin baseline, no specific override signal:
    Input: confidence='low', weekday_baseline.recent_28d_samples=2, no data_quality_flags
    Output: adjustment_factor=1.0, confidence='low'
    Reason: deterministic confidence is honestly low — that itself is the right output. Adjusting
            on a thin baseline without a specific contextual override (named event, weather
            anomaly, payday near-miss) compounds noise. Mirror the confidence; don't paper over it.`

// ── Transient-failure retry helper ────────────────────────────────────────
//
// Backtest 2026-05-11 surfaced 3 null returns on consecutive Feb 1-3 calls
// at the tail of a 30-day run (skipQuotaGate=true so quota wasn't the cause).
// Three consecutive nulls at the tail of a long run point at a brief
// Anthropic service blip or per-minute rate-limit — exactly the class of
// failure a single retry solves.
//
// Retry policy:
//   - Single retry with 1s fixed backoff (no exponential — we don't want
//     to compound latency, and a second blip after a 1s window is rare).
//   - Retry on: 429 (rate-limited), 408 (request timeout), 5xx (service
//     error), network exception, AbortError from the 30s timeout.
//   - DO NOT retry on: 400 (malformed body — won't fix itself), 401/403
//     (auth — won't fix itself), 404 (endpoint gone), 2xx with bad payload
//     (the parser handles those upstream).
//   - Each attempt gets its own AbortController + timer so the timeout
//     resets cleanly across retries.
//   - Quota gate fires ONCE in the caller — retry doesn't double-count
//     against the org's daily AI budget. Anthropic doesn't bill failed
//     5xx/timeout requests, so we're not paying for the retry trigger.
async function callAnthropicWithRetry(
  apiKey: string,
  reqBody: string,
): Promise<any | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
    let shouldRetry = false
    let retryReason = ''

    try {
      const httpResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: abort.signal,
        headers: {
          'content-type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: reqBody,
      })

      if (httpResp.ok) {
        clearTimeout(timer)
        return await httpResp.json()
      }

      const errText = await httpResp.text().catch(() => '')
      const transient =
        httpResp.status === 429 ||
        httpResp.status === 408 ||
        httpResp.status >= 500

      if (transient && attempt < MAX_ATTEMPTS) {
        shouldRetry = true
        retryReason = `HTTP ${httpResp.status} ${errText.slice(0, 180)}`
      } else {
        console.warn(`[llm-adjust] Anthropic API ${httpResp.status}:`, errText.slice(0, 300))
        clearTimeout(timer)
        return null
      }
    } catch (e: any) {
      const reason = abort.signal.aborted ? 'aborted (30s timeout)' : e?.message
      if (attempt < MAX_ATTEMPTS) {
        shouldRetry = true
        retryReason = String(reason)
      } else {
        console.warn('[llm-adjust] Haiku call failed:', reason)
        clearTimeout(timer)
        return null
      }
    }

    clearTimeout(timer)

    if (shouldRetry) {
      console.warn(
        `[llm-adjust] transient failure attempt ${attempt}/${MAX_ATTEMPTS}, retrying in ${RETRY_BACKOFF_MS}ms:`,
        retryReason,
      )
      await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS))
    }
  }

  return null
}

// ── Main entry ────────────────────────────────────────────────────────────

/**
 * Wrap a deterministic DailyForecast in a Haiku 4.5 review pass. Returns null
 * on any failure path (timeout, quota block, parse error, abort) — the caller
 * is responsible for falling back to the deterministic forecast.
 *
 * Caller flow:
 *   const forecast = await dailyForecast(bizId, date)
 *   const adjusted = await llmAdjustForecast({ businessId, orgId, forecastDate, forecast })
 *   if (adjusted) {
 *     // capture surface='llm_adjusted' separately
 *     // return adjusted as enriched output
 *   } else {
 *     // fall back to deterministic
 *   }
 */
export async function llmAdjustForecast(
  input: LlmAdjustInput,
): Promise<LlmAdjustResult | null> {
  // ── Quota gate (atomic, decrements on reject) ────────────────────────
  // The user-facing endpoint owns the per-business daily cap; this is the
  // org-wide AI quota that catches runaway scripts and prompt-injection.
  if (!input.skipQuotaGate) {
    try {
      const { createAdminClient } = await import('@/lib/supabase/server')
      const db = input.db ?? createAdminClient()
      const gate = await checkAndIncrementAiLimit(db, input.orgId)
      if (!gate.ok) {
        // Over quota / monthly ceiling / global kill-switch — soft-fail.
        return null
      }
    } catch {
      // Quota lookup failure → fail-closed. Don't burn tokens against an
      // unmeasured budget.
      return null
    }
  }

  // ── Compose user message (the per-call payload) ──────────────────────
  const date = new Date(input.forecastDate + 'T12:00:00Z')
  const weekdayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getUTCDay()]
  const isWeekend = date.getUTCDay() === 0 || date.getUTCDay() === 6

  const userPayload = {
    forecast_date:     input.forecastDate,
    predicted_revenue: input.forecast.predicted_revenue,
    baseline_revenue:  input.forecast.baseline_revenue,
    components:        input.forecast.components,
    confidence:        input.forecast.confidence,
    inputs_snapshot:   input.forecast.inputs_snapshot,
    weekday_name:      weekdayName,
    is_weekend:        isWeekend,
  }

  // ── Call Haiku 4.5 ────────────────────────────────────────────────────
  // Direct fetch to the Messages API instead of the SDK because the
  // installed SDK (@anthropic-ai/sdk@0.24.3, Aug 2024) predates GA prompt
  // caching and silently drops the `cache_control` field. Sending the
  // request via fetch lets us pin the API version, log raw usage, and
  // confirm caching is active via cache_read_input_tokens > 0.
  // Backtest 2026-05-10 showed 0/0 cache tokens through the SDK; this
  // path should show creation on the first call and reads after.
  const started = Date.now()
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      console.warn('[llm-adjust] ANTHROPIC_API_KEY not set, soft-failing')
      return null
    }

    // System prompt as a single text block with cache_control. The
    // 2026-05-11 backtest showed cache_creation.ephemeral_5m_input_tokens=0
    // across 30 calls — the cache was never created. Two issues fixed:
    //   1. The explicit `ttl: '5m'` field requires the
    //      `anthropic-beta: extended-cache-ttl-2025-04-11` header. Without
    //      it the API silently drops the entire cache_control object. The
    //      5-minute TTL is the default — omit ttl to get it implicitly.
    //   2. Collapsed system into ONE block to comfortably clear Haiku 4.5's
    //      2048-token minimum-cacheable-prefix threshold. The previous
    //      two-block split risked the second-block chunk being below
    //      threshold on its own.
    const SYSTEM_PROMPT = ROLE_AND_RULES + '\n\n' + SCHEMA_AND_EXAMPLES

    const reqBody = JSON.stringify({
      model:       AI_MODELS.AGENT,
      max_tokens:  MAX_TOKENS.AGENT_RECOMMENDATION,
      // cache_control on the tool definition too — system + tools are
      // both static across calls, and tools come AFTER system in the
      // cache-key order. Marking the last static thing (the tool)
      // caches system + tools as one big chunk.
      tools:       [{ ...submitAdjustmentTool, cache_control: { type: 'ephemeral' } }],
      tool_choice: { type: 'tool', name: 'submit_revenue_adjustment' },
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
    })

    // Retry helper handles transient 429 / 408 / 5xx / network / timeout
    // with a single 1s-backoff retry. Returns parsed JSON on success or
    // null on permanent error / retry-exhausted.
    const response: any = await callAnthropicWithRetry(apiKey, reqBody)
    if (!response) return null

    // Diagnostic: log the full usage object on the first call per cold-start
    // so we can see exactly what Anthropic returns. The cache miss
    // investigation (2026-05-11) needs to know whether cache_*_input_tokens
    // fields are present at all, vs being returned as 0, vs being absent.
    if (!(globalThis as any).__llmAdjustUsageLogged) {
      console.log('[llm-adjust] raw usage from Anthropic:', JSON.stringify(response.usage ?? {}))
      ;(globalThis as any).__llmAdjustUsageLogged = true
    }

    const toolUse = (response.content ?? []).find((b: any) => b.type === 'tool_use')
    const parsed: any = toolUse?.input
    if (!parsed) {
      console.warn('[llm-adjust] tool_use missing from Haiku response')
      return null
    }

    // ── Validate + clamp ────────────────────────────────────────────────
    const rawFactor = Number(parsed.adjustment_factor)
    if (!Number.isFinite(rawFactor)) return null
    const factor = Math.max(MIN_FACTOR, Math.min(MAX_FACTOR, rawFactor))

    const reasoning = String(parsed.reasoning ?? '').slice(0, MAX_REASONING_LEN).trim()
    if (!reasoning) return null

    const conf = parsed.confidence
    const confidence: 'high' | 'medium' | 'low' =
      conf === 'high' || conf === 'medium' || conf === 'low' ? conf : 'low'

    const adjustedRevenue = Math.max(0, Math.round(input.forecast.predicted_revenue * factor))

    // ── Cost log (best-effort) ──────────────────────────────────────────
    const usage = response.usage ?? {}
    try {
      const { createAdminClient } = await import('@/lib/supabase/server')
      const db = input.db ?? createAdminClient()
      await logAiRequest(db, {
        org_id:        input.orgId,
        request_type:  'llm_forecast_adjust',
        model:         AI_MODELS.AGENT,
        input_tokens:  Number(usage.input_tokens ?? 0),
        output_tokens: Number(usage.output_tokens ?? 0),
        duration_ms:   Date.now() - started,
      })
    } catch { /* logging is best-effort */ }

    return {
      adjustment_factor: Math.round(factor * 1000) / 1000,
      adjusted_revenue:  adjustedRevenue,
      reasoning,
      confidence,
      model:             MODEL_VERSION_DEFAULT,
      usage: {
        input_tokens:           Number(usage.input_tokens ?? 0),
        output_tokens:          Number(usage.output_tokens ?? 0),
        cache_read_tokens:      Number(usage.cache_read_input_tokens ?? 0) || undefined,
        cache_creation_tokens:  Number(usage.cache_creation_input_tokens ?? 0) || undefined,
        duration_ms:            Date.now() - started,
        raw:                    usage,
      },
    }
  } catch (e: any) {
    // Reached only if the parse / log / validate block throws unexpectedly —
    // the HTTP layer's own failures are absorbed inside callAnthropicWithRetry
    // and return null up here.
    console.warn('[llm-adjust] post-fetch failure:', e?.message)
    return null
  }
}

/** Exported for the endpoint and any future caller — pinning the model
 *  version string in one place so MAPE attribution by model is clean. */
export const LLM_ADJUST_MODEL_VERSION = MODEL_VERSION_DEFAULT
