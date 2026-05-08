# Prediction System Architecture

> Drafted 2026-05-08, evening session.
> Architecture doc for the daily-grain forecasting and learning system.
> This is the foundation of CommandCenter's core differentiator.

---

## Executive summary

We are building a system that produces a daily revenue prediction for every business, captures the prediction with full input provenance at generation time, reconciles the prediction against actual revenue when it lands, and uses the resulting audit trail to make subsequent predictions measurably more accurate over time.

The system is intentionally a **math model with an LLM adjustment layer on top**, not an LLM that predicts numbers. Math models are deterministic, debuggable, fast, and free at runtime. LLMs are good at adjusting predictions based on context the math doesn't see and at producing operator-facing explanations. Each tool does what it's best at.

The architecture is six pieces, sequenced over ~17 calendar weeks, interleaved with customer-facing work and the parallel AB/Stripe track. Every piece is independently shippable. Every piece is the foundation for cross-customer learning that activates when we have N≥5 customers.

The marketing claim we're building toward, conservatively framed:

> "Predictions about your business get measurably more accurate the longer you use CommandCenter. We show you the track record. Better forecasts help you make smarter staffing and purchasing decisions."

This claim is defensible because the audit ledger produces the receipts. The aggressive version ("X% reduction in labour cost in your first six months") is something we earn the right to say after we've seen it happen across multiple customers — not on day one.

---

## Section 1 — The accuracy claim and what it requires

### What we commit to

Per-business, per-surface MAPE (Mean Absolute Percentage Error) trends, visible in the product. Three specific commitments:

1. **Predictions are measurably more accurate after 90 days than after 30 days.** The MAPE trend line for next-week daily revenue forecasts trends downward as customer tenure increases.
2. **The track record is visible.** Customers can see their own prediction history — what we predicted, what actually happened, where we were close, where we missed.
3. **Misses are explained.** When a prediction was off, the system surfaces a likely reason. Operators don't have to trust a black box.

### What we explicitly do not commit to

- "Your costs will go down by X%." Labour cost as % of revenue moves for many reasons — menu changes, operator skill, seasonality, customer mix. Attributing improvements specifically to our predictions requires a causal chain we don't have today and may never fully have. Promising it creates an expectation we can't reliably hit.
- "Predictions will be within X% accuracy on day one." Cold-start accuracy is bad and there's no way around it. We commit to improvement over time, not absolute accuracy at the start.
- "Every prediction will be explained." The LLM adjustment layer produces explanations when it adjusts. Pure baseline predictions are explained by their math components, not by narrative.

### The metric

Primary: **MAPE on next-week daily revenue, computed weekly per business.** Specifically, for each business:

```
MAPE_week_N = mean(|predicted - actual| / actual) over the 7 days of week N
```

Secondary metrics (tracked but not promised):
- MAPE by weekday (are Saturdays harder than Tuesdays?)
- MAPE by surface (is the consolidated forecaster better than the LLM-adjusted version?)
- MAPE by horizon (1-day-ahead vs 7-day-ahead vs 14-day-ahead)
- Prediction bias (do we systematically over- or underpredict?)

### What this requires from the architecture

- The audit ledger must be working from day 1 of every customer's tenure. There is no "we'll backfill later" — predictions are captured at generation time or they are lost.
- Every prediction must have a known model_version so we can compare apples to apples when we change the model.
- The reconciler must run reliably and idempotently every day.
- We need at least 30 days of audit data per business before we display any accuracy claim publicly to operators.

---

## Section 2 — Schema: `daily_forecast_outcomes`

### Decision: parallel table, not extended M020

Confirmed. `daily_forecast_outcomes` is a new table. Reasoning:

- Daily and monthly are different reconciliation cadences. Daily reconciler runs every morning; monthly runs once a month. Mixing them in one table produces awkward queries.
- Daily volume is ~30× monthly. Joins and indexes get slower for no benefit.
- The schema needs are different. Daily wants `inputs_snapshot` JSONB with weather, weekday baselines, holiday flags. Monthly wants budget components.
- The M020 pattern is proven, which means we know it works — we copy the *pattern*, not the table.

### DDL

```sql
CREATE TABLE daily_forecast_outcomes (
  id BIGSERIAL PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  forecast_date DATE NOT NULL,

  -- which forecaster produced this row
  surface TEXT NOT NULL CHECK (surface IN (
    'consolidated_daily',      -- the new unified forecaster (Section 3)
    'scheduling_ai_revenue',   -- legacy: kept during migration period
    'weather_demand',          -- legacy: kept during migration period
    'llm_adjusted'             -- the LLM adjustment layer (Section 6)
  )),

  -- the prediction itself
  predicted_revenue NUMERIC(12,2) NOT NULL,
  baseline_revenue NUMERIC(12,2),  -- math-only prediction before any LLM adjustment

  -- when and how it was generated
  predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model_version TEXT NOT NULL,     -- e.g. 'consolidated_v1.2.0'

  -- everything that went into producing the prediction
  inputs_snapshot JSONB NOT NULL,

  -- LLM-specific (null for non-LLM surfaces)
  llm_reasoning TEXT,
  confidence TEXT CHECK (confidence IN ('high', 'medium', 'low')),

  -- reconciliation columns (filled in later by daily cron)
  actual_revenue NUMERIC(12,2),
  error_pct NUMERIC(8,4),
  error_attribution JSONB,
  resolved_at TIMESTAMPTZ,
  resolution_status TEXT CHECK (resolution_status IN (
    'pending',
    'resolved',
    'unresolvable_no_actual',  -- 7+ days post forecast_date with no actual data
    'unresolvable_data_quality'  -- e.g. day flagged as anomaly-contaminated
  )) DEFAULT 'pending',

  CONSTRAINT unique_forecast_per_minute
    UNIQUE (business_id, forecast_date, surface, predicted_at)
);

CREATE INDEX idx_dfo_business_date ON daily_forecast_outcomes (business_id, forecast_date DESC);
CREATE INDEX idx_dfo_pending_resolution
  ON daily_forecast_outcomes (forecast_date)
  WHERE resolution_status = 'pending';
CREATE INDEX idx_dfo_surface_business
  ON daily_forecast_outcomes (surface, business_id, forecast_date DESC);
CREATE INDEX idx_dfo_inputs_snapshot
  ON daily_forecast_outcomes USING gin (inputs_snapshot);
```

### `inputs_snapshot` structure

JSONB blob captured at prediction time. Captures every signal that contributed to the prediction so we can later answer "would the new model have done better on this historical case?"

