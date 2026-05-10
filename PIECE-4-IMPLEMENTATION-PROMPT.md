# Piece 4 Implementation Prompt — LLM Adjustment Layer

> Fifth implementation piece of the Prediction System architecture (`PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md`).
> Written 2026-05-10 against architecture v3 + Piece 2 + Piece 3 completion reports.
> Time budget: 3-4 days focused work (between Piece 2 and Piece 3 in size).
> Output: an LLM second-pass that reads `inputs_snapshot.consolidated_v1` and adjusts the deterministic prediction. New `surface='llm_adjusted'` rows in the audit ledger; M065 view compares all four surfaces side-by-side.

---

## Context — read this before doing anything

Pieces 2-3 produced a deterministic forecaster that handles steady-state well (Vero December: 34% MAPE) but breaks at seasonal transitions (Vero January: +200% bias). The architecture's intended fix isn't more deterministic tuning — it's an LLM second-pass that sees the full snapshot and applies contextual reasoning the formula can't.

The pattern: **deterministic forecaster proposes; LLM adjusts.** The LLM doesn't replace the math — it sees:
- The deterministic prediction (e.g. 95k for January 2 Friday)
- The full `inputs_snapshot.consolidated_v1` (every signal, every multiplier, every fallback)
- Optionally: business cluster info (cuisine, location_segment, size_segment)
- Optionally: recent owner notes / events (future signal — Piece 5)

And produces:
- An adjustment factor (multiplicative, e.g. 0.80 = "I'd cut 20%")
- Reasoning (1-3 sentences explaining why)
- Confidence label
- Factors considered (tags like `'post_holiday_dip'`, `'recent_decline_trend'`)

Final prediction = `deterministic_prediction × llm_adjustment_factor`.

Three things to internalize:

1. **The LLM is a context-aware adjustment, not a replacement.** Every call still produces a deterministic forecast; the LLM just modifies it based on signals the formula can't reason about. This is the architectural answer to "model output looks wrong because of seasonal context."

2. **Per-business flag-gated rollout.** `PREDICTION_V2_LLM_ADJUSTMENT` already exists in the flags list. New `surface='llm_adjusted'` rows captured alongside `consolidated_daily` so the M065 view shows side-by-side MAPE and the Phase B cutover decision is data-driven, not hopeful.

3. **Cost-bounded by design.** Use Haiku 4.5 (per `lib/ai/models.ts` AI_MODELS.AGENT). Cache per (business, forecast_date) for 6 hours. Per-business daily call cap. Without these, 50 customers × 50 forecasts/day × Sonnet pricing is unsustainable.

---

## Pre-flight: facts confirmed in Piece 2-3 completion reports

Before reading the work streams, internalize:

1. **`dailyForecast()` is the canonical entry point.** Piece 4 wraps it — calls dailyForecast first, then runs LLM adjustment on the result.

2. **`captureForecastOutcome()` accepts `surface='llm_adjusted'`.** Already in the union type from Piece 1. Piece 4 captures with the same helper, no schema change needed.

3. **`PREDICTION_V2_LLM_ADJUSTMENT`** already exists in `lib/featureFlags/prediction-v2.ts` PREDICTION_V2_FLAGS.

4. **`lib/ai/models.ts`** (per CLAUDE.md): use `AI_MODELS.AGENT` = Haiku 4.5 for this. Architecture rule: never hardcode model strings.

5. **AI quota gate** (per CLAUDE.md Session 14): user-facing endpoints use `checkAndIncrementAiLimit()` from `lib/ai/usage.ts`. Cron-driven AI agents use the legacy `checkAiLimit + incrementAiUsage`. Piece 4's LLM call is somewhere in between — the user triggers a forecast, but it's a server-side enrichment, not the user directly chatting. Decision: use the strict atomic gate to be safe.

