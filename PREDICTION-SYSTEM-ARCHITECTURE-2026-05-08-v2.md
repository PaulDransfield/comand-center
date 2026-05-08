# Prediction System Architecture — v2

> Drafted 2026-05-08, evening session. Revised from v1 based on Claude Code's architecture review (`ARCHITECTURE-REVIEW-2026-05-08.md`).
> Architecture doc for the daily-grain forecasting and learning system.
> This is the foundation of CommandCenter's core differentiator.

---

## Changes from v1

This document is v1 corrected against codebase reality. The substantive changes:

1. **Anomaly contamination workflow.** v1 referenced `anomaly_alerts.status = 'confirmed'` — a column that doesn't exist. v2 adds proper owner-confirm workflow as Piece 0 work: new `confirmation_status` column on `anomaly_alerts`, API endpoints for owner to confirm/dismiss, dashboard UI for the alert pill. Filter for contamination uses the new column.
2. **YoY same-weekday correction.** v1 claimed "Vero has this." Investigation reality: Vero's first positive-revenue day is 2025-11-24, so daily YoY is silent until late 2026. v2 correctly sequences this signal as "available 2026-11+ for Vero" and adds YoY same-month from `monthly_metrics` (which Vero does have for 16 months) as an interim signal.
3. **Schema parity with M020.** v1 omitted `org_id`, RLS policies, and retention RPC. v2 mirrors M020's pattern verbatim. This was a privacy regression as written.
4. **Idempotency.** v1's unique constraint included `predicted_at`, making "second write returns existing row" impossible. v2 unique key is `(business_id, forecast_date, surface)` with `ON CONFLICT DO UPDATE`. Latest prediction wins.
5. **Truncation-to-once-per-day logging.** v1 logged every call; reality is the dashboard refreshes 20× a day with no-store. v2 truncates to one row per `(business, date, surface)` per day, updated on each call.
6. **Owner-flagged events as Piece 4.5.** v1 referenced `fetchOwnerFlaggedEvents()` against infrastructure that doesn't exist. v2 adds Piece 4.5 (table + API + UI) before Piece 5 reads from it.
7. **Inputs snapshot reflects actual signals.** v1 schema invented `recent_4_weeks_same_weekday`, `recent_8_weeks_same_weekday`, `weights_used` — these aren't what `lib/forecast/recency.ts` computes. v2 captures the actual concept (recency-weighted weekday baseline with 28-day cutoff and 2.0 multiplier) plus a `snapshot_version` field so legacy and consolidated surfaces have honest schemas.
8. **Cost projection rebuilt.** v1 estimated $2/business/month at 3K input tokens. Reality is 8-12K input tokens once recent reconciliation accumulates, ~$8-12/business/month at scale. Acknowledged plus rate-limit considerations at concurrent fire.
9. **Path corrections.** All `crons/X.ts` references corrected to `app/api/cron/X/route.ts`.
10. **Cron slot moved.** v1's Sunday 02:00 UTC pattern extraction conflicts with `api-discovery`. v2 uses 01:30 UTC.
11. **Existing infrastructure honored.** AI spend tracking via `lib/ai/usage.ts` and `ai_request_log` already exists — v2 uses it instead of treating as greenfield.
12. **`forecast_calibration.dow_factors` decision.** v1 left this dangling. v2 explicitly deprecates it; the consolidator's per-weekday rolling baselines replace it. The buggy cron is turned off in Piece 0.
13. **Phase B scope corrected.** v1 listed 2 consumers; reality is 4+ (dashboard chart, scheduling page, Monday Memo via direct import of `computeDemandForecast`, weekly stats helper). All staged separately.
14. **Zero-revenue handling.** v1 reconciler divides by actual revenue; Vero's closed Sundays cause division-by-zero. v2 defines `error_pct = NULL` for zero-actual rows and excludes them from MAPE.

The conservative marketing claim from v1 stands unchanged:

> "Predictions about your business get measurably more accurate the longer you use CommandCenter. We show you the track record. Better forecasts help you make smarter staffing and purchasing decisions."

---

## Section 1 — The accuracy claim and what it requires

### What we commit to

Per-business, per-surface MAPE (Mean Absolute Percentage Error) trends, visible in the product. Three specific commitments:

1. **Predictions are measurably more accurate after 90 days than after 30 days.** The MAPE trend line for next-week daily revenue forecasts trends downward as customer tenure increases.
2. **The track record is visible.** Customers can see their own prediction history — what we predicted, what actually happened, where we were close, where we missed.
3. **Misses are explained.** When a prediction was off, the system surfaces a likely reason. Operators don't have to trust a black box.

### What we explicitly do not commit to

- "Your costs will go down by X%." Labour cost as % of revenue moves for many reasons. Promising it creates an expectation we can't reliably hit.
- "Predictions will be within X% accuracy on day one." Cold-start accuracy is bad and there's no way around it.
- "Every prediction will be explained." The LLM adjustment layer produces explanations when it adjusts. Pure baseline predictions are explained by their math components.

### The metric

Primary: **MAPE on next-week daily revenue, computed weekly per business.**

```
MAPE_week_N = mean(|predicted - actual| / actual) over the 7 days of week N,
              EXCLUDING days where actual = 0 (closed days)
```

Zero-revenue days are excluded explicitly. Vero is closed Sundays plus most public holidays — that's 7-10 days per quarter where MAPE is undefined. Including them as "100% error" or "0% error" both lie. Excluding them is honest.

Secondary metrics:
- MAPE by weekday
- MAPE by surface
- **MAPE by horizon** — uses the `prediction_horizon_days` column derived from `first_predicted_at` (not `predicted_at`, which updates on every call)
- Prediction bias (signed mean error)

### What this requires from the architecture

- Audit ledger working from day 1 of every customer's tenure.
- `model_version` per row so we can compare apples to apples across changes.
- Reconciler runs reliably and idempotently every day.
- At least 30 days of audit data per business before any accuracy claim is shown to operators.

---

## Section 2 — Schema: `daily_forecast_outcomes`

### DDL

```sql
CREATE TABLE daily_forecast_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  forecast_date DATE NOT NULL,

  -- which forecaster produced this row
  surface TEXT NOT NULL CHECK (surface IN (
    'consolidated_daily',
    'scheduling_ai_revenue',
    'weather_demand',
    'llm_adjusted'
  )),

  -- the prediction itself (rounded to integer, matching daily_metrics.revenue)
  predicted_revenue INTEGER NOT NULL,
  baseline_revenue INTEGER,    -- math-only prediction before LLM adjustment

  -- timestamps
  first_predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  prediction_horizon_days INTEGER GENERATED ALWAYS AS
    (forecast_date - first_predicted_at::date) STORED,

  model_version TEXT NOT NULL,
  snapshot_version TEXT NOT NULL,    -- 'legacy_scheduling_ai_v1', 'legacy_weather_demand_v1', 'consolidated_v1', etc.
  inputs_snapshot JSONB NOT NULL,

  -- LLM-specific (null for non-LLM surfaces)
  llm_reasoning TEXT,
  confidence TEXT CHECK (confidence IN ('high', 'medium', 'low')),

  -- reconciliation columns (filled by daily cron)
  actual_revenue INTEGER,
  error_pct NUMERIC(8,4),    -- NULL for zero-actual days; otherwise (predicted - actual) / actual
  error_attribution JSONB,
  resolved_at TIMESTAMPTZ,
  resolution_status TEXT CHECK (resolution_status IN (
    'pending',
    'resolved',
    'unresolvable_no_actual',
    'unresolvable_data_quality',
    'unresolvable_zero_actual'    -- closed day, MAPE undefined, kept for record
  )) DEFAULT 'pending',

  CONSTRAINT unique_forecast_per_day_per_surface
    UNIQUE (business_id, forecast_date, surface)
);

CREATE INDEX idx_dfo_business_date ON daily_forecast_outcomes (business_id, forecast_date DESC);
CREATE INDEX idx_dfo_org_date ON daily_forecast_outcomes (org_id, forecast_date DESC);
CREATE INDEX idx_dfo_pending_resolution
  ON daily_forecast_outcomes (forecast_date)
  WHERE resolution_status = 'pending';
CREATE INDEX idx_dfo_surface_business
  ON daily_forecast_outcomes (surface, business_id, forecast_date DESC);
CREATE INDEX idx_dfo_horizon
  ON daily_forecast_outcomes (surface, prediction_horizon_days, forecast_date DESC)
  WHERE resolution_status = 'resolved';

-- RLS (matching M020 pattern)
ALTER TABLE daily_forecast_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY daily_forecast_outcomes_read ON daily_forecast_outcomes
  FOR SELECT
  USING (
    org_id IN (
      SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
    )
  );

-- No client-side INSERT/UPDATE/DELETE — service role only.

-- Retention RPC (3y matching M020)
CREATE OR REPLACE FUNCTION prune_daily_forecast_outcomes()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM daily_forecast_outcomes
  WHERE forecast_date < CURRENT_DATE - INTERVAL '3 years';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
```