```json
{
  "yoy_same_weekday": {
    "lookup_date": "2025-05-10",
    "revenue": 28400,
    "trailing_12m_growth_multiplier": 1.04,
    "available": true
  },
  "recent_4_weeks_same_weekday": {
    "values": [29100, 30200, 31000, 28800],
    "average": 29775,
    "stddev": 970
  },
  "recent_8_weeks_same_weekday": {
    "average": 29200,
    "stddev": 1340
  },
  "weather_forecast": {
    "temp_max_c": 18.5,
    "temp_min_c": 9.0,
    "precip_mm": 0.0,
    "condition": "clear",
    "bucket": "warm_dry",
    "source": "open_meteo",
    "fetched_at": "2026-05-08T17:30:00Z"
  },
  "weather_lift_factor": 1.08,
  "weather_change_vs_seasonal": {
    "delta_from_30d_norm_c": 4.2,
    "applied_multiplier": 1.05
  },
  "holiday": {
    "is_holiday": false,
    "name": null,
    "type": null,
    "lift_factor": 1.0
  },
  "klamdag": {
    "is_klamdag": false,
    "adjacent_holiday": null,
    "factor": 1.0
  },
  "school_holiday": {
    "active": false,
    "name": null,
    "region": "stockholms_lan"
  },
  "salary_cycle": {
    "day_of_month": 9,
    "days_since_25th": 14,
    "phase": "mid_month",
    "factor": 1.0
  },
  "this_week_scaler": {
    "applied": 1.02,
    "clamped_at_max": false,
    "clamped_at_min": false
  },
  "weights_used": {
    "yoy_same_weekday": 0.25,
    "recent_4_weeks": 0.45,
    "recent_8_weeks": 0.30
  },
  "data_quality_flags": []
}
```

### `error_attribution` structure

Filled in by the reconciler. Identifies which input contributed most to the error.

```json
{
  "primary_factor": "weather_forecast_off",
  "factor_breakdown": {
    "baseline_contribution_pct": -2.1,
    "weather_lift_contribution_pct": 8.4,
    "holiday_contribution_pct": 0.0,
    "klamdag_contribution_pct": 0.0,
    "this_week_scaler_contribution_pct": -0.3,
    "llm_adjustment_contribution_pct": null
  },
  "weather_forecast_actual_delta": {
    "predicted_temp_max": 18.5,
    "actual_temp_max": 11.0,
    "predicted_precip_mm": 0.0,
    "actual_precip_mm": 8.4
  },
  "notes": "Forecast called for warm dry; actual was cool wet. Weather lift overestimated by 8.4%."
}
```

This is the heart of the learning system. With this attribution, we can answer:
- Which signals contribute most to errors?
- Are we systematically wrong on certain weather conditions?
- Is the LLM adjustment helping or hurting?

---

## Section 3 — The consolidated forecaster

### The function

A single canonical `dailyForecast()` that everything reads from. Replaces the two existing daily-grain forecasters (scheduling-AI's `est_revenue` and weather-demand's `predicted_revenue`).

```typescript
// lib/forecast/daily.ts

export type DailyForecast = {
  predicted_revenue: number
  baseline: number
  components: {
    yoy_contribution: number
    recent_trend_contribution: number
    weather_lift: number
    weather_change_adjustment: number
    holiday_adjustment: number
    klamdag_adjustment: number
    school_holiday_adjustment: number
    salary_cycle_adjustment: number
    this_week_scaler: number
  }
  confidence: 'high' | 'medium' | 'low'
  inputs_snapshot: ForecastInputsSnapshot
  model_version: string
}

export async function dailyForecast(
  businessId: string,
  date: Date,
  options?: {
    skipLogging?: boolean       // for backfill / what-if analysis
    overrideModelVersion?: string // for A/B testing model versions
  }
): Promise<DailyForecast>
```

### Computation logic

Pseudocode of what the function actually does:

```
1. Load inputs in parallel:
   - daily_metrics for: same weekday last year, last 4 weeks, last 8 weeks
   - weather_daily for: this date's forecast, this date's seasonal norm
   - holiday calendar for: this date and adjacent dates (klämdag check)
   - school holiday calendar for: this date
   - business calibration: per-business weights (or defaults if N<30 days)

2. Filter out anomaly-contaminated days from baseline calculations
   (anomaly_alerts.status = 'confirmed' for the source date)

3. Compute baseline as weighted combination:
     baseline =
       w_yoy   * (yoy_same_weekday_revenue × trailing_12m_growth_multiplier) +
       w_4wk   * recent_4_weeks_same_weekday_average +
       w_8wk   * recent_8_weeks_same_weekday_average

   Initial weights: w_yoy = 0.25, w_4wk = 0.45, w_8wk = 0.30
   These get tuned by the learning loop (Section 7) over time.

4. Apply multiplicative adjustments in fixed order:
     adjusted = baseline
     adjusted *= weather_lift_factor          (from weather bucket × business history)
     adjusted *= weather_change_factor        (current vs seasonal norm)
     adjusted *= holiday_lift_factor          (1.0 if not a holiday)
     adjusted *= klamdag_factor               (per-business; default 0.85 for non-tourist)
     adjusted *= school_holiday_factor        (per-business; can be < or > 1.0)
     adjusted *= salary_cycle_factor          (per-business)
     adjusted *= this_week_scaler             (clamped to [0.85, 1.15])

5. Compute confidence:
     - 'high'   if all signals available AND business has >180 days history
     - 'medium' if some signals missing OR business has 60-180 days history
     - 'low'    if many signals missing OR business has <60 days history

6. Build inputs_snapshot (full provenance)

7. If !options.skipLogging:
     INSERT INTO daily_forecast_outcomes
     (surface = 'consolidated_daily', model_version = current version)

8. Return DailyForecast
```

### Sample-size guardrails

Every signal has a minimum-sample requirement before it contributes:

| Signal                         | Min samples | Fallback if insufficient                     |
|--------------------------------|-------------|----------------------------------------------|
| yoy_same_weekday               | 1 valid day | Drop term, redistribute weight to recent     |
| recent_4_weeks_same_weekday    | 3 of 4 days | Drop term, fall back to recent_8_weeks       |
| recent_8_weeks_same_weekday    | 5 of 8 days | Use whatever is available; flag low_conf     |
| weather_lift_factor            | 10 days same bucket | Use 1.0 (no lift)                       |
| holiday_lift_factor            | 1 prior occurrence | Use cluster default (Section 8) or 1.0  |
| klamdag_factor                 | 2 prior klämdag observations | Use 0.90 (general default)        |
| school_holiday_factor          | 1 prior occurrence | Use 1.0                                 |
| salary_cycle_factor            | Computable from any 30+ days | Use 1.0 if insufficient        |

**This prevents the dow_factors=0.009 trap** identified in the investigation. Every multiplier checks that it has enough evidence before applying. Insufficient evidence → multiplier becomes 1.0 (no effect), not some near-zero garbage value.