6. **`SCOPE_NOTE`** from `lib/ai/scope.ts` is mandatory in any AI prompt that could see business-wide vs department-level data. Piece 4 sees business-wide forecast data; SCOPE_NOTE applies.

7. **AI outcomes capture.** Piece 4's LLM call should be logged via `lib/ai/outcomes.ts` (per CLAUDE.md "AI accuracy reconciliation" pattern) so the LLM's track record builds up alongside other agents. The accuracy reconciler at 07:00 UTC daily then grades the LLM's predictions over time.

8. **Vero's structural January problem** is the primary validation target. If LLM adjustment can recognize "deterministic says 99k for Jan 2 but the snapshot shows December was Christmas peak and we're now 1 week post-holiday," the LLM should suggest a 0.6-0.7 factor to cut the prediction. That's the explicit Phase A success criterion.

---

## What to do

Six work streams. A is the function; B is the endpoint; C is the prompt design; D is the captures; E is the cost/quota gate; F is the comparison view + Phase A acceptance.

### Stream A — `llmAdjustForecast()` core (Day 1, ~5 hours)

#### A.1 Investigation

1. Read `lib/ai/models.ts` — confirm `AI_MODELS.AGENT` is what we want and check for any model_version semver pattern.
2. Read `lib/ai/usage.ts` — confirm `checkAndIncrementAiLimit` signature and behaviour.
3. Read `lib/ai/scope.ts` for the `SCOPE_NOTE` to inject into prompts.
4. Read `lib/ai/outcomes.ts` — see how other agents log their predictions for the reconciler. The Piece 4 LLM call wants the same shape so its track record accumulates.
5. Look at one existing AI agent (e.g. `lib/agents/cost-intelligence.ts`) for the canonical pattern: prompt caching, tool use vs structured output, error handling.

#### A.2 Implementation

Create `lib/forecast/llm-adjust.ts`:

```typescript
export interface LlmAdjustResult {
  adjustment_factor: number       // multiplicative; clamped [0.5, 1.5] like other multipliers
  reasoning:         string       // 1-3 sentences, owner-readable
  confidence:        'high' | 'medium' | 'low'
  factors_considered: string[]    // structured tags for analytics
  model:             string       // 'claude-haiku-4-5-20251001'
  prompt_tokens:     number
  completion_tokens: number
  cost_usd:          number
  /** True if LLM declined to adjust (returned factor=1.0 with explicit reason). */
  no_adjustment:     boolean
  no_adjustment_reason?: string
}

export async function llmAdjustForecast(
  forecast: DailyForecast,           // from Piece 2
  context: {
    business: { id: string; name: string; cuisine?: string; location_segment?: string }
    org_id:   string
    db?:      any
  },
): Promise<LlmAdjustResult>
```

Behaviour:
- Pull SCOPE_NOTE + a tight system prompt (see Stream C) + the forecast + snapshot as the user message
- Call Claude Haiku 4.5 via the Anthropic SDK
- Use prompt caching on the system prompt + SCOPE_NOTE (these are constant per request)
- Parse the structured output (use tool use, NOT regex-JSON — per CLAUDE.md AI architecture invariants)
- Clamp `adjustment_factor` to [0.5, 1.5]
- Track tokens + cost via `lib/ai/usage.ts` patterns
- Return the structured result

If the model fails to return a valid adjustment (parsing error, timeout), return `{ adjustment_factor: 1.0, no_adjustment: true, no_adjustment_reason: 'parse_failed' | 'timeout' | etc }`. NEVER throw — the LLM is enrichment, not load-bearing.

#### A.3 Acceptance

- `lib/forecast/llm-adjust.ts` exports `llmAdjustForecast()` matching the signature
- Calls Haiku 4.5 with prompt caching
- Returns within 5 seconds for a typical case (cold) or under 1 second on cache hit
- Clamped factor stays in [0.5, 1.5]
- Tokens + cost USD reported accurately

---