### Idempotency: ON CONFLICT DO UPDATE

The unique key is `(business_id, forecast_date, surface)`. Multiple calls in a day update the same row:

```sql
INSERT INTO daily_forecast_outcomes (
  org_id, business_id, forecast_date, surface,
  predicted_revenue, baseline_revenue,
  predicted_at, model_version, snapshot_version, inputs_snapshot,
  llm_reasoning, confidence
) VALUES (
  $1, $2, $3, $4,
  $5, $6,
  NOW(), $7, $8, $9,
  $10, $11
)
ON CONFLICT (business_id, forecast_date, surface) DO UPDATE SET
  predicted_revenue = EXCLUDED.predicted_revenue,
  baseline_revenue = EXCLUDED.baseline_revenue,
  predicted_at = EXCLUDED.predicted_at,
  model_version = EXCLUDED.model_version,
  snapshot_version = EXCLUDED.snapshot_version,
  inputs_snapshot = EXCLUDED.inputs_snapshot,
  llm_reasoning = EXCLUDED.llm_reasoning,
  confidence = EXCLUDED.confidence
  -- first_predicted_at, prediction_horizon_days, and resolution columns DO NOT update
RETURNING id;
```

`first_predicted_at` is set on insert and never changes — that's what `prediction_horizon_days` is computed from. `predicted_at` updates each call so we can see when the latest version was produced. The reconciler reads the row in its current state when it runs.

### `inputs_snapshot` structure (consolidated_v1)

JSONB blob captured at prediction time. Reflects actual signals as they exist in the consolidated forecaster:

```json
{
  "snapshot_version": "consolidated_v1",
  "model_version": "consolidated_v1.0.0",
  "weekday_baseline": {
    "weekday": 6,
    "recency_weighted_avg": 29200,
    "recent_28d_samples": 4,
    "older_samples": 4,
    "recency_multiplier_applied": 2.0,
    "stddev": 1340,
    "anomaly_days_excluded": 1
  },
  "yoy_same_weekday": {
    "available": false,
    "reason": "insufficient_history_first_positive_day_2025-11-24"
  },
  "yoy_same_month": {
    "available": true,
    "lookup_month": "2025-05",
    "monthly_revenue": 842000,
    "trailing_12m_growth_multiplier": 1.04,
    "applied_as_baseline_anchor": false
  },
  "weather_forecast": {
    "temp_max_c": 18.5,
    "temp_min_c": 9.0,
    "precip_mm": 0.0,
    "condition": "clear",
    "bucket": "mild",
    "source": "open_meteo",
    "fetched_at": "2026-05-08T17:30:00Z"
  },
  "weather_lift": {
    "factor": 1.08,
    "samples_used": 14,
    "min_samples_met": true
  },
  "weather_change_vs_seasonal": {
    "available": false,
    "reason": "weather_daily_history_insufficient",
    "applied_factor": 1.0
  },
  "holiday": {
    "is_holiday": false,
    "name": null,
    "kind": null,
    "impact": null,
    "lift_factor": 1.0
  },
  "klamdag": {
    "is_klamdag": false,
    "adjacent_holiday_date": null,
    "adjacent_holiday_name": null,
    "samples_used": 0,
    "applied_factor": 1.0,
    "fallback_used": "national_default_0.90"
  },
  "school_holiday": {
    "active": false,
    "name": null,
    "kommun": "stockholm",
    "lan": "STHM",
    "applied_factor": 1.0
  },
  "salary_cycle": {
    "day_of_month": 9,
    "days_since_25th": 14,
    "days_until_25th": 16,
    "phase": "mid_month",
    "samples_used": 145,
    "applied_factor": 1.02
  },
  "this_week_scaler": {
    "raw": 1.04,
    "applied": 1.04,
    "clamped_at_max": false,
    "clamped_at_min": false,
    "scaler_floor": 0.75,
    "scaler_ceil": 1.25
  },
  "anomaly_contamination": {
    "checked": true,
    "contaminated_dates_in_baseline_window": ["2026-04-12"],
    "owner_confirmed_count": 1,
    "filter_predicate": "confirmation_status = 'confirmed'"
  },
  "data_quality_flags": []
}
```

### `inputs_snapshot` for legacy surfaces (legacy_v1)

Phase A logs both legacy forecasters with a strict subset schema:

```json
{
  "snapshot_version": "legacy_scheduling_ai_v1",
  "weekday_baseline_recency_weighted": 29200,
  "weather_bucket": "mild",
  "weather_lift_factor": 1.08,
  "this_week_scaler_applied": 1.04,
  "this_week_scaler_raw": 1.04,
  "holiday_lift_factor": 1.0,
  "data_quality_flags": []
}
```

Querying: any analysis that joins across surfaces filters on `snapshot_version` to know which fields exist. The `consolidated_v1` schema is a strict superset of `legacy_v1` — fields that don't exist in legacy are simply absent.

### `error_attribution` structure

Filled by the reconciler at resolution time:

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
    "available": false,
    "reason": "weather_daily_history_insufficient_for_actuals_lookup"
  },
  "notes": "Forecast called for warm dry; baseline assumed lift. Actual weather unavailable for delta computation."
}
```

`weather_forecast_actual_delta.available = false` is the honest answer when `weather_daily` doesn't have the resolved date's actual weather. Don't pretend.

---

## Section 3 — The consolidated forecaster

### The function

```typescript
// lib/forecast/daily.ts

export type DailyForecast = {
  predicted_revenue: number       // integer (rounded)
  baseline_revenue: number        // integer
  components: {
    weekday_baseline: number      // recency-weighted weekday average
    yoy_same_month_anchor: number | null  // if available, used as anchor for trend
    weather_lift_pct: number      // signed, e.g. 0.08 for +8%
    weather_change_pct: number
    holiday_lift_pct: number
    klamdag_pct: number
    school_holiday_pct: number
    salary_cycle_pct: number
    this_week_scaler: number      // multiplier as applied
  }
  confidence: 'high' | 'medium' | 'low'
  inputs_snapshot: ForecastInputsSnapshot
  model_version: string
  snapshot_version: string
}

export async function dailyForecast(
  businessId: string,
  date: Date,
  options?: {
    skipLogging?: boolean         // for backfill / what-if analysis
    overrideModelVersion?: string // for A/B testing
  }
): Promise<DailyForecast>
```

### Computation logic

```
1. Load inputs in parallel:
   - daily_metrics for: same weekday rolling window (28 days recent + older)
   - monthly_metrics for: same-month-last-year (anchor for YoY)
   - weather_daily for: this date's forecast, this date's seasonal norm
   - holiday calendar for: this date and adjacent dates (klämdag check)
   - school_holidays for: this date and business kommun
   - business calibration: per-business factors learned from audit history

2. Filter out anomaly-contaminated days from baseline:
   Predicate: anomaly_alerts.confirmation_status = 'confirmed'
   AND anomaly_alerts.metric = 'revenue'
   AND anomaly_alerts.period_date IN (baseline_window_dates)
   (See Section 5 for the new confirmation_status workflow built in Piece 0.)

3. Compute weekday baseline using recency.ts logic:
     baseline = recencyWeightedAverage(
       sameWeekdayDays,  // filtered for non-anomaly-confirmed days
       { recentWindowDays: 28, recencyMultiplier: 2.0 }
     )

4. Apply YoY anchor (if available):
   If yoy_same_month_anchor IS NOT NULL:
     trend_factor = (current_month_actual_so_far / yoy_same_month) * trailing_12m_growth
     baseline = baseline * trend_factor
   Else:
     no anchor; baseline stays as recency-weighted average