### Migration path from existing forecasters

Phase A — Shadow mode (Weeks 6-7):
- `dailyForecast()` is implemented and logs to `daily_forecast_outcomes` with surface = 'consolidated_daily'
- Both legacy forecasters keep running and keep writing to their existing tables AND to `daily_forecast_outcomes` (as 'scheduling_ai_revenue' / 'weather_demand')
- Nothing in the UI changes
- After 2 weeks of shadow data, compare MAPE across the three surfaces

Phase B — Switchover (Week 8, conditional):
- If `consolidated_daily` MAPE is at parity or better than the legacy surfaces:
  - Switch `/api/scheduling/ai-suggestion` to read from `dailyForecast()`
  - Switch `/api/weather/demand-forecast` to read from `dailyForecast()`
  - Keep logging legacy surfaces for one more month (in case we need to revert)
- If `consolidated_daily` MAPE is worse:
  - Investigate why before switching
  - This is exactly the scenario the audit ledger was built to handle — we can see *which* surfaces are better in *which* conditions

Phase C — Deprecation (Week 12):
- Stop logging the legacy surfaces
- Keep the lib functions in case we want to re-enable for comparison
- Document the deprecation in CHANGELOG


---

## Section 4 — Signals: what's used today, what we're adding

### Already used in the existing forecasters

- Per-business per-weekday rolling baselines
- Weather bucket multipliers (when `weather_daily` exists; **currently broken in prod — see Piece 0**)
- Swedish public holidays (binary flag, type-aware lift)
- This-week scaler clamp

### New signals we're adding

For each: derivation logic, data dependencies, and expected impact.

#### 1. Year-over-year same-weekday

**Logic:** For target date, find the same weekday closest to one year prior. Apply trailing-12-month revenue growth multiplier.

```
target = 2026-05-09 (Saturday)
candidates = [2025-05-10 (Sat), 2025-05-03 (Sat), 2025-05-17 (Sat)]
pick = closest by date = 2025-05-10
yoy_value = revenue(2025-05-10) × (revenue_last_12m / revenue_prior_12m)
```

**Dependencies:** `daily_metrics` with 12+ months of history. Vero has this.
**Min samples:** 1 valid lookup day. If contaminated by anomaly, drop the term.
**Why it matters:** The single strongest predictor of "what will Saturday May 9 look like" is "what did Saturday May 10 last year look like, adjusted for growth."

#### 2. Klämdag (squeeze-day) effect

**Logic:** A weekday between a holiday and a weekend. Examples:
- Holiday on Thursday → Friday is klämdag → many people take it off → lunch/business restaurants see big drops, tourist/leisure sees small lifts
- Holiday on Tuesday → Monday is klämdag → similar pattern

```
def is_klamdag(date):
    if is_weekend(date) or is_holiday(date):
        return False
    # Klämdag if adjacent to holiday and weekend forms a 4-day stretch
    if is_holiday(date - 1d) and is_weekend(date + 1d):
        return True  # Friday after Thursday holiday
    if is_holiday(date + 1d) and is_weekend(date - 1d):
        return True  # Monday before Tuesday holiday
    return False
```

**Dependencies:** Holiday calendar only. No new data needed.
**Min samples:** 2 prior klämdag observations for this business. Cluster default = 0.90.
**Why it matters:** Restaurants in business districts vs tourist areas have opposite klämdag effects. Currently neither is captured.

#### 3. School holidays

**Logic:** Sweden has region-specific school holiday calendars. Each region's `sportlov` (winter break) falls on a different week. Same for `höstlov` (autumn break). `Påsklov`, `sommarlov`, and `jullov` are more uniform.

**Dependencies:** Public Skolverket calendar data, mapped per region. Vero is in Stockholms län, region code 'STHM'. Need a `school_holidays` table:

```sql
CREATE TABLE school_holidays (
  id BIGSERIAL PRIMARY KEY,
  region TEXT NOT NULL,         -- 'STHM', 'GBG', 'MMX', etc.
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  name TEXT NOT NULL,           -- 'sportlov', 'paasklov', etc.
  source TEXT NOT NULL,         -- 'skolverket'
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (region, start_date, name)
);
```

**Min samples:** 1 prior occurrence of the same school_holiday.name for this business.
**Why it matters:** A family-friendly restaurant has very different demand during sportlov vs a normal week. Currently the system has no idea.

#### 4. Salary cycle (Swedish payday is the 25th)

**Logic:** Day-of-month feature. Specifically:
- `days_since_last_25th`: integer 0-30
- `is_post_payday_week`: binary (true if days_since_last_25th < 7)
- `is_pre_payday_week`: binary (true if days_until_next_25th < 7)

Per-business factor learned over time.

**Dependencies:** Just the date. No external data needed.
**Min samples:** 30 days of business history.
**Why it matters:** Swedish spending patterns follow the 25th-of-month payday. Lunch traffic in office areas drops in the last week before payday and spikes the week after. Currently invisible to the system.

#### 5. Weather change relative to seasonal norm

**Logic:** Today's weather forecast relative to the 30-day rolling average for this calendar date over previous years.

```
seasonal_norm = avg(weather on date.month/date.day across prior years)
delta = today_forecast - seasonal_norm
```

A 18°C day in May (delta = +6°C) drives more lift than an 18°C day in July (delta = -3°C). Same temperature, different effect.

**Dependencies:** `weather_daily` with at least 1 prior year of history. **Blocked until Piece 0 fixes weather_daily.**
**Min samples:** 1 year of weather history.
**Why it matters:** The current weather bucket system treats temperature as an absolute. The first warm day of spring is a different event than a typical July day at the same temp. People go out when it's warmer than expected, not just when it's warm.

#### 6. Day-of-month patterns

**Logic:** Some businesses have month-start spikes (corporate accounts pay on the 1st, payday lunch crowds, monthly celebrations). Captured by including `day_of_month` as a feature in the per-business calibration.

**Dependencies:** Just the date.
**Min samples:** 60 days of business history.
**Why it matters:** Generic for non-payday-cycle effects. Corporate B2B businesses see distinct month-start vs month-end patterns invisible to the current weekday baseline.

### Signal addition strategy

Don't add all six at once. Add them one at a time, starting Week 8:

1. Week 8: yoy_same_weekday (highest expected impact, no new data needed)
2. Week 9: klämdag (no new data, easy to verify)
3. Week 10: salary cycle (no new data)
4. Week 11: school holidays (requires Skolverket scraper, more work)
5. Week 12: weather_change_vs_seasonal (depends on weather_daily being fixed)
6. Week 13: day_of_month patterns (calibrated from accumulated audit data)