### Stream B — Endpoint integration (Day 1-2, ~3 hours)

#### B.1 Implementation

Two integration paths:

**Option 1: Extend `/api/forecast/daily`** to ALSO call llmAdjustForecast when `PREDICTION_V2_LLM_ADJUSTMENT` is on for the business. Returns a richer payload:
```json
{
  ...DailyForecast (unchanged),
  "llm_adjustment": { ...LlmAdjustResult },
  "final_prediction": predicted_revenue * llm_adjustment.adjustment_factor
}
```

**Option 2: New endpoint `/api/forecast/daily-with-llm`** that wraps the existing one + LLM call.

**Pick Option 1.** Avoids endpoint sprawl. The LLM block is null-safe when the flag is off.

After the LLM result, capture a SEPARATE row in `daily_forecast_outcomes` with `surface='llm_adjusted'`:
```typescript
await captureForecastOutcome({
  org_id, business_id, forecast_date,
  surface:           'llm_adjusted',
  predicted_revenue: Math.round(consolidatedPrediction * llm.adjustment_factor),
  baseline_revenue:  forecast.baseline_revenue,
  model_version:     'consolidated_v1.1.0+haiku45',
  snapshot_version:  'consolidated_v1',
  inputs_snapshot:   {
    ...forecast.inputs_snapshot,
    llm_adjustment: llm,           // append the LLM block to the snapshot
  },
  llm_reasoning:     llm.reasoning,
  confidence:        llm.confidence,
})
```

#### B.2 Acceptance

- POST to `/api/forecast/daily` with flag ON returns both deterministic + LLM-adjusted prediction
- Two rows land in `daily_forecast_outcomes`: one `consolidated_daily`, one `llm_adjusted`
- Flag OFF → just `consolidated_daily`, no LLM call (no cost incurred)
- Endpoint response under 6s p95

---

### Stream C — Prompt design (Day 2, ~4 hours)

This is where the work matters. Bad prompt → LLM produces noise.

#### C.1 The system prompt

```
You are a Swedish restaurant revenue forecast adjuster. You see a deterministic
forecast model's prediction PLUS the full set of signals it used to produce that
prediction. Your job: review the snapshot for context the formula can't reason
about, and suggest a multiplicative adjustment factor in [0.5, 1.5].

Output structured JSON via the provided tool.

When NOT to adjust (return adjustment_factor=1.0):
- The deterministic prediction looks reasonable given the snapshot
- You don't have enough context to argue for an adjustment
- The signal contradiction is small (<10% deviation from prediction)

When TO adjust:
- The snapshot shows a structural pattern the formula missed (e.g. recent
  weeks trending strongly down/up while baseline is anchored to older data)
- A signal in the snapshot is clearly miscalibrated (e.g. klamdag history
  with samples_used=2 is unreliable; suggest dampening)
- The forecast date is in a known seasonal transition the deterministic
  model can't see (post-Christmas dip, post-summer return, etc.)
- A `data_quality_flags` entry indicates the deterministic prediction
  should be treated with low confidence

Adjustments must be:
- Multiplicative (output factor between 0.5 and 1.5)
- Justified in 1-3 sentences (factor: business owner reads this)
- Tagged with structured factors_considered (e.g. ['post_holiday_dip',
  'low_klamdag_samples'])

[SCOPE_NOTE injected here]
```

Plus a tool-use schema:
```typescript
{
  name: 'submit_adjustment',
  input_schema: {
    type: 'object',
    properties: {
      adjustment_factor:    { type: 'number', minimum: 0.5, maximum: 1.5 },
      reasoning:            { type: 'string', maxLength: 600 },
      confidence:           { type: 'string', enum: ['high', 'medium', 'low'] },
      factors_considered:   { type: 'array', items: { type: 'string' }, maxItems: 5 },
      no_adjustment:        { type: 'boolean' },
      no_adjustment_reason: { type: 'string' },
    },
    required: ['adjustment_factor', 'reasoning', 'confidence', 'factors_considered'],
  },
}
```