5. Apply multiplicative adjustments in fixed order:
     adjusted = baseline
     adjusted *= weather_lift_factor          (1.0 if min_samples not met)
     adjusted *= weather_change_factor        (1.0 if no seasonal history)
     adjusted *= holiday_lift_factor
     adjusted *= klamdag_factor
     adjusted *= school_holiday_factor
     adjusted *= salary_cycle_factor
     adjusted *= this_week_scaler             (clamped to [0.75, 1.25])

6. Round to integer.

7. Compute confidence:
     - 'high'   if all signals available AND business has >180 days history
     - 'medium' if some signals missing OR business has 60-180 days history
     - 'low'    if many signals missing OR business has <60 days history

8. Build inputs_snapshot with full provenance (every multiplier carries
   `samples_used` so we can distinguish "applied with low confidence"
   from "defaulted to 1.0 because insufficient data").

9. If !options.skipLogging:
     INSERT INTO daily_forecast_outcomes
     (surface = 'consolidated_daily', snapshot_version = 'consolidated_v1', ...)
     ON CONFLICT (business_id, forecast_date, surface) DO UPDATE SET ...

10. Return DailyForecast
```

### Sample-size guardrails

Every signal has minimum-sample requirements before it contributes. If insufficient, the multiplier defaults to 1.0 — never to a near-zero garbage value. The `inputs_snapshot` records `samples_used` for each multiplier so we can tell defaulted from learned.

| Signal                         | Min samples | Fallback if insufficient                 |
|--------------------------------|-------------|------------------------------------------|
| weekday_baseline               | 4 of last 8 | Use whatever exists; flag low_conf       |
| yoy_same_month                 | 1 prior month | Drop term, no anchor                   |
| weather_lift_factor            | 10 days same bucket | Use 1.0                            |
| weather_change_factor          | 1 prior year of same calendar week | Use 1.0           |
| holiday_lift_factor            | 1 prior occurrence | Cluster default or 1.0           |
| klamdag_factor                 | 2 prior klämdag observations | National default 0.90  |
| school_holiday_factor          | 1 prior occurrence (same name) | Cluster default or 1.0 |
| salary_cycle_factor            | 30 days history | Use 1.0                              |

### YoY same-weekday: explicit deferral for Vero

The investigation found Vero's first positive-revenue day in `daily_metrics` is 2025-11-24. Same-weekday-last-year lookups for any 2026 date before 2026-11-24 return no data.

**Decision:** YoY same-weekday is implemented but inactive for Vero until 2026-11-24. The `yoy_same_weekday.available = false` field in `inputs_snapshot` records this. As a substitute, **YoY same-month from `monthly_metrics`** (which Vero has for 16 months) provides a trend anchor. Less granular than same-weekday but gives the model some year-over-year signal immediately.

This is the architecturally honest answer: ship the signal, log the unavailability, swap in the better data when it arrives. Don't fake YoY as if Vero has 12 months of daily history.

### Migration path from existing forecasters

**Phase A — Shadow mode (Weeks 6-7):**
- `dailyForecast()` runs, logs to `daily_forecast_outcomes` as `consolidated_daily` with `snapshot_version = 'consolidated_v1'`.
- Both legacy forecasters keep running. They additionally log to `daily_forecast_outcomes` as `scheduling_ai_revenue` and `weather_demand` with `snapshot_version = 'legacy_scheduling_ai_v1'` and `'legacy_weather_demand_v1'` respectively.
- All three surfaces use `ON CONFLICT DO UPDATE` — multiple calls in a day update the same row.
- Nothing in the UI changes.
- After 2 weeks: compare MAPE across the three surfaces in admin view.

**Phase B — Switchover (Week 8, conditional):** 4+ consumers, staged separately:

1. **Switch `/api/scheduling/ai-suggestion`** to read from `dailyForecast()`. Keep legacy logic behind a feature flag `LEGACY_SCHEDULING_AI_FALLBACK`. Affects: `OverviewChart` (predicted bars), `scheduling/page.tsx` (full-page panel), `computeWeekStats` (sidebar aggregates).
2. **Switch `/api/weather/demand-forecast`** to read from `dailyForecast()`. Affects: dashboard demand outlook day cards.
3. **Switch Monday Memo** (`lib/ai/weekly-manager.ts:17,327` imports `computeDemandForecast` directly). The memo prompt receives a different shape — re-prompt-engineer to use `DailyForecast` shape. Test with one memo cycle before deploying.
4. **Switch any export/report templates** that bind to `est_revenue` or `predicted_revenue` directly. Audit needed in implementation phase.

Each is a separate PR with its own rollback flag. Don't ship them all in one go.

**Phase C — Deprecation (Week 12):**
- Stop logging legacy surfaces (i.e. legacy forecasters return data but don't insert audit rows).
- Remove `LEGACY_SCHEDULING_AI_FALLBACK` flag.
- Keep the lib functions in case re-comparison is needed.
- Delete after one stable month.

### Conflict with existing `forecast_calibration.dow_factors`

**Decision: deprecate.** The consolidator's per-weekday rolling baselines (with anomaly-contamination filtering and sample-size guardrails) replace what `forecast_calibration.dow_factors` was attempting. The buggy cron at `/api/cron/forecast-calibration` is turned off in Piece 0. The `forecast_calibration` table can stay (for `accuracy_pct` and `bias_factor` which are written by the M020 reconciler) but `dow_factors` becomes a dead column. This avoids the Vero `Sun = 0.009` foot-gun without requiring the consolidator to "incorporate" buggy data.


---

## Section 4 — Signals: what's used today, what we're adding

### Already used in legacy forecasters

- Per-business per-weekday recency-weighted baselines (recency.ts: 28-day cutoff, 2.0 multiplier on recent vs older)
- Weather bucket multipliers (when `weather_daily` exists; **broken in prod until Piece 0**)
- Swedish public holidays (binary flag, type-aware lift via `lib/holidays/sweden.ts`)
- This-week scaler clamp (floor 0.75, ceil 1.25)

### New signals we're adding

For each: derivation, dependencies, expected impact, **explicit Vero data status**.

#### 1. Year-over-year same-month (interim) and same-weekday (long-term)

**Same-month logic:** For target date's month, look up `monthly_metrics.revenue` for the same month one year prior. Apply trailing-12-month revenue growth multiplier as a trend anchor.

**Same-weekday logic:** For target date, find the same weekday closest to one year prior in `daily_metrics`. Apply trailing-12-month growth multiplier.

**Dependencies:**
- Same-month: `monthly_metrics` with 12+ months of history. **Vero has 16 months.** Available immediately.
- Same-weekday: `daily_metrics` with 12+ months of history. **Vero's first positive-revenue day is 2025-11-24.** Available 2026-11-24 onwards.

**Sequencing:**
- Week 8: implement YoY same-month from `monthly_metrics` as trend anchor. Active for Vero.
- Week 8 also: implement YoY same-weekday code path. Logs `yoy_same_weekday.available: false` for Vero. Activates automatically when 2026-11-24 passes.

**Why it matters:** Same-month gives us trend signal immediately. Same-weekday gives us weekday-specific signal once the data accumulates. Both compose.

#### 2. Klämdag detection

**Logic:** A weekday between a holiday and a weekend forms a 3-day weekday gap that becomes a 4-day off stretch.

```python
def is_klamdag(date, holidays):
    if is_weekend(date) or is_holiday(date):
        return False
    if is_holiday(date - 1d) and is_weekend(date + 1d):
        return True   # Friday after Thursday holiday
    if is_holiday(date + 1d) and is_weekend(date - 1d):
        return True   # Monday before Tuesday holiday
    return False