After each addition, wait 7-14 days, then check the audit log: did MAPE improve? If a signal didn't help, **cut it**. The audit ledger is what gives us the right to be honest about what works.

---

## Section 5 — Capture and reconciliation

### Capture sites

Three places where predictions are generated:

1. **`/api/forecast/daily`** — new endpoint. Returns a `DailyForecast` for any (business_id, date) tuple. Internally calls `dailyForecast()` which logs to `daily_forecast_outcomes`. This becomes the canonical source.

2. **Scheduling agent** (existing `/api/scheduling/ai-suggestion`) — switched in Phase B to call `dailyForecast()` instead of computing inline. Inherits logging.

3. **Demand forecast** (existing `/api/weather/demand-forecast`) — switched in Phase B to call `dailyForecast()`. Inherits logging.

After Phase B all three call paths produce one `daily_forecast_outcomes` row per (business_id, forecast_date, surface='consolidated_daily', predicted_at). Different consumers reading the same forecast within the same minute is idempotent — second write fails on the unique constraint, returns the existing row.

### Idempotency

The unique constraint `(business_id, forecast_date, surface, predicted_at)` is intentionally minute-grained, not day-grained. Reasoning:

- We *want* to log every prediction generation, not just the first of the day.
- If model_version changes mid-day (e.g. we deploy a new version), the next prediction is a real new prediction with different inputs.
- The downstream MAPE calculation uses the *latest* prediction per (business_id, forecast_date) — see reconciler logic below.

```sql
-- the "current" prediction for a given day is the latest one
SELECT * FROM daily_forecast_outcomes
WHERE business_id = ? AND forecast_date = ? AND surface = 'consolidated_daily'
ORDER BY predicted_at DESC
LIMIT 1;
```

### Reconciler cron

Schedule: **07:30 UTC daily**. Runs after master-sync (05:00) and after the existing AI reconciler (07:00).

```typescript
// crons/dailyForecastReconciler.ts

async function reconcileDailyForecasts() {
  // 1. Find all unresolved forecasts with forecast_date < today
  const pending = await db.query(`
    SELECT DISTINCT ON (business_id, forecast_date, surface)
      id, business_id, forecast_date, surface,
      predicted_revenue, baseline_revenue, inputs_snapshot
    FROM daily_forecast_outcomes
    WHERE resolution_status = 'pending'
      AND forecast_date < CURRENT_DATE
    ORDER BY business_id, forecast_date, surface, predicted_at DESC
  `);

  for (const row of pending) {
    const actual = await db.query(`
      SELECT revenue
      FROM daily_metrics
      WHERE business_id = $1 AND date = $2
    `, [row.business_id, row.forecast_date]);

    if (!actual && daysSince(row.forecast_date) > 7) {
      await markUnresolvableNoActual(row.id);
      continue;
    }

    if (!actual) {
      continue; // try again tomorrow
    }

    // Check if the date is anomaly-contaminated
    const isAnomaly = await db.query(`
      SELECT 1 FROM anomaly_alerts
      WHERE business_id = $1 AND date = $2 AND status = 'confirmed'
    `, [row.business_id, row.forecast_date]);

    if (isAnomaly) {
      await markUnresolvableDataQuality(row.id);
      continue;
    }

    const errorPct = (row.predicted_revenue - actual.revenue) / actual.revenue;
    const attribution = await computeErrorAttribution(row, actual.revenue);

    await db.query(`
      UPDATE daily_forecast_outcomes
      SET actual_revenue = $1,
          error_pct = $2,
          error_attribution = $3,
          resolved_at = NOW(),
          resolution_status = 'resolved'
      WHERE id = $4
    `, [actual.revenue, errorPct, attribution, row.id]);
  }
}
```

### Error attribution logic

Given a resolved prediction, compute which input contributed most to the error:

```typescript
async function computeErrorAttribution(forecast, actual) {
  const snapshot = forecast.inputs_snapshot;
  const totalErrorPct = (forecast.predicted_revenue - actual) / actual;

  // For each multiplier in the chain, compute what the prediction would have been
  // if that multiplier had been 1.0. The difference is that multiplier's contribution.

  const baselineOnly = computeBaselineFromSnapshot(snapshot);
  const baselineErrorPct = (baselineOnly - actual) / actual;

  const weatherContribution = totalErrorPct - errorWithoutMultiplier(snapshot, 'weather');
  const holidayContribution = totalErrorPct - errorWithoutMultiplier(snapshot, 'holiday');
  // ... etc for each multiplier

  // Identify primary factor: the multiplier whose contribution most closely
  // matches the total error
  const factors = [
    { name: 'baseline', contribution: baselineErrorPct },
    { name: 'weather_forecast_off', contribution: weatherContribution },
    { name: 'holiday_lift_off', contribution: holidayContribution },
    // ...
  ];

  const primaryFactor = factors.reduce((max, f) =>
    Math.abs(f.contribution) > Math.abs(max.contribution) ? f : max
  );

  return {
    primary_factor: primaryFactor.name,
    factor_breakdown: Object.fromEntries(factors.map(f => [f.name, f.contribution])),
    weather_forecast_actual_delta: await fetchWeatherActuals(forecast),
    notes: generateAttributionNote(primaryFactor, snapshot)
  };
}
```

This is what makes the audit log learnable. Without attribution, all we know is "the prediction was wrong." With attribution, we know "the prediction was wrong because the weather forecast called for sun and it rained" — and we can adjust how much we trust weather forecasts going forward.

### Admin accuracy view

A small route at `/admin/predictions/accuracy` showing:
- Rolling 7/30/90-day MAPE per business per surface
- MAPE trend chart (sparkline)
- Distribution of error_attribution.primary_factor
- List of recent unresolved predictions
- Per-signal contribution to error (which signals are helping vs hurting)

This is admin-only initially. When we go loud (Section 1, post-N≥3 customers), the per-business view becomes operator-facing.


---

## Section 6 — LLM adjustment layer

### Purpose

The LLM does not predict revenue from scratch. It adjusts a math baseline based on context the math doesn't see, and it produces an operator-facing explanation.

Concretely, the LLM is good at:
- Recognizing patterns the math hasn't learned yet (klämdag effects in their first occurrence, school holiday + good weather combinations, anomaly carryover)
- Reading owner-flagged events that aren't in any structured field ("private event Saturday evening, expect quiet lunch")
- Producing the narrative explanation operators need to trust and act on the prediction
- Catching cases where multiple signals point opposite directions and reasoning about which dominates

The LLM is bad at:
- Producing accurate numbers from scratch
- Being deterministic (we get different outputs for the same inputs)
- Being fast (every call takes seconds, not milliseconds)
- Being free (every call costs money)

So: math produces the number, LLM adjusts and explains.

### Activation criteria

The LLM layer activates per-business when **all** of the following are true:

1. At least 30 days of audit data exist in `daily_forecast_outcomes` for this business
2. The consolidated_daily MAPE for this business is being tracked (i.e. reconciler is producing rows)
3. Per-business kill switch is not set (admin override)
4. Cost cap not exceeded (per-business budget for LLM calls — see Cost section below)

Until these are met, only the consolidated_daily prediction is shown to operators. No LLM adjustment.

### Prompt structure

```typescript
async function generateAdjustment(
  forecast: DailyForecast,
  context: AdjustmentContext
): Promise<LLMAdjustment> {

  const recentReconciliation = await fetchRecentReconciliation(
    forecast.business_id,
    { days: 90 }
  );

  const upcomingContext = {
    holidays_next_14d: await fetchUpcomingHolidays(14),
    school_holidays_active: await fetchActiveSchoolHolidays(forecast.business_id),
    weather_forecast: forecast.inputs_snapshot.weather_forecast,
    recent_anomalies: await fetchRecentAnomalies(forecast.business_id, { days: 14 }),
    owner_flagged_events: await fetchOwnerFlaggedEvents(forecast.business_id, forecast.date),
    learned_patterns: await fetchLearnedPatterns(forecast.business_id)
  };

  const systemPrompt = `You are a forecast adjustment system for a Swedish restaurant.

Your job: take a math-based revenue prediction and adjust it ONLY when there is concrete reason to believe the math missed something. Default to no adjustment.

You will receive:
- The baseline math prediction with its full input snapshot
- The recent reconciliation history (how accurate this business's predictions have been)
- The upcoming context (holidays, weather, anomalies, owner-flagged events, learned patterns)

Output ONLY valid JSON matching this schema:
{
  "baseline_prediction": <number, copy from input>,
  "adjusted_prediction": <number>,
  "adjustment_pct": <number, signed, e.g. 0.078 for +7.8%>,
  "adjustment_reasoning": <string, 1-3 sentences, in plain Swedish or English matching operator's locale>,
  "confidence": "high" | "medium" | "low",
  "override_applied": <boolean, true if you changed the number>
}

Rules:
- If you don't have a concrete reason to adjust, set adjusted_prediction = baseline_prediction and override_applied = false.
- Adjustments larger than ±15% require an explicit reason in reasoning. Cap adjustments at ±25%.
- Never invent context. Only use the data provided.
- Confidence reflects how certain you are about the *direction* of adjustment, not the magnitude.`;

  const userPrompt = JSON.stringify({
    forecast_date: forecast.date,
    baseline_prediction: forecast.predicted_revenue,
    components: forecast.components,
    inputs_snapshot: forecast.inputs_snapshot,
    recent_reconciliation: recentReconciliation,
    upcoming_context: upcomingContext
  }, null, 2);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  return parseAndValidate(response);
}
```

### Output schema (strict)

```typescript
type LLMAdjustment = {
  baseline_prediction: number
  adjusted_prediction: number
  adjustment_pct: number          // signed, e.g. -0.05 for -5%
  adjustment_reasoning: string
  confidence: 'high' | 'medium' | 'low'
  override_applied: boolean
}
```

The adjusted prediction is logged to `daily_forecast_outcomes` with surface = 'llm_adjusted', and the same `forecast_date`. Both the baseline and the adjusted prediction get reconciled. After 90 days we can directly compare which surface has lower MAPE.

### Kill switch criteria

Per-business automatic kill switch:

```
After 90 days of LLM-adjusted predictions for a business:
  baseline_mape   = avg MAPE of consolidated_daily predictions
  adjusted_mape   = avg MAPE of llm_adjusted predictions

  If adjusted_mape >= baseline_mape:
    auto-disable LLM adjustment for this business
    log decision with rationale
    notify admin

  If adjusted_mape < baseline_mape - 0.02:
    confirm LLM is adding value (>2pp improvement)

  If between (no clear win, no clear loss):
    keep enabled, monitor
```

Manual kill switch: admin route `/admin/predictions/llm/disable?business_id=X` sets a flag in business config. Useful for debugging or if a business explicitly opts out.

Globally killable: a feature flag `LLM_ADJUSTMENT_ENABLED` defaults to true but can be flipped to disable across all businesses immediately if something is badly wrong.

### Cost projection

Haiku 4.5 pricing (verify before launch — pricing changes):
- Input: ~$1/MTok
- Output: ~$5/MTok
- Per call: ~3,000 input tokens (prompt + context) + ~400 output tokens
- Per call cost: ~$0.005

Forecasting horizon: we generate predictions for the next 14 days. If we adjust each day each morning:
- 14 calls/business/day × $0.005 = $0.07/business/day
- $2.10/business/month

At customer counts:
- 1 customer (Vero): ~$2/month
- 10 customers: ~$21/month
- 50 customers: ~$105/month
- 500 customers: ~$1,050/month

Negligible vs subscription revenue at any scale we plan for. But worth budgeting and tracking — set up Anthropic API spend monitoring before activation.

**Cost optimization for later:** We don't need to re-adjust every day. If nothing has changed (no new reconciliation data, no schedule change, no owner-flagged event), the previous adjustment is still valid. Cache and re-use. Halves the cost.

---

## Section 7 — Pattern extraction and feedback

### Purpose

The LLM adjustment layer (Section 6) makes per-prediction adjustments based on context. The pattern extraction layer (Section 7) reads the accumulated audit log and extracts *systematic* patterns that the math model should incorporate.

This is how the system becomes its own teacher.

### The weekly job

Schedule: Sunday 02:00 UTC. Why Sunday: gives us a clean week boundary; restaurant data is typically less active overnight.

```typescript
async function extractPatterns(businessId: string) {
  const recent = await fetchRecentResolutions(businessId, { days: 60 });

  if (recent.length < 30) {
    return; // not enough data
  }

  const systemPrompt = `You are a pattern extraction system. Given 60 days of revenue prediction outcomes for a Swedish restaurant, identify systematic patterns in the prediction errors.

A "pattern" is a consistent, evidence-backed observation that suggests the math model could be improved.

You will receive an array of resolved predictions, each with:
- forecast_date, day_of_week, predicted_revenue, actual_revenue, error_pct
- inputs_snapshot (all signals at prediction time)
- error_attribution (which signal contributed most to the error)

Output ONLY valid JSON matching:
{
  "patterns_found": [
    {
      "description": <string, plain language>,
      "condition": <string, formal description e.g. "weekday=Saturday AND month IN (6,7,8)">,
      "evidence_count": <integer, number of predictions matching this condition>,
      "average_error_pct": <number>,
      "suggested_adjustment": {
        "type": "multiplier" | "weight_shift" | "investigation",
        "details": <string>
      },
      "confidence": "high" | "medium" | "low"
    }
  ],
  "patterns_invalidated": [
    {
      "previous_pattern_id": <string>,
      "reason": <string>
    }
  ]
}

Rules:
- A pattern requires at least 5 matching observations. Below that, do not output it.
- "Confidence: high" requires at least 10 observations and consistent direction.
- Don't speculate beyond the data. If you don't see a pattern, output an empty array.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: JSON.stringify({ recent_resolutions: recent }) }]
  });

  const result = parseAndValidate(response);
  await storePatterns(businessId, result);
}
```

### Storage schema

```sql
CREATE TABLE forecast_patterns (
  id BIGSERIAL PRIMARY KEY,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  cluster_id TEXT,                 -- null for per-business; populated for cross-customer (Section 8)
  description TEXT NOT NULL,
  condition_formal TEXT NOT NULL,  -- structured condition for matching
  evidence_count INTEGER NOT NULL,
  average_error_pct NUMERIC(8,4),
  suggested_adjustment JSONB,
  confidence TEXT CHECK (confidence IN ('high', 'medium', 'low')),
  status TEXT CHECK (status IN ('proposed', 'active', 'invalidated', 'rejected')) DEFAULT 'proposed',
  found_at TIMESTAMPTZ DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  invalidation_reason TEXT
);