#### C.2 The user message shape

```
Forecast for [Vero Italiano] on [2026-01-02 Friday]:

DETERMINISTIC PREDICTION: 99,152 SEK
Baseline (weekday recency-weighted avg): 78,533
Confidence: medium

SNAPSHOT (consolidated_v1):
[full inputs_snapshot JSON]

CONTEXT:
- Cuisine: italian
- Location: city_center
- Size: medium
- Days of positive-revenue history: 167

REVIEW the snapshot. If you see a contextual reason to adjust, propose
an adjustment factor. Otherwise return 1.0 with no_adjustment=true.
```

#### C.3 Iteration

After Stream A-B-C-D ship, manually inspect the LLM's first 20-30 outputs. Look for:
- Hallucinations (LLM citing data not in the snapshot)
- Wild factors (frequent 0.5 or 1.5 clamps)
- Reasoning that looks plausible but is mathematically wrong
- "No adjustment" rate (target 30-50%; outside that range means prompt is too aggressive or too timid)

Iterate the prompt based on what you see. Document changes in the completion report.

---

### Stream D — Per-business flag + cost gating (Day 2-3, ~3 hours)

#### D.1 Flag integration

In `/api/forecast/daily` (Stream B), check `PREDICTION_V2_LLM_ADJUSTMENT` for the business via `isPredictionV2FlagEnabled()`. If off → skip LLM call entirely, return only deterministic forecast.

#### D.2 Cost gate

Per-business cap to prevent runaway cost:
- New env var `LLM_ADJUST_DAILY_CAP_PER_BIZ` (default: 100 calls/day)
- Track via `ai_request_log` or new dedicated counter table
- If cap hit, return `{no_adjustment: true, no_adjustment_reason: 'daily_cap_reached'}`

Plus: cache adjacent calls. For (business_id, forecast_date), if we already have an llm_adjusted row in `daily_forecast_outcomes` from the last 6 hours, skip the LLM call and re-use that row's adjustment factor.

#### D.3 Acceptance

- 100 forecasts/day per business cap enforced; 101st returns `no_adjustment: true, reason: 'daily_cap_reached'`
- Calls within 6 hours of an existing capture don't re-fire the LLM (cost: 0)
- Cost USD logged per call to `ai_request_log`

---

### Stream E — Capture + reconciler integration (Day 3, ~2 hours)

#### E.1 Reconciler awareness

The daily-forecast-reconciler at 10:00 UTC already grades all surfaces uniformly via `daily_metrics.revenue` join. No code changes needed — it'll automatically resolve `llm_adjusted` rows the same way it resolves `consolidated_daily`.

Verify via SQL after Day 3:
```sql
SELECT surface, COUNT(*) FROM daily_forecast_outcomes
WHERE resolution_status = 'resolved'
GROUP BY surface;
```

Both surfaces should show comparable counts.

#### E.2 AI accuracy reconciler awareness

`/api/cron/ai-accuracy-reconciler` at 07:00 UTC currently writes `forecast_calibration.accuracy_pct + bias_factor` from `ai_forecast_outcomes` rollups. Piece 4's LLM adjustment is a NEW agent surface (`'llm_revenue_adjust'` or similar). Decision: log to `ai_forecast_outcomes` so the reconciler picks it up automatically and forecast_calibration tracks LLM accuracy too.

---

### Stream F — Phase A comparison + acceptance gate (Day 3-4, ~4 hours)

#### F.1 Multi-surface MAPE view

Update M065 (`v_forecast_mape_by_surface`) — actually no update needed; the view already aggregates all surfaces. Just verify all four surfaces show up after a week of capture:
- `consolidated_daily`
- `scheduling_ai_revenue`
- `weather_demand`
- `llm_adjusted` ← new

#### F.2 Admin tile