```

**Dependencies:** `lib/holidays/sweden.ts`, no new data.

**Min samples:** 2 prior klämdag observations for this business. **Vero has crossed maybe 1-2 since 2025-11-24.** Threshold likely not met until 2027.

**Fallback:** national default factor of 0.90 for non-tourist restaurants (cluster-derived later). Active immediately, replaced with per-business factor when sample size accumulates.

**Why it matters:** Restaurants in business districts vs tourist areas have opposite klämdag effects. Currently neither is captured in the baseline.

#### 3. School holidays

**Reality of Swedish school calendars:** Sportlov is per-kommun (municipality), not per-län. Sweden has 290 kommuner. Most Stockholms län kommuner take vecka 9, but Salem, Nykvarn and a few others differ. Höstlov is nearly uniform vecka 44. Påsklov, sommarlov, jullov are 99% national.

**Schema:**

```sql
CREATE TABLE school_holidays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kommun TEXT NOT NULL,         -- '0180' (Stockholm), '0136' (Haninge), etc. SCB kommun code
  lan TEXT NOT NULL,            -- 'STHM', 'GBG', 'MMX' for cross-cluster grouping
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  name TEXT NOT NULL,           -- 'sportlov', 'paasklov', 'sommarlov', 'hostlov', 'jullov'
  source TEXT NOT NULL,         -- 'skolverket'
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (kommun, start_date, name)
);
```

`businesses.city` is currently free-text. Implementation needs `business → city → kommun` resolution. Either:
- Add a `kommun` column to `businesses` and backfill from `city` + manual review
- Build a city → kommun lookup table and resolve at query time

Resolution effort: ~3-4 days for proper kommun mapping. Shortcuts (assume vecka 9 sportlov, vecka 44 höstlov) get 80-85% accuracy in 1 day. **Decision: implement properly. The "build it right" call from Decision 1 applies here too.**

**Min samples:** 1 prior occurrence of the same school_holiday.name for this business. **Vero crossed sportlov 2026 (vecka 9, Feb 23 – Mar 1)** — that's the first sportlov with positive-revenue data. Sportlov 2027 is the second observation.

**Sequencing:** Week 12. Real effort.

#### 4. Salary cycle (Swedish payday is the 25th)

**Logic:** Day-of-month features:
- `days_since_last_25th` (0-30)
- `days_until_next_25th` (0-30)
- `phase`: 'post_payday' (0-6), 'mid_month' (7-21), 'pre_payday' (22-30)

**Per-business factor learner:** **Decision needed (Section 10 open question).** Two options:
- **(a)** Per-phase median ratio of revenue / weekday-baseline, computed monthly from audit data
- **(b)** Continuous regression on `days_since_25th` as a feature

Recommendation: **(a)** for v1. Simpler, more interpretable, robust to outliers. Upgrade to (b) once we have multi-customer data.

**Dependencies:** Just the date.
**Min samples:** 30 days of business history.

**Date convention warning:** `lib/forecast/recency.ts` uses ISO `'T12:00:00Z'` (mid-day UTC). `lib/weather/demand.ts:424-437` uses `setHours(0,0,0,0)` (local). The consolidated forecaster picks **ISO mid-day UTC** as the convention. All signal modules must follow it.

#### 5. Weather change relative to seasonal norm

**Logic:** Today's weather forecast minus the multi-year average for this calendar date.

**Dependencies:** `weather_daily` with at least 1 prior year. **Currently missing in prod (M015 not applied).** Piece 0 fix:
- Apply M015 (5-minute task)
- Backfill 2-3 years of historical weather via Open-Meteo `archive-api` for every business's city
- Open-Meteo serves historical data going back decades; backfill is bandwidth-bound, not time-bound

**Sequencing:** Once M015 + backfill complete in Piece 0, this signal is live. Doesn't wait years.

**Min samples:** 1 prior year of observations. Met immediately after Piece 0 backfill.

#### 6. Day-of-month patterns

**Logic:** Captures month-start spikes (corporate accounts, payday lunch crowds) beyond just the salary cycle. Per-business factor for each day-of-month bucket: 1-7, 8-14, 15-21, 22-31.

**Per-business factor learner:** Same as salary cycle: per-bucket median ratio of revenue / weekday-baseline.

**Dependencies:** Just the date.
**Min samples:** 60 days of business history.
**Vero status:** 145 days available — meets the threshold immediately.

### Cross-cutting: every multiplier carries `samples_used`

The `inputs_snapshot` records `samples_used` for each multiplier so error attribution can distinguish:
- "Signal contributed nothing because data was insufficient (factor = 1.0, samples_used = 0)"
- "Signal contributed 1.0× as the model's best low-confidence guess (factor = 1.0, samples_used = 3, min_samples = 10)"
- "Signal contributed with high confidence (factor = 1.08, samples_used = 24, min_samples = 10)"

This is what makes the audit log learnable — and what gives the LLM adjustment layer (Section 6) the context to reason about which signals are reliable for this business right now.

### Signal addition strategy

One at a time. Each addition is followed by 5-7 days of audit accumulation, then check the log: did MAPE improve? If a signal didn't help, **cut it**.

Order (revised from v1 to reflect Vero data reality):

1. Week 8: YoY same-month (immediate value for Vero) + YoY same-weekday code path (dormant for Vero)
2. Week 8: klämdag detection with national default fallback
3. Week 9: salary cycle (per-phase median learner)
4. Week 9: model_version bump, kick off Phase B switchover if MAPE supports it
5. Week 12: school holidays (proper kommun-level)
6. Week 13: weather_change_vs_seasonal (uses backfilled weather_daily history from Piece 0)
7. Week 13: day_of_month patterns (orthogonal to salary cycle)

---

## Section 5 — Capture and reconciliation

### Capture sites and once-per-day truncation

Three paths produce predictions:

1. `/api/forecast/daily` — new canonical endpoint
2. `/api/scheduling/ai-suggestion` — phase A logs in addition to existing logic; Phase B routes through `dailyForecast()`
3. `/api/weather/demand-forecast` — same pattern

**Decision 2 from earlier review: truncate to once per (business, forecast_date, surface) per day.** The `ON CONFLICT (business_id, forecast_date, surface) DO UPDATE` semantics handle this. Multiple dashboard refreshes in a day produce one audit row that gets `predicted_at` updated to the latest call. `first_predicted_at` and `prediction_horizon_days` are preserved from the first call.

This keeps audit volume sane and prevents "the operator refreshed 20×" from polluting MAPE measurements with effectively-duplicate rows.

**Trade-off accepted:** we lose the ability to measure intra-day prediction drift. For v1 this is fine — predictions don't meaningfully change within a day for the same forecast_date. If we later want intra-day visibility, add a separate `daily_forecast_calls` log without the unique constraint.

### Backfill on Vero

**Per the review's recommendation:** walk Vero's 145 days of positive-revenue history through `dailyForecast({ skipLogging: true })` followed by an inline audit insert. This produces 90+ days of audit data instantly instead of waiting 14 days for shadow mode to accumulate.

```typescript
// One-time backfill script, run after Piece 0 + Piece 1 ship
async function backfillVeroAuditLedger() {
  const veroBusinessId = '...';
  const startDate = new Date('2025-11-24');
  const endDate = new Date(); // today
  const dates = enumerateDates(startDate, endDate);

  for (const date of dates) {
    // Only backfill days where actual is known
    const actual = await getActual(veroBusinessId, date);
    if (!actual) continue;

    // Compute what dailyForecast would have predicted as of date - 1
    // (i.e. with only data available at that time)
    const forecast = await dailyForecast(veroBusinessId, date, {
      skipLogging: true,
      asOfDate: subDays(date, 1)  // requires asOfDate option for backfill
    });

    await db.query(`
      INSERT INTO daily_forecast_outcomes (
        org_id, business_id, forecast_date, surface,
        predicted_revenue, baseline_revenue,
        first_predicted_at, predicted_at,
        model_version, snapshot_version, inputs_snapshot,
        actual_revenue, error_pct, resolution_status, resolved_at
      ) VALUES (
        $1, $2, $3, 'consolidated_daily',
        $4, $5,
        $6, $6,                       -- backfill timestamps to historical date
        $7, 'consolidated_v1', $8,
        $9, $10, 'resolved', NOW()
      )
      ON CONFLICT (business_id, forecast_date, surface) DO NOTHING
    `, [...]);
  }
}
```

**`dailyForecast()` needs an `asOfDate` option** for backfill — it must compute predictions using only the data that was available at that point in time. This is essential for honest backfill. Without it, we're reporting "what would we have predicted if we'd had today's data on April 1" — which is data leakage.

### Reconciler cron

Schedule: **07:30 UTC daily**. Runs after master-sync (05:00) and ai-accuracy-reconciler (07:00). Verified slot — no conflict per `vercel.json`.

```typescript
// app/api/cron/daily-forecast-reconciler/route.ts