CREATE INDEX idx_patterns_business_active ON forecast_patterns (business_id, status)
  WHERE status = 'active';
CREATE INDEX idx_patterns_cluster_active ON forecast_patterns (cluster_id, status)
  WHERE status = 'active' AND cluster_id IS NOT NULL;
```

### Pattern lifecycle

1. **proposed** — LLM job has identified a pattern. It's logged but not yet acting on the model.
2. **active** — Reviewed (initially manually; later auto-promoted with evidence_count >= 10) and now read by the LLM adjustment layer as additional context.
3. **invalidated** — A subsequent extraction run found this pattern no longer holds. Logged with reason.
4. **rejected** — Admin manually marked as not useful. Won't be re-proposed for 90 days.

### Two consumption paths

**Path A — Read by the LLM adjustment layer.** Active patterns are passed as additional context in the LLM adjustment prompt. The LLM reads "this business has been historically underpredicted by 12% on summer Saturdays" and incorporates it into the next prediction.

**Path B — Re-weight the math model.** Some patterns translate to direct math adjustments. If the pattern is "yoy_same_weekday is overweighted; recent trend should weigh more for this business," that's a direct change to the weights in the consolidated forecaster. This requires explicit promotion from pattern → weight change, with admin review initially.

In v1 we only build Path A. Path B is Piece 5+, after we have many patterns and confidence in the extraction quality.

### What the operator sees

A small "What we've learned" panel in the admin/insights area:

- "We noticed Saturdays in summer have been busier than predicted by an average of 12%."
- "We noticed klämdag Fridays here have been about 15% slower than weekday baselines."
- "We noticed the OB-supplement anomaly that's been firing daily appears to be a step change, not an anomaly. We've adjusted the baseline."

This is part of the moat. Nobody else shows you what their system has learned about your business.

---

## Section 8 — Cross-customer extension

### What activates when N≥5

The architecture supports cross-customer learning from day 1, but it doesn't *do* cross-customer learning until we have enough customers. Specifically:

- **Cluster-level baselines.** When a new customer onboards, their first 30 days use cluster baselines (e.g. "Italian restaurants in Stockholm with covers/day in this range") rather than zero-history defaults.
- **Cluster-level patterns.** Patterns extracted across multiple businesses in the same cluster apply to all of them. "Italian restaurants in Stockholm see 18% lift on warm Saturdays in May" becomes context for every member of that cluster.
- **Cross-validation of per-business patterns.** If a per-business pattern matches what we see across the cluster, confidence increases. If it doesn't, it stays per-business.

### Cluster definition

A cluster is a `(cuisine, location_segment, size_segment)` tuple, plus optional descriptors. Initial dimensions:

- **cuisine**: italian, asian, nordic, casual, fine_dining, café, bar, fast_casual
- **location_segment**: city_center, residential, suburban, tourist_zone, business_district, transit_hub
- **size_segment**: small (<5K avg/day), medium (5K-25K avg/day), large (>25K avg/day)

A business can belong to multiple location_segments (e.g. central + tourist). Schema:

```sql
CREATE TABLE business_cluster_membership (
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  cluster_dimension TEXT NOT NULL,  -- 'cuisine', 'location_segment', 'size_segment'
  cluster_value TEXT NOT NULL,
  manually_set BOOLEAN DEFAULT FALSE,
  set_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (business_id, cluster_dimension, cluster_value)
);