`/api/admin/forecast-mape` already returns the view as JSON. Optional: add a `/admin/v2/forecast` page that renders all four surfaces in a chart (horizon × MAPE per surface). Defer to a separate UI task if it doesn't fit Day 4.

#### F.3 Phase B cutover criterion

After 2 weeks of resolved rows, decide:
- If `llm_adjusted` MAPE < `consolidated_daily` MAPE by ≥3pp on closed months, AND no horizon shows >20% divergence → flip `PREDICTION_V2_DASHBOARD_CHART` to use `llm_adjusted` as the source for Vero
- If equal or worse → stay on consolidated_daily; investigate prompt issues
- Document the decision in `PIECE-4-PHASE-A-REPORT.md`

---

## What NOT to do

- DO NOT replace the deterministic forecaster. Piece 4 is a wrapper, not a substitute.
- DO NOT use Sonnet 4.6 for the per-forecast call. Haiku 4.5 is correct per CLAUDE.md cost rules. (Sonnet is only justified for /api/ask interactive assistant + scheduling-optimization weekly cron.)
- DO NOT skip prompt caching. CLAUDE.md AI architecture invariant: every Claude-calling surface uses prompt caching.
- DO NOT skip the SCOPE_NOTE inclusion. Architecture invariant: any AI surface seeing business-wide data carries it.
- DO NOT add a new schema. Piece 4 reuses `daily_forecast_outcomes` (with `llm_reasoning` column already in M059) and the existing flag table.
- DO NOT make the LLM load-bearing. Errors return `no_adjustment: true`; deterministic prediction is always the fallback.

---

## What to flag and pause for

If during investigation any of the following turns up, **stop and report:**

1. `lib/ai/models.ts` doesn't export `AI_MODELS.AGENT` or it's not Haiku
2. `checkAndIncrementAiLimit` signature differs from CLAUDE.md description
3. `daily_forecast_outcomes.llm_reasoning` column doesn't exist (M059 should have shipped it)
4. `ai_forecast_outcomes` reconciler is incompatible with adding a new surface
5. Prompt caching isn't configurable on the Anthropic SDK version in use
6. `lib/ai/scope.ts` SCOPE_NOTE export missing or shape changed

---

## Acceptance gates (overall)

Piece 4 is complete when:

- [ ] `lib/forecast/llm-adjust.ts` exists, fully typed, soft-fails on errors
- [ ] `/api/forecast/daily` extension serves both deterministic + LLM-adjusted predictions when flag is on
- [ ] Per-business flag `PREDICTION_V2_LLM_ADJUSTMENT` gates the LLM call (no flag = no cost)
- [ ] 6-hour cache + daily cap prevent runaway cost
- [ ] `daily_forecast_outcomes` rows tagged `surface='llm_adjusted'` capture on each call
- [ ] M065 view shows 4 surfaces side-by-side after 1 day of resolved captures
- [ ] LLM accuracy logged to `ai_forecast_outcomes` for reconciler integration
- [ ] All TypeScript clean (`npx tsc --noEmit` zero output)
- [ ] No customer-visible behaviour change beyond Phase A capture

After 2 weeks of capture:
- [ ] `PIECE-4-PHASE-A-REPORT.md` summarising MAPE comparison vs consolidated_daily
- [ ] Phase B cutover decision documented (yes/no/iterate prompt)

---

## Output

1. Code merged: llm-adjust.ts, /api/forecast/daily extension, capture instrumentation
2. `PIECE-4-COMPLETION-REPORT.md` summarising:
   - Investigation findings
   - LLM prompt iterations + final version
   - First 20-30 sample outputs (anonymised; for the architectural memory)
   - Cost-per-call empirical numbers
   - Acceptance gates met / pending
   - Architecture corrections to fold into v3.2

The completion report is the input to Piece 5's implementation prompt (pattern extraction surfacing learned multipliers from accumulated audit data).