export async function GET() {
  const pending = await db.query(`
    SELECT id, business_id, org_id, forecast_date, surface,
           predicted_revenue, baseline_revenue, inputs_snapshot
    FROM daily_forecast_outcomes
    WHERE resolution_status = 'pending'
      AND forecast_date < CURRENT_DATE
  `);

  let resolved = 0, deferred = 0, marked_unresolvable = 0;

  for (const row of pending) {
    try {
      const actual = await db.query(`
        SELECT revenue
        FROM daily_metrics
        WHERE business_id = $1 AND date = $2
      `, [row.business_id, row.forecast_date]);

      // Late-arriving data: try again tomorrow
      if (!actual && daysSince(row.forecast_date) <= 7) {
        deferred++;
        continue;
      }

      // Past 7 days with no actual: give up
      if (!actual) {
        await markUnresolvableNoActual(row.id);
        marked_unresolvable++;
        continue;
      }

      // Anomaly contamination: mark unresolvable
      // Uses the new confirmation_status workflow built in Piece 0
      const isContaminated = await db.query(`
        SELECT 1 FROM anomaly_alerts
        WHERE business_id = $1
          AND period_date = $2
          AND metric = 'revenue'
          AND confirmation_status = 'confirmed'
      `, [row.business_id, row.forecast_date]);

      if (isContaminated) {
        await markUnresolvableDataQuality(row.id);
        marked_unresolvable++;
        continue;
      }

      // Zero-revenue day (closed): record but no MAPE
      if (actual.revenue === 0) {
        await db.query(`
          UPDATE daily_forecast_outcomes
          SET actual_revenue = 0,
              error_pct = NULL,
              resolved_at = NOW(),
              resolution_status = 'unresolvable_zero_actual'
          WHERE id = $1
        `, [row.id]);
        marked_unresolvable++;
        continue;
      }

      // Normal resolution
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

      resolved++;
    } catch (err) {
      // Per-row catch: don't crash the whole reconciler
      log.error('reconciler.row_failed', { id: row.id, error: err });
    }
  }

  // Alert if too many rows are deferred for >3 days
  await alertOnStalePending();

  return { resolved, deferred, marked_unresolvable };
}
```

Idempotent re-run: WHERE clause filters by `pending`, so resolved rows are not touched. If the cron crashes mid-run, the next run picks up where it left off.

### Anomaly contamination workflow (built in Piece 0 — Decision 1: build it right)

The current `anomaly_alerts` table has `is_dismissed`, `is_read`, `severity`, but no concept of "owner confirmed this was a real one-time event."

**Migration M0XX adds:**

```sql
ALTER TABLE anomaly_alerts
  ADD COLUMN confirmation_status TEXT
    CHECK (confirmation_status IN ('pending', 'confirmed', 'rejected', 'auto_resolved'))
    DEFAULT 'pending',
  ADD COLUMN confirmed_at TIMESTAMPTZ,
  ADD COLUMN confirmed_by UUID REFERENCES auth.users(id),
  ADD COLUMN confirmation_notes TEXT;

CREATE INDEX idx_anomaly_alerts_confirmation
  ON anomaly_alerts (business_id, period_date, confirmation_status)
  WHERE confirmation_status = 'confirmed';
```

**API endpoints:**
- `POST /api/anomalies/:id/confirm` — body `{ notes?: string }` — sets confirmation_status='confirmed', records actor and timestamp
- `POST /api/anomalies/:id/reject` — sets confirmation_status='rejected'
- Existing `POST /api/anomalies/:id/dismiss` (or whatever it's called) is unchanged; dismissal is separate from confirmation

**UI changes:**
- Dashboard alert pill: when expanded, shows two buttons in addition to dismiss — "Yes, this was real (don't use for predictions)" and "No, the prediction was wrong"
- Confirmed anomalies show with a 'confirmed' badge in the alerts list
- Alerts are filtered by status throughout the existing alerts UI

**Why "build it right":** the alternative (using `severity IN (...) AND is_dismissed = false`) treats every undismissed high-severity alert as contamination. That's lossy — operators don't always dismiss false alerts promptly, and dismissal is "I read this," not "I confirm it was a real one-time event." The proper workflow gives us a clean signal. It's ~2-3 days of work in Piece 0, worth it.

### Error attribution

Same logic as v1: subtract each multiplier's contribution to compute its share of the error. Now uses the actual signal structure:

```typescript
async function computeErrorAttribution(forecast, actual) {
  const snapshot = forecast.inputs_snapshot;
  const totalErrorPct = (forecast.predicted_revenue - actual) / actual;

  const baselineOnly = snapshot.weekday_baseline.recency_weighted_avg;
  const baselineErrorPct = (baselineOnly - actual) / actual;

  // For each multiplier: what would the prediction have been if it were 1.0?
  const factors = computeFactorContributions(snapshot, forecast.predicted_revenue, actual);

  const primaryFactor = factors.reduce((max, f) =>
    Math.abs(f.contribution) > Math.abs(max.contribution) ? f : max
  );

  return {
    primary_factor: primaryFactor.name,
    factor_breakdown: Object.fromEntries(factors.map(f => [f.name, f.contribution])),
    weather_forecast_actual_delta: await maybeWeatherActuals(forecast),  // null if weather_daily empty
    notes: generateAttributionNote(primaryFactor, snapshot)
  };
}
```

### Stale-pending alerting

Existing pattern: `data-source-disagreements-alert` cron sends a daily ops email when something is wrong. The reconciler pipes into the same channel:

```typescript
async function alertOnStalePending() {
  const stale = await db.query(`
    SELECT business_id, COUNT(*) as count
    FROM daily_forecast_outcomes
    WHERE resolution_status = 'pending'
      AND forecast_date < CURRENT_DATE - INTERVAL '3 days'
    GROUP BY business_id
    HAVING COUNT(*) > 3
  `);

  if (stale.length > 0) {
    await sendOpsAlert('forecast_reconciler.stale_pending', { stale });
  }
}
```

### Admin accuracy view

Route at `/admin/predictions/accuracy`:
- Rolling 7/30/90-day MAPE per business per surface (excluding zero-actual rows)
- MAPE-by-horizon chart using `prediction_horizon_days`
- MAPE trend sparkline
- Distribution of `error_attribution.primary_factor`
- List of recent `pending` rows past 3 days
- Per-signal contribution to error reduction
- LLM-adjusted vs baseline-only MAPE comparison

Admin-only initially. When N≥3 customers and MAPE trends are stable, becomes per-business operator view.


---

## Section 6 — LLM adjustment layer

### Purpose (unchanged from v1)

The LLM does not predict revenue from scratch. It adjusts a math baseline based on context the math doesn't see, and produces an operator-facing explanation. Math produces the number, LLM adjusts and explains.

### Activation criteria

LLM layer activates per-business when **all** of:

1. At least 30 days of resolved audit data in `daily_forecast_outcomes` for this business
2. Consolidated_daily MAPE is being computed reliably
3. Per-business kill switch flag is unset (admin override)
4. Cost cap not exceeded
5. **Anthropic API health check passes** — if Anthropic is unreachable, fall back to consolidated_daily prediction with no `llm_adjusted` row written. Reconciler treats absence as "baseline-only used"

### When the layer runs

**Decision: re-adjust on context change, not on every refresh.** The LLM call is triggered only when:
- A new consolidated_daily prediction has been computed AND
- One of these is true:
  - The previous llm_adjusted row for this (business, forecast_date) is more than 24h old
  - The weather forecast for forecast_date has changed materially (>2°C or precipitation flip)
  - A new owner-flagged event has been added/removed for forecast_date
  - A new active pattern has been promoted for this business
  - A new anomaly has been confirmed in the last 7 days

Otherwise: the existing llm_adjusted row stands.

This caps real-world LLM cost at 1-2 calls per business per (business, forecast_date) per day, not 14. With 14-day horizon, that's ~14 calls/business/day in steady state — same as v1's estimate, but now with a defensible cap rather than a wishful one.

### Prompt structure

```typescript
async function generateAdjustment(
  forecast: DailyForecast,
  context: AdjustmentContext
): Promise<LLMAdjustment> {

  const recentReconciliation = await fetchRecentReconciliation(
    forecast.business_id,
    { days: 90, summarized: true }  // summarized to control token count
  );

  const upcomingContext = {
    holidays_next_14d: await fetchUpcomingHolidays(14),
    school_holidays_active: await fetchActiveSchoolHolidays(forecast.business_id),
    weather_forecast: forecast.inputs_snapshot.weather_forecast,
    recent_anomalies: await fetchRecentConfirmedAnomalies(forecast.business_id, { days: 14 }),
    owner_flagged_events: await fetchOwnerFlaggedEvents(forecast.business_id, forecast.date),  // Piece 4.5
    learned_patterns: await fetchActivePatterns(forecast.business_id)
  };

  const systemPrompt = `You are a forecast adjustment system for a Swedish restaurant.

Your job: take a math-based revenue prediction and adjust it ONLY when there is concrete reason to believe the math missed something. Default to no adjustment.

You receive:
- The baseline math prediction with components and inputs_snapshot
- The recent reconciliation history (how accurate predictions have been)
- The upcoming context (holidays, weather, anomalies, owner-flagged events, learned patterns)

Output ONLY valid JSON matching this schema:
{
  "baseline_prediction": <number, copy from input>,
  "adjusted_prediction": <number, integer>,
  "adjustment_pct": <number, signed, e.g. 0.078 for +7.8%>,
  "adjustment_reasoning": <string, 1-3 sentences>,
  "confidence": "high" | "medium" | "low",
  "override_applied": <boolean>
}

Rules:
- If you don't have a concrete reason to adjust, set adjusted = baseline and override_applied = false.
- Adjustments larger than ±15% require explicit reason. Cap at ±25%.
- Never invent context. Only use the data provided.
- Confidence reflects how certain you are about direction, not magnitude.`;

  const userPrompt = JSON.stringify({
    forecast_date: forecast.date,
    baseline_prediction: forecast.predicted_revenue,
    components: forecast.components,
    inputs_snapshot: forecast.inputs_snapshot,
    recent_reconciliation_summary: recentReconciliation,
    upcoming_context: upcomingContext
  }, null, 2);

  const startTime = Date.now();

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  // Log to existing ai_request_log via lib/ai/usage.ts
  await logAiRequest(db, {
    request_type: 'forecast_adjustment',
    model: 'claude-haiku-4-5-20251001',
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    duration_ms: Date.now() - startTime,
    business_id: forecast.business_id,
    org_id: forecast.org_id
  });

  return parseAndValidate(response);
}
```

### Cost projection (rebuilt at realistic input size)

The review correctly flagged that v1's 3,000-token estimate is low once recent_reconciliation is included.

**Realistic per-call:**
- System prompt: ~500 tokens (cacheable across calls)
- inputs_snapshot: ~600 tokens
- recent_reconciliation_summary (90 rows summarized to top patterns + headline stats): ~3,000 tokens
- upcoming_context: ~1,500 tokens
- learned_patterns: 0 tokens initially, up to ~1,000 after 6 months
- **Total input: ~5,500-6,500 tokens** (down from review's 8-12k worst case via summarization)
- **Output: ~400 tokens**

**Per-call cost (Haiku 4.5):**
- Input: 6,000 × $1/MTok = $0.006
- Output: 400 × $5/MTok = $0.002
- **Per-call: ~$0.008** (50% higher than v1's $0.005)

**Per-business-per-day:** with the change-driven activation, average ~10 calls/business/day (some days nothing changes; some days weather updates twice).

- Per business/day: ~$0.08
- Per business/month: **~$2.40**

**At scale:**
- 10 customers: ~$24/month
- 50 customers: ~$120/month
- 500 customers: ~$1,200/month

Higher than v1 but still tractable. Worth budgeting and tracking via `ai_request_log` (which already exists) and the existing `ai-daily-report` cron (which already aggregates).

### Rate limits at concurrent fire

Anthropic Tier 2 (~$1k/month spend) gives 1000 RPM and ~80k input tokens/min for Haiku 4.5. Concern: if we activate at 07:30 UTC for all customers simultaneously after the reconciler runs, 50 customers × 14 horizons = 700 calls in a burst. RPM is fine (700 < 1000), but 700 × 6,000 input tokens = 4.2M tokens in one minute — over the per-minute cap.

**Mitigation:**
- Stagger activation: spread the 14-day horizon refresh across an hour. 50 customers × 14 calls / 60 min = ~12 calls/min. Well within limits.
- Use Anthropic's Message Batches API for non-urgent re-adjustments (e.g. 14-day horizon refresh can be batched; same-day re-adjustments stay sync).
- Implement when N ≥ 20 customers. At N=1, irrelevant.

### Output schema (strict)

```typescript
type LLMAdjustment = {
  baseline_prediction: number   // integer
  adjusted_prediction: number   // integer
  adjustment_pct: number        // signed
  adjustment_reasoning: string
  confidence: 'high' | 'medium' | 'low'
  override_applied: boolean
}
```

The adjusted prediction is logged to `daily_forecast_outcomes` with `surface = 'llm_adjusted'`. Both baseline and adjusted get reconciled. After 90 days of data we directly compare which surface has lower MAPE per business.

### Kill switch criteria

Per-business automatic:

```
After 90 days of LLM-adjusted predictions:
  baseline_mape   = avg MAPE of consolidated_daily predictions
  adjusted_mape   = avg MAPE of llm_adjusted predictions (excluding zero-actual)

  If adjusted_mape >= baseline_mape:
    auto-disable LLM adjustment for this business
    log decision with rationale to ops alert channel
    notify admin

  If adjusted_mape < baseline_mape - 0.02:
    confirm LLM is adding value (>2pp improvement)

  Between: keep enabled, monitor