CREATE INDEX idx_cluster_lookup ON business_cluster_membership (cluster_dimension, cluster_value);
```

### Schema decisions made now (so we don't refactor later)

- **Every prediction tagged by business_id** (already in schema)
- **Every signal in inputs_snapshot tagged by scope:**
  - `universal` — applies everywhere (day-of-week, holiday flag)
  - `locale_se` — Swedish-specific (sportlov regions, 25th payday)
  - `locale_${country}` — placeholder for future expansion
  - `integration` — depends on POS/data integration (revenue, covers, labour)
- **Patterns table has cluster_id from day 1** (just null until we activate)
- **Reconciler can compute per-cluster aggregates** (joins, not refactors)

### What we explicitly defer

- **The cross-customer pattern extraction job.** Not built until we have N≥5 in at least one cluster.
- **Operator-facing "businesses like yours" insights.** Privacy implications need product/legal review before we activate.
- **Cold-start using cluster baselines.** Implementable now but pointless until clusters have data.

The point: the schema and code paths exist from week 1. The activation is a feature flag flip when we have data.

---


## Section 9 — Sequencing and milestones

### The 17-week plan

Calendar weeks. Each piece is independently shippable. Two breathing-room sprints for customer-facing work and continued AB/Stripe progress.

#### Weeks 1-2: Piece 0 — Foundation fixes

**Goal:** clean up data quality issues that would break any learning system built on top.

- Apply or reapply migration M015 (`weather_daily` table). Confirm forecasters degrade gracefully if it's still missing.
- Add minimum-sample guardrail to `forecast_calibration` cron. The Vero `dow_factors.0 = 0.009` Sunday value is a foot-gun — patch the cron to require ≥4 observations before writing a value, fall back to 1.0 otherwise.
- Adapt the OB-supplement anomaly detector to handle "new normal" baselines. Currently fires daily because the recent week is materially above the older 4-week baseline once a step change happens. Detector tuning, not prediction work, but it dominates the dashboard alert pill we just designed for.
- Backfill `created_via` on the 21 pre-M047 `tracker_data` rows so audit lineage is complete.

**Ships:** measurable improvement in current prediction quality (weather_daily fix), end of daily false alerts (OB-supplement fix), clean lineage everywhere.

**Milestone:** dashboard alert pill is no longer the same OB-supplement message every day.

#### Week 3: Piece 1 — Daily forecast audit ledger

**Goal:** start capturing and reconciling daily forecasts. The foundation of everything downstream.

- Migration: create `daily_forecast_outcomes` table with the schema from Section 2.
- Capture: instrument both legacy forecasters (`/api/scheduling/ai-suggestion`, `/api/weather/demand-forecast`) to write to the new table whenever they produce a prediction. Surface = 'scheduling_ai_revenue' or 'weather_demand'.
- Reconciler cron: 07:30 UTC daily, joins `daily_metrics`, computes error and attribution.
- Admin view: `/admin/predictions/accuracy` showing rolling MAPE per surface.

**Ships:** every daily prediction is now logged with full provenance. Reconciler runs nightly. We can see which legacy forecaster has been more accurate.

**Milestone:** 14 days of audit data accumulated by end of Week 5.

#### Weeks 4-5: Customer-facing sprint #1

**Goal:** keep the product moving while audit data accumulates. Specific work decided closer to the time based on what's most pressing.

Likely candidates (from prior conversation):
- AB/Stripe completion if not done
- Whatever closes the next customer
- Polish work from the dashboard/scheduling/overheads sessions

**Ships:** customer-visible improvements. Maintains momentum.

#### Weeks 6-7: Piece 2 — Consolidated forecaster

**Goal:** unify the two daily forecasters into one canonical `dailyForecast()` function.

- Implement `lib/forecast/daily.ts` with the API from Section 3.
- Phase A — Shadow mode: `dailyForecast()` runs alongside legacy forecasters, logs to `daily_forecast_outcomes` as 'consolidated_daily', does not yet drive any UI.
- After 2 weeks of shadow data, compare MAPE.

**Ships:** shadow mode running. Comparison data visible in admin view.

**Milestone:** consolidated_daily has 14 days of resolved data by end of Week 9.

#### Weeks 8-9: Piece 3 — New signals, batch 1

**Goal:** add the signals derivable from existing data. Each signal addition is logged and measured.

Order:
- Week 8 day 1-3: yoy_same_weekday
- Week 8 day 4-7: klämdag detection
- Week 9 day 1-3: salary cycle
- Week 9 day 4-7: model_version bump, kick off Phase B switchover if MAPE supports it

After each addition, wait 5-7 days and check the audit log. If the signal didn't help, cut it.

**Ships:** consolidated_daily uses yoy, klämdag, and salary cycle signals. If MAPE is good, becomes the canonical forecaster (Phase B switchover).

#### Weeks 10-11: Customer-facing sprint #2

**Goal:** breathing room, continued customer work, AB/Stripe progress.

#### Weeks 12-13: Piece 3 continued — New signals, batch 2

**Goal:** finish the signal additions that require more data infrastructure.

- Week 12: school holidays — Skolverket scraper, `school_holidays` table, integration with consolidated forecaster
- Week 13: weather_change_vs_seasonal (depends on weather_daily history accumulating from Piece 0)
- Week 13: day_of_month patterns

**Ships:** all six new signals integrated. Audit log shows per-signal contribution to MAPE reduction.

#### Weeks 14-16: Piece 4 — LLM adjustment layer

**Goal:** add the LLM that adjusts predictions based on context the math doesn't see.

- Week 14: prompt engineering, output schema validation, kill switch infrastructure
- Week 15: integration with `dailyForecast()`, both predictions logged side-by-side
- Week 16: 1 week of live data, comparison of llm_adjusted vs consolidated_daily MAPE

**Ships:** LLM adjustment running for Vero. Operator sees adjusted prediction with reasoning. Both surfaces logged for comparison.

**Milestone:** kill-switch criteria defined and instrumented. We can prove (or disprove) that the LLM is adding value.

#### Week 17: Piece 5 — Pattern extraction (v1)

**Goal:** weekly LLM job that extracts systematic patterns from the audit log.

- Implement `extractPatterns()` from Section 7
- `forecast_patterns` table
- Sunday 02:00 UTC cron
- Admin view of proposed patterns
- Initially: patterns are read by humans, manually promoted to active

**Ships:** the system is now learning from itself. Visibly. With receipts.

### Beyond Week 17

- **Path B pattern → math weight changes** (Piece 5 v2): once we have a corpus of patterns and trust the extraction, automate the promotion pipeline.
- **Customer-facing accuracy view** (when N≥3): the admin view becomes operator-facing.
- **Cross-customer activation** (when N≥5 in any cluster): cluster baselines, cluster patterns, cold-start.
- **The marketing claim** (when we have receipts): "predictions get measurably more accurate the longer you use it" — provable from the data.

### What can be parallelized

- Piece 0 fixes are independent of each other; can be done in parallel by anyone who has time
- Piece 1 audit ledger schema and reconciler can be built in parallel (one person on schema/migration, one on cron)
- Signal additions (Piece 3) can be done in any order; pick the easiest first
- Piece 5 (pattern extraction) doesn't depend on Piece 4 (LLM adjustment) — could be earlier if Piece 4 hits a snag

### What absolutely cannot be reordered

- Piece 0 must come first. Fixing weather_daily and the calibration cron *changes* prediction quality. Doing this after Piece 1 means part of the audit data is from the broken state, polluting comparisons.
- Piece 1 must come before Piece 2-5. No audit ledger = no measurement = no learning.
- LLM adjustment (Piece 4) must come after consolidated forecaster (Piece 2) and after at least 30 days of audit data.

---

## Section 10 — Decisions still open

Things this document does not decide. They need explicit calls before implementation:

### 1. The specific MAPE target for the public claim

What error rate do we promise after 90 days of usage? Realistic bands for daily restaurant revenue forecasting:
- **<5%:** unrealistic without exceptional data quality
- **5-10%:** achievable with good data and 6+ months of history
- **10-15%:** realistic baseline target for the first 90 days
- **>15%:** indicates problems

I'd suggest committing publicly to "within 12% on average" as the 90-day target, while internally aiming for <10%. We commit to what we're confident we can hit.

**Decision needed:** what's the publicly-committed number?

### 2. Which model_versions are tracked separately

Every change to weights, signal additions, or kill-switch behavior changes the model. Do we treat each as a new model_version (lots of versions, fragmented MAPE comparisons) or only major changes (cleaner comparisons but harder to attribute regression)?

**Recommendation:** semver-style. `consolidated_v1.0.0` for initial. Bump minor for new signals (`v1.1.0`, `v1.2.0`). Bump major for breaking changes (different formula structure). Do not bump for weight tuning — that's continuous.

**Decision needed:** confirm or counter.

### 3. Operator visibility of the LLM reasoning

The LLM produces `adjustment_reasoning` text. Should this always be visible to the operator, or only when they click "why?", or only when adjustment_pct exceeds some threshold?

**Recommendation:** always visible but de-emphasized. Small italic line below the prediction. Shows respect for the operator's time and demonstrates the system isn't a black box.

**Decision needed:** UX call.

### 4. Cold-start strategy

What does the system show on day 1 of a new customer when there's no history?

**Options:**
- **Option A:** Show no predictions for the first 30 days. "We're learning your patterns. Predictions begin appearing on day 30."
- **Option B:** Show predictions from day 1 using cluster baselines (when N≥5) or industry defaults. Wide confidence bands.
- **Option C:** Show predictions from day 1 using just weather + day-of-week + holidays (no per-business signals). Marked as 'low confidence'.

**Recommendation:** Option C, transitioning to Option B once clusters exist. Option A is safer but the customer just paid for a product — showing nothing for a month feels broken.

**Decision needed:** product call.

### 5. Pattern extraction: per-business cadence vs global cadence

Run the weekly job at the same time for everyone (one cron at Sunday 02:00) or stagger across the week (smoother LLM cost curve, more complex)?

**Recommendation:** start with single global cadence. Stagger only if cost or rate-limit becomes a problem.

**Decision needed:** confirm.

### 6. Privacy and cross-customer learning

When we activate cluster-based features, we'll be using one customer's data to inform another customer's predictions. This is fine in aggregate (no individual data leaves the cluster) but needs to be documented in the privacy policy and ToS.

**Decision needed:** review with legal/founder before Piece 6 activates.

---

## Appendix A — Code paths to be touched

For implementation prompt scoping. This is a partial list based on the investigation report:

### Existing files modified
- `app/api/scheduling/ai-suggestion/route.ts` — instrumented for capture, eventually swapped for `dailyForecast()` call
- `app/api/weather/demand-forecast/route.ts` — instrumented for capture, eventually swapped
- `lib/forecast/recency.ts` — extended; this is where the consolidated forecaster builds on
- `lib/weather/demand.ts` — most logic lifted into `dailyForecast()`; this file becomes thin
- `crons/dailyMasterSync.ts` (or wherever the existing 05:00 cron lives) — no change, just sequencing context
- `crons/aiForecastReconciler.ts` (M020 cron) — no change; new cron runs after this

### New files
- `migrations/MXXX_daily_forecast_outcomes.sql`
- `migrations/MXXX_school_holidays.sql`
- `migrations/MXXX_forecast_patterns.sql`
- `migrations/MXXX_business_cluster_membership.sql`
- `lib/forecast/daily.ts` — the consolidated forecaster
- `lib/forecast/signals/yoy.ts`
- `lib/forecast/signals/klamdag.ts`
- `lib/forecast/signals/salary-cycle.ts`
- `lib/forecast/signals/school-holidays.ts`
- `lib/forecast/signals/weather-change.ts`
- `lib/forecast/llm-adjustment.ts` — the LLM layer
- `lib/forecast/pattern-extraction.ts` — the weekly job
- `app/api/forecast/daily/route.ts` — new canonical endpoint
- `crons/dailyForecastReconciler.ts`
- `crons/weeklyPatternExtraction.ts`
- `app/admin/predictions/accuracy/page.tsx`
- `app/admin/predictions/patterns/page.tsx`

### Implementation prompts to write (after this doc is approved)
- **Prompt 1:** Piece 0 foundation fixes (4 separate fixes, each scoped)
- **Prompt 2:** Piece 1 audit ledger (schema, capture, reconciler, admin view)
- **Prompt 3:** Piece 2 consolidated forecaster (function, shadow mode, MAPE comparison)
- **Prompt 4:** Piece 3 signal additions (one per signal, can run in parallel)
- **Prompt 5:** Piece 4 LLM adjustment layer
- **Prompt 6:** Piece 5 pattern extraction

Each prompt follows the same disciplined investigation-first pattern as scheduling/overheads/dashboard/this-investigation.

---

## Appendix B — What this architecture commits us to

A list of things that become true once this is built, that we should be aware of:

1. **Predictions are auditable.** Every number we show has a row in a database with full inputs. If a customer asks "why did you predict that," we can answer.

2. **The system has a track record.** We can show, with data, that predictions have improved over time. We can also show, with data, where they haven't. We don't get to hide misses.

3. **LLM costs scale linearly with customer count.** Cheap, but real. Need budget tracking.

4. **The audit log becomes a regulated artifact.** Predictions about a customer's business are now durable data we hold about them. Privacy policy needs to reflect this.

5. **Model changes are traceable.** Every change to the formula, the weights, the signals — versioned and logged. Enables rollback. Also enables "we improved Saturday predictions in v1.4" claims.

6. **The system is killable at every layer.** LLM layer can be disabled per-business or globally. New signals can be cut if they don't help. Patterns can be invalidated. The math model can be reverted.

7. **The moat is real but it takes time to manifest.** The marketing claim "more accurate the longer you use it" requires customers to use it for a while. There's no quick demo of this. The proof is the chart of MAPE-over-time per business.

8. **This investment crowds out other work.** 17 weeks of substantial engineering attention. AB/Stripe and customer-facing work continue in parallel but are constrained.

---

## Closing

This is a substantial document. It deserves to be read carefully, marked up, and discussed before anyone writes implementation code. The ten open decisions in Section 10 are real — they need explicit calls.

Sequencing-wise: I'd want at least one full day of reflection between this doc and the first implementation prompt (Piece 0). Not because the doc is wrong but because foundational architecture decisions made under time pressure tend to become regrets.

Three honest things about this doc:

1. **Some numbers in here are educated guesses.** Cost projections use Haiku 4.5 pricing as of early 2026 — verify before launch. MAPE targets are based on industry benchmarks for restaurant forecasting — confirm by looking at published research or running a baseline measurement first.

2. **Single-customer N=1 means some pieces are theoretical.** We can't validate the LLM adjustment layer against a baseline until we have meaningful audit data. The first 30-60 days after Piece 1 ships are observation time, not optimization time.

3. **The cross-customer extension is the real moat.** Per-customer learning is table stakes; cross-customer pattern aggregation is the differentiation. This document architects for it but doesn't build it. The actual differentiation work happens at customer #5+, not in the next 17 weeks.

What I want from you tomorrow morning:

- Read this through once carefully
- Mark the open decisions in Section 10 with your calls (or pushback)
- Confirm or counter the 17-week sequencing
- Tell me which Piece's implementation prompt to write first

We don't sprint into Piece 0 implementation tonight. The doc gets reviewed tomorrow with fresh eyes.