```

Manual kill switch: admin route `/admin/predictions/llm/disable?business_id=X` sets a flag in business config. Same pattern as the existing `is-agent-enabled.ts`.

Globally killable: feature flag `LLM_ADJUSTMENT_ENABLED` at the env level.

### Graceful degradation

When the LLM call fails (Anthropic down, timeout, parse error):
- No `llm_adjusted` row is written
- Caller falls back to the `consolidated_daily` row
- Operator sees the baseline prediction with no LLM reasoning
- Failure is logged via existing `ai_request_log` with status='error'
- Alert fires if failure rate exceeds 10% in any 1-hour window

This preserves the operator experience even when LLM infra has issues.

---

## Section 7 — Pattern extraction and feedback

### The weekly job

Schedule: **Sunday 01:30 UTC**. (v1's 02:00 UTC slot conflicts with `api-discovery`. Verified open at 01:30.)

```typescript
async function extractPatterns(businessId: string, orgId: string) {
  const recent = await fetchResolvedForecasts(businessId, { days: 60 });

  if (recent.length < 30) {
    return; // not enough data
  }

  const systemPrompt = `You are a pattern extraction system. Given 60 days of revenue prediction outcomes for a Swedish restaurant, identify systematic patterns in the prediction errors.

A "pattern" is a consistent, evidence-backed observation that suggests the math model could be improved.

You receive an array of resolved predictions, each with:
- forecast_date, day_of_week, predicted_revenue, actual_revenue, error_pct
- inputs_snapshot (all signals at prediction time)
- error_attribution (which signal contributed most)

Output ONLY valid JSON:
{
  "patterns_found": [
    {
      "description": <plain language>,
      "condition": <formal e.g. "weekday=Saturday AND month IN (6,7,8)">,
      "evidence_count": <integer>,
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
      "previous_pattern_id": <uuid>,
      "reason": <string>
    }
  ]
}

Rules:
- A pattern requires at least 5 matching observations.
- "Confidence: high" requires at least 10 observations and consistent direction.
- Don't speculate beyond the data.`;

  const startTime = Date.now();
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: JSON.stringify({ recent_resolutions: recent }) }]
  });

  await logAiRequest(db, {
    request_type: 'pattern_extraction',
    model: 'claude-haiku-4-5-20251001',
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    duration_ms: Date.now() - startTime,
    business_id: businessId,
    org_id: orgId
  });

  const result = parseAndValidate(response);
  await storePatterns(businessId, orgId, result);
}
```

### Storage schema

```sql
CREATE TABLE forecast_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  cluster_id TEXT,                 -- null for per-business; populated for cross-customer
  description TEXT NOT NULL,
  condition_formal TEXT NOT NULL,
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

ALTER TABLE forecast_patterns ENABLE ROW LEVEL SECURITY;

CREATE POLICY forecast_patterns_read ON forecast_patterns
  FOR SELECT USING (
    org_id IN (SELECT org_id FROM organisation_members WHERE user_id = auth.uid())
  );
```

### Pattern lifecycle

1. **proposed** — LLM job identified. Logged but not yet acting on the model.
2. **active** — Reviewed (manually for v1; auto-promote with evidence_count ≥ 10 in v2) and now read by LLM adjustment layer as additional context.
3. **invalidated** — A subsequent extraction run found the pattern no longer holds.
4. **rejected** — Admin manually marked as not useful. Won't be re-proposed for 90 days.

### What the operator sees

Small "What we've learned" panel in admin/insights area. Eventually operator-facing when the team is comfortable with the quality of patterns being surfaced.

---

## Section 8 — Cross-customer extension

### What activates when N≥5

Identical to v1's intent:
- Cluster-level baselines for cold-start
- Cluster-level patterns
- Cross-validation of per-business patterns

### Cluster definition

A cluster is `(cuisine, location_segment, size_segment)`. **Reality check from review:** `businesses` table does not currently have these columns. Adding them requires:

```sql
ALTER TABLE businesses
  ADD COLUMN cuisine TEXT,            -- 'italian', 'asian', 'nordic', 'casual', etc.
  ADD COLUMN location_segment TEXT,    -- 'city_center', 'residential', etc.
  ADD COLUMN size_segment TEXT;        -- 'small', 'medium', 'large' (auto-derived from avg revenue)
```

Plus the `business_cluster_membership` table from v1.

**Note:** these columns can stay null for v1 — Vero gets pre-populated as `('italian', 'city_center', 'medium')` manually. The full cluster machinery activates at N≥5.

### Schema decisions made now (locked in)

- Every prediction tagged by `business_id` and `org_id`
- Every signal in `inputs_snapshot` tagged by scope (`universal`, `locale_se`, `integration`)
- `forecast_patterns.cluster_id` exists from day 1 (null until activated)
- `business_cluster_membership` schema defined and ready

### What's deferred until N≥5

- Cross-customer pattern extraction job
- Operator-facing "businesses like yours" insights (also pending privacy review)
- Cold-start using cluster baselines


---

## Section 9 — Sequencing and milestones

### The revised plan (~18-19 weeks)

Slightly longer than v1 to accommodate the proper anomaly-confirm workflow (Decision 1) and Piece 4.5 (owner-flagged events).

#### Weeks 1-3: Piece 0 — Foundation fixes

**Expanded from v1 to include the proper anomaly-confirm workflow.**

- **Week 1:**
  - Apply M015 (`weather_daily` table) — 5-minute task
  - Backfill 2-3 years of historical Open-Meteo data for Vero's location — bandwidth-bound, runs in parallel
  - Add minimum-sample guardrail to `forecast_calibration` cron, then **disable the cron entirely** (the consolidator replaces `dow_factors`)
  - Backfill `created_via` on the 21 pre-M047 `tracker_data` rows
- **Weeks 2-3 (parallel tracks):**
  - **Anomaly-confirm workflow:**
    - Migration: `confirmation_status`, `confirmed_at`, `confirmed_by`, `confirmation_notes` on `anomaly_alerts`
    - API: `POST /api/anomalies/:id/confirm`, `POST /api/anomalies/:id/reject`
    - UI: dashboard alert pill expansion with confirm/reject buttons
    - Existing alerts list: confirmed badge, status filter
    - Documentation update for operators
  - **OB-supplement detector tuning** — adapt baseline window to handle step-changes
  - **Phase A pre-instrumentation:** decide table location for `school_holidays` and `business_cluster_membership` schemas (DDL-only, no data yet)

**Ships:** clean data foundation, end of daily false-alarm OB pill noise, real anomaly-confirm workflow operators can use, weather lift logic actually working again.

**Milestone:** dashboard alert pill no longer fires the same OB message daily; operators have a way to mark anomalies as confirmed.

#### Week 4: Piece 1 — Daily forecast audit ledger

- Migration: `daily_forecast_outcomes` with full schema from Section 2 (incl. `org_id`, RLS, retention RPC, generated `prediction_horizon_days`)
- Capture instrumentation in `/api/scheduling/ai-suggestion` and `/api/weather/demand-forecast` writing to legacy surfaces with `snapshot_version='legacy_v1'`
- Reconciler cron at `/api/cron/daily-forecast-reconciler/route.ts`, scheduled `30 7 * * *`
- Admin view: `/admin/predictions/accuracy`
- Stale-pending alerter wired to existing ops alert channel

**Ships:** every daily prediction is logged with full provenance. Reconciler runs nightly. Comparison data for two legacy surfaces accumulating.

**Milestone:** 14 days of audit data accumulated by end of Week 6.

#### Weeks 5-6: Customer-facing sprint #1

Whatever's most pressing for AB/Stripe completion or the next customer close. Audit data accumulates in the background.

#### Weeks 7-8: Piece 2 — Consolidated forecaster

- Implement `lib/forecast/daily.ts` with the API from Section 3
- Implement `dailyForecast({ asOfDate })` for honest backfill
- Phase A (shadow mode): runs alongside legacy, logs as `consolidated_daily`
- One-time backfill of Vero's 145 days as resolved audit rows (per Section 5 backfill code)
- After 1 week of shadow data + backfill: compare MAPE across surfaces

**Ships:** 90+ days of consolidated_daily MAPE data via backfill. Comparison vs legacy.

**Milestone:** `consolidated_daily` MAPE measurable against `scheduling_ai_revenue` and `weather_demand` MAPEs.

#### Weeks 9-10: Piece 3 — New signals, batch 1

- Week 9: YoY same-month + YoY same-weekday code paths
- Week 9: klämdag detection
- Week 10: salary cycle (per-phase median learner)
- Week 10 end: model_version bump; if MAPE supports it, kick off Phase B switchover (dashboard first, scheduling page next, Monday Memo last, separate PRs)

**Ships:** consolidated_daily integrates same-month YoY, klämdag, and salary cycle. Phase B switchover begins.

#### Weeks 11-12: Customer-facing sprint #2

Continued breathing room. Phase B Monday Memo switchover lands here if not done in Week 10.

#### Weeks 13-14: Piece 3 — New signals, batch 2

- Week 13: school holidays (proper kommun mapping, Skolverket scraper, schema migration)
- Week 14: weather_change_vs_seasonal (uses backfilled weather_daily)
- Week 14: day_of_month patterns

**Ships:** all six new signals integrated. Audit log shows per-signal contribution to MAPE reduction.

#### Week 15: Piece 4.5 — Owner-flagged events

- Migration: `owner_flagged_events` table (business_id, event_date, event_type, description, expected_impact_direction, expected_impact_magnitude, created_at, created_by)
- API: CRUD endpoints for flagging
- UI: dashboard event flag widget — operator clicks a date, fills "private event Saturday, expect quiet lunch"
- Integration with `dailyForecast()` — events surface in `inputs_snapshot.owner_flagged_events`
- Integration with LLM adjustment prompt context

**Ships:** operators can tell the system about events the math can't see.

#### Weeks 16-17: Piece 4 — LLM adjustment layer

- Week 16: prompt engineering, output schema validation, kill switch infrastructure, change-driven activation logic
- Week 17: integration with `dailyForecast()`, both predictions logged side-by-side, ai_request_log integration

**Ships:** LLM adjustment running for Vero. Both surfaces logged for comparison.

**Milestone:** kill-switch criteria instrumented. We can prove (or disprove) that the LLM is adding value.

#### Week 18: Piece 5 — Pattern extraction (v1)

- Implement `extractPatterns()`
- `forecast_patterns` table
- Sunday 01:30 UTC cron
- Admin view of proposed patterns
- Manual promotion (auto-promotion deferred to v2)

**Ships:** the system is now learning from itself. Visibly. With receipts.

### Beyond Week 18

- Path B pattern → math weight changes
- Customer-facing accuracy view (when N≥3)
- Cross-customer activation (when N≥5)
- The marketing claim, defended with data

### What absolutely cannot be reordered

- Piece 0 must come first. Specifically, the anomaly-confirm workflow must exist before the consolidator's contamination filter has anything to filter on.
- Piece 1 must come before Piece 2-5.
- Piece 4 (LLM adjustment) must come after Piece 4.5 (owner-flagged events) AND after at least 30 days of audit data.

### Total calendar time

~18-19 weeks. ~3 weeks longer than v1 to accommodate proper anomaly-confirm workflow and owner-flagged events. The "build it right" decision pays calendar cost.

---

## Section 10 — Decisions still open

### Decided in this revision

1. ~~Schema: parallel vs extend M020~~ — **parallel**
2. ~~UI loudness on prediction accuracy~~ — **quiet first, loud after testing on a few customers**
3. ~~Customer-facing accuracy claim~~ — **conservative version** ("predictions get more accurate; helps you staff smarter")
4. ~~Sequencing — interleave or heads-down~~ — **interleave with two customer-facing sprints**
5. ~~Anomaly contamination predicate~~ — **build the proper owner-confirm workflow in Piece 0**
6. ~~Logging frequency~~ — **truncate to once per (business, date, surface) per day**
7. ~~Owner-flagged events~~ — **Piece 4.5, full table + API + UI**

### Still open (need explicit calls before implementation)

#### A. Specific MAPE target for the public claim

Realistic bands for daily restaurant revenue:
- <5%: unrealistic
- 5-10%: achievable with good data + 6+ months history
- 10-15%: realistic 90-day target
- >15%: indicates problems

**Recommendation:** commit publicly to "within 12% on average" at 90-day mark; aim internally for <10%.

#### B. Salary cycle learner type

Per-phase median (interpretable) vs continuous regression (more accurate, less interpretable).

**Recommendation:** per-phase median for v1; revisit at N≥10 customers.

#### C. Day-of-month learner type

Same question as B. Same recommendation.

#### D. Operator visibility of LLM reasoning

Always visible / on-click only / threshold-gated.

**Recommendation:** always visible but de-emphasized (small italic line below the prediction).

#### E. Cold-start strategy

For new customers in the future:
- (a) Show no predictions for first 30 days
- (b) Cluster baselines (when N≥5) or industry defaults
- (c) Day-of-week + weather + holidays only, marked low confidence

**Recommendation:** (c) until clusters exist, then (b).

#### F. Privacy review for cross-customer learning

Cross-customer patterns use one customer's data to inform another's predictions. ToS / privacy policy review before activation.

**Action needed:** founder/legal review before Piece 6.

#### G. Weight tuning anchoring

The consolidator's recency-weighted baseline inherits from `recency.ts` (28-day window, 2.0× recency multiplier). When pattern extraction proposes weight changes, what's the floor?

**Recommendation:** patterns can propose weight changes within ±50% of current values. Bigger swings require admin review.

#### H. `model_version` per surface

Already addressed in Section 2 schema, but flagging: each surface (`scheduling_ai_revenue`, `weather_demand`, `consolidated_daily`, `llm_adjusted`) maintains its own version counter. MAPE comparisons are scoped within a model_version.

#### I. Pattern auto-promotion threshold

When (if ever) does a `proposed` pattern auto-promote to `active`? Manual review forever, or auto at evidence_count ≥ 10?

**Recommendation:** manual for first 6 months; revisit when we have data on pattern quality.

---

## Appendix A — Code paths (corrected)

### Existing files modified

- `app/api/scheduling/ai-suggestion/route.ts`
- `app/api/weather/demand-forecast/route.ts`
- `lib/forecast/recency.ts`
- `lib/weather/demand.ts`
- `lib/ai/weekly-manager.ts` (Monday Memo: switch from `computeDemandForecast` to `dailyForecast`)
- `components/dashboard/OverviewChart.tsx`
- `components/scheduling/computeWeekStats.ts`
- `app/scheduling/page.tsx`
- `app/api/alerts/route.ts` (add confirmation_status filtering)
- `lib/alerts/detector.ts` (handle new column)
- Existing dashboard alert pill component (add confirm/reject buttons)

### New files

- `migrations/MXXX_anomaly_confirmation_workflow.sql`
- `migrations/MXXX_daily_forecast_outcomes.sql`
- `migrations/MXXX_school_holidays.sql`
- `migrations/MXXX_forecast_patterns.sql`
- `migrations/MXXX_business_cluster_columns.sql`
- `migrations/MXXX_business_cluster_membership.sql`
- `migrations/MXXX_owner_flagged_events.sql`
- `lib/forecast/daily.ts` — consolidated forecaster
- `lib/forecast/signals/yoy-monthly.ts`
- `lib/forecast/signals/yoy-weekday.ts`
- `lib/forecast/signals/klamdag.ts`
- `lib/forecast/signals/salary-cycle.ts`
- `lib/forecast/signals/school-holidays.ts`
- `lib/forecast/signals/weather-change.ts`
- `lib/forecast/signals/day-of-month.ts`
- `lib/forecast/llm-adjustment.ts`
- `lib/forecast/pattern-extraction.ts`
- `lib/forecast/owner-events.ts` (Piece 4.5)
- `lib/anomalies/confirmation.ts`
- `lib/skolverket/scraper.ts` (school holidays)
- `app/api/forecast/daily/route.ts`
- `app/api/anomalies/[id]/confirm/route.ts`
- `app/api/anomalies/[id]/reject/route.ts`
- `app/api/owner-events/route.ts` (Piece 4.5)
- `app/api/owner-events/[id]/route.ts`
- `app/api/cron/daily-forecast-reconciler/route.ts`
- `app/api/cron/weekly-pattern-extraction/route.ts`
- `app/api/cron/skolverket-sync/route.ts`
- `app/admin/predictions/accuracy/page.tsx`
- `app/admin/predictions/patterns/page.tsx`
- `components/dashboard/AnomalyConfirmButtons.tsx`
- `components/dashboard/OwnerEventFlag.tsx` (Piece 4.5)

### vercel.json additions

```json
{
  "path": "/api/cron/daily-forecast-reconciler",
  "schedule": "30 7 * * *"
},
{
  "path": "/api/cron/weekly-pattern-extraction",
  "schedule": "30 1 * * 0"
},
{
  "path": "/api/cron/skolverket-sync",
  "schedule": "0 4 1 * *"
}
```

`forecast-calibration` cron entry is **removed** as part of Piece 0.

### Implementation prompts to write

In order:

1. **Prompt 1 — Piece 0:** All foundation fixes including the anomaly-confirm workflow. Largest of the implementation prompts.
2. **Prompt 2 — Piece 1:** Audit ledger (schema, capture, reconciler, admin view).
3. **Prompt 3 — Piece 2:** Consolidated forecaster + Vero backfill.
4. **Prompt 4 — Piece 3 batch 1:** YoY signals, klämdag, salary cycle, Phase B switchover.
5. **Prompt 5 — Piece 3 batch 2:** School holidays, weather change, day-of-month.
6. **Prompt 6 — Piece 4.5:** Owner-flagged events.
7. **Prompt 7 — Piece 4:** LLM adjustment layer.
8. **Prompt 8 — Piece 5:** Pattern extraction.

Each follows the same disciplined investigation-first pattern as scheduling/overheads/dashboard.

---

## Appendix B — What this architecture commits us to

(Same as v1, with one addition.)

1. Predictions are auditable.
2. The system has a track record.
3. LLM costs scale linearly with customer count (~$2.40/business/month at activation).
4. The audit log is a regulated artifact — privacy policy must reflect it.
5. Model changes are traceable.
6. The system is killable at every layer.
7. The moat takes time to manifest — proof is the chart of MAPE-over-time.
8. This investment crowds out other work (~18-19 weeks).
9. **(New) Operators have meaningful ways to teach the system.** The anomaly-confirm workflow and owner-flagged events together give operators concrete actions that improve their own predictions. This is part of the moat — competitors that just show predictions don't have this loop.

---

## Closing

v2 reflects the architecture review's findings. Specifically:

- Hard failures from v1 (anomaly_alerts.status, YoY same-weekday Vero claim, missing org_id/RLS) are corrected
- Idempotency is properly defined (ON CONFLICT DO UPDATE on `(business_id, forecast_date, surface)`)
- Schema reflects what's actually computable today (snapshot_version, integer revenues, samples_used per multiplier)
- Phase B switchover acknowledges 4+ consumers, not 2
- Cost projection rebuilt at realistic input size
- Existing infrastructure honored (`logAiRequest`, `ai_request_log`, ops alert channel)
- Decision 1 ("build it right") expands Piece 0 to include proper anomaly-confirm workflow
- Decision 3 adds Piece 4.5 (owner-flagged events) before Piece 4

Open decisions in Section 10 narrowed from 10 to 9. Most remaining items are recommendations to confirm/counter rather than blocking calls.

The 18-19 week sequencing is realistic given the parallel AB/Stripe track and two customer-facing sprints. Don't compress it.

