# Prediction System Architecture — v3

> Drafted 2026-05-08. Final spec for the daily-grain forecasting and learning system.
> v3 incorporates all corrections from `ARCHITECTURE-REVIEW-V2-2026-05-08.md` plus the launch-strategy decision (build on the side, validate, controlled cutover).
> This is the foundation of CommandCenter's core differentiator.

---

## Changes from v2

This is v2 with 12 corrections plus a new launch strategy. The substantive changes:

1. **Reconciler column name fix.** v2 used `metric = 'revenue'` against a column that doesn't exist on `anomaly_alerts`. v3 uses `alert_type IN ('revenue_drop', 'revenue_spike')` matching `lib/alerts/detector.ts:303`.
2. **Retention RPC parity with M020.** v3 adopts `language sql + volatile security definer set search_path = public + grant execute on function ... to service_role` verbatim.
3. **Anomaly-confirm UI scope.** v2 said "expanded dashboard pill." v3 says: confirm/reject buttons land on `/alerts` page only, in the existing action-row pattern. Dashboard pill stays a one-line link. Cuts ~1.5 days from Piece 0.
4. **API namespace.** v2 invented `/api/anomalies/*`. v3 extends the existing `/api/alerts` PATCH with `confirm`/`reject` actions to keep one namespace.
5. **Owner-event re-adjustment trigger.** v3 commits to: sync POST returns 200 immediately, fires LLM call via `waitUntil` background task. No new infra.
6. **Backfill weather data leakage (new Decision J).** v3 commits to using observed weather as forecast in backfilled audit rows, with explicit `data_quality_flags: ['backfilled_observed_as_forecast']` in the snapshot. MAPE comparisons across backfilled vs live data carry the caveat.
7. **Phase B switchover gets its own window.** Split off into ~1.5-week dedicated window. Build phase grows from 18-19 to 19-20 weeks.
8. **Deterministic recent-reconciliation summary.** Replaces v2's hand-wavy "LLM-summarized." v3 commits to client-side TS computing weekly MAPE + MAPE-by-weekday + MAPE-by-horizon + 5-worst-days as structured JSON. Cost projection re-grounded.
9. **`fetchUpcomingHolidays` → `getUpcomingHolidays`.** Match the actual function name in `lib/holidays/index.ts`.
10. **Backtest write guard.** Added: `if forecast_date < CURRENT_DATE, skip the audit insert` to keep MAPE-by-horizon clean of negative values.
11. **`expected_impact_*` enum specified for owner_flagged_events.** `direction ∈ {up, down, neutral}`, `magnitude ∈ {small, medium, large}`.
12. **Migration ordering documented in Appendix A.**

**Plus the new launch strategy (Section 11):** build all infrastructure in prod from week 1, gate every customer-visible UI change behind per-business feature flags (default OFF), accumulate 30-60 days of shadow data after build complete, then cut over piece by piece with rollback ready. Total project ~23-24 weeks calendar time. Vero sees zero changes during the build.

The conservative marketing claim is unchanged:

> "Predictions about your business get measurably more accurate the longer you use CommandCenter. We show you the track record. Better forecasts help you make smarter staffing and purchasing decisions."

---

## Section 1 — The accuracy claim and what it requires

### What we commit to

Per-business, per-surface MAPE trends, visible in the product. Three commitments:

1. **Predictions are measurably more accurate after 90 days than after 30 days.** MAPE trend line for next-week daily revenue forecasts trends downward as customer tenure increases.
2. **The track record is visible.** Customers can see their own prediction history.
3. **Misses are explained.** When a prediction was off, the system surfaces a likely reason.

### What we explicitly do not commit to

- "Your costs will go down by X%." Labour cost moves for many reasons; promising an outcome we can't fully cause creates an expectation we can't reliably hit.
- "Predictions will be within X% accuracy on day one." Cold-start accuracy is bad; commit to improvement, not absolute accuracy at the start.
- "Every prediction will be explained." LLM layer produces explanations when it adjusts. Pure baseline predictions are explained by their math components.

### The metric

Primary: **MAPE on next-week daily revenue, computed weekly per business.**

```
MAPE_week_N = mean(|predicted - actual| / actual) over the 7 days of week N,
              EXCLUDING days where actual = 0 (closed days)
```

Vero is closed Sundays plus most public holidays — that's 7-10 days per quarter where MAPE is undefined. Including them as "100% error" or "0% error" both lie. Excluding them is honest.

Secondary metrics:
- MAPE by weekday
- MAPE by surface
- **MAPE by horizon** — uses `prediction_horizon_days` derived from `first_predicted_at`, with backtests excluded from logging
- Prediction bias (signed mean error)

### What this requires from the architecture

- Audit ledger working from day 1 of every customer's tenure (in the prod backend, even while UI is gated)
- `model_version` per row for apples-to-apples comparison across changes
- Reconciler runs reliably and idempotently every day
- At least 30 days of audit data per business before any operator-facing accuracy claim is shown

---

## Section 2 — Schema: `daily_forecast_outcomes`

### DDL

```sql
CREATE TABLE daily_forecast_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  forecast_date DATE NOT NULL,

  surface TEXT NOT NULL CHECK (surface IN (
    'consolidated_daily',
    'scheduling_ai_revenue',
    'weather_demand',
    'llm_adjusted'
  )),

  predicted_revenue INTEGER NOT NULL,
  baseline_revenue INTEGER,

  first_predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  prediction_horizon_days INTEGER GENERATED ALWAYS AS
    (forecast_date - first_predicted_at::date) STORED,

  model_version TEXT NOT NULL,
  snapshot_version TEXT NOT NULL,
  inputs_snapshot JSONB NOT NULL,

  llm_reasoning TEXT,
  confidence TEXT CHECK (confidence IN ('high', 'medium', 'low')),

  actual_revenue INTEGER,
  error_pct NUMERIC(8,4),
  error_attribution JSONB,
  resolved_at TIMESTAMPTZ,
  resolution_status TEXT CHECK (resolution_status IN (
    'pending',
    'resolved',
    'unresolvable_no_actual',
    'unresolvable_data_quality',
    'unresolvable_zero_actual'
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

-- RLS (matching M020 pattern verbatim)
ALTER TABLE daily_forecast_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY daily_forecast_outcomes_read ON daily_forecast_outcomes
  FOR SELECT
  USING (
    org_id IN (
      SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
    )
  );

-- Service role bypasses RLS by default in Supabase; no explicit write policy needed.
-- Owner-side UPDATEs are not supported in v1 (no operator action writes to this table).

-- Retention RPC (M020 pattern verbatim, table name swapped)
CREATE OR REPLACE FUNCTION prune_daily_forecast_outcomes()
RETURNS INT
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH deleted AS (
    DELETE FROM daily_forecast_outcomes
    WHERE forecast_date < CURRENT_DATE - INTERVAL '3 years'
    RETURNING 1
  )
  SELECT COALESCE(COUNT(*)::int, 0) FROM deleted;
$$;

GRANT EXECUTE ON FUNCTION prune_daily_forecast_outcomes() TO service_role;
```

### Idempotency

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

### Backtest write guard

Caller MUST refuse to insert audit rows for `forecast_date < CURRENT_DATE` unless explicitly in backfill mode (see Section 5). This prevents the dashboard's "regenerate yesterday's prediction with today's data" calls from polluting the audit log with negative `prediction_horizon_days`. Implementation: in `dailyForecast()`, if `forecast_date < CURRENT_DATE` and `options?.backfillMode !== true`, return the prediction without logging.

### `inputs_snapshot` structure (consolidated_v1)

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
    "kommun": "0180",
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
    "filter_predicate": "alert_type IN ('revenue_drop','revenue_spike') AND confirmation_status = 'confirmed'"
  },
  "data_quality_flags": []
}
```

`data_quality_flags` is an array. Possible values:
- `'backfilled_observed_as_forecast'` — set in backfill rows; signals that weather signal used observed data, not historical forecasts (see Section 5)
- `'low_history'` — business has <60 days of audit data
- `'anomaly_window_uncertain'` — ≥1 day in baseline window has unconfirmed anomaly alert

### `inputs_snapshot` for legacy surfaces (legacy_v1)

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

`consolidated_v1` is a strict superset. Analyses join across surfaces by filtering on `snapshot_version`.

### `error_attribution` structure

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
    "reason": "weather_daily_observed_field_missing"
  },
  "notes": "Forecast called for warm dry; baseline assumed lift. Actual weather unavailable for delta computation."
}
```

`weather_forecast_actual_delta.available = false` is the honest answer when weather_daily lacks observed data for the resolved date. Don't pretend.

---

## Section 3 — The consolidated forecaster

### The function

```typescript
// lib/forecast/daily.ts

export type DailyForecast = {
  predicted_revenue: number       // integer (rounded)
  baseline_revenue: number        // integer
  components: {
    weekday_baseline: number
    yoy_same_month_anchor: number | null
    weather_lift_pct: number
    weather_change_pct: number
    holiday_lift_pct: number
    klamdag_pct: number
    school_holiday_pct: number
    salary_cycle_pct: number
    this_week_scaler: number
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
    skipLogging?: boolean
    overrideModelVersion?: string
    asOfDate?: Date           // for honest backfill
    backfillMode?: boolean    // bypasses backtest write guard
  }
): Promise<DailyForecast>
```

### Computation logic

```
1. Load inputs in parallel (scoped by asOfDate if provided):
   - daily_metrics for: same weekday rolling window
   - monthly_metrics for: same-month-last-year
   - weather_daily for: this date's forecast, this date's seasonal norm
   - holiday calendar
   - school_holidays for: business's kommun
   - business calibration

2. Filter out anomaly-contaminated days:
   Predicate: alert_type IN ('revenue_drop','revenue_spike')
              AND confirmation_status = 'confirmed'
              AND period_date IN (baseline_window_dates)

3. Compute weekday baseline using lib/forecast/recency.ts:
     baseline = recencyWeightedAverage(
       sameWeekdayDays,
       { recentWindowDays: 28, recencyMultiplier: 2.0 }
     )

4. Apply YoY anchor (if available):
   If yoy_same_month_anchor IS NOT NULL:
     trend_factor = (current_month_actual_so_far / yoy_same_month) * trailing_12m_growth
     baseline = baseline * trend_factor
   Else: no anchor

5. Apply multiplicative adjustments in fixed order:
     adjusted = baseline
     adjusted *= weather_lift_factor
     adjusted *= weather_change_factor
     adjusted *= holiday_lift_factor
     adjusted *= klamdag_factor
     adjusted *= school_holiday_factor
     adjusted *= salary_cycle_factor
     adjusted *= this_week_scaler

6. Round to integer.

7. Compute confidence:
     - 'high' if all signals available AND business has >180 days history
     - 'medium' if some signals missing OR business has 60-180 days history
     - 'low' if many signals missing OR business has <60 days history

8. Build inputs_snapshot with samples_used per multiplier.

9. Backtest write guard:
     If forecast_date < CURRENT_DATE AND !options.backfillMode:
       return forecast without logging (this is a back-test, not a prediction)

   Else if !options.skipLogging:
     INSERT INTO daily_forecast_outcomes
     (surface = 'consolidated_daily', snapshot_version = 'consolidated_v1', ...)
     ON CONFLICT (business_id, forecast_date, surface) DO UPDATE SET ...

10. Return DailyForecast
```

### Sample-size guardrails

| Signal                         | Min samples | Fallback if insufficient                 |
|--------------------------------|-------------|------------------------------------------|
| weekday_baseline               | 4 of last 8 | Use whatever exists; flag low_conf       |
| yoy_same_month                 | 1 prior month | Drop term, no anchor                   |
| weather_lift_factor            | 10 days same bucket | Use 1.0                            |
| weather_change_factor          | 1 prior year same calendar week | Use 1.0                |
| holiday_lift_factor            | 1 prior occurrence | Cluster default or 1.0           |
| klamdag_factor                 | 2 prior klämdag observations | National default 0.90  |
| school_holiday_factor          | 1 prior occurrence (same name) | Cluster default or 1.0 |
| salary_cycle_factor            | 30 days history | Use 1.0                              |

Every multiplier carries `samples_used` in the snapshot so error attribution can distinguish "applied with low confidence" from "defaulted to 1.0 because insufficient data."

### YoY same-weekday: explicit deferral for Vero

Vero's first positive-revenue day is 2025-11-24. Same-weekday-last-year lookups for any 2026 date before 2026-11-24 return no data. The signal is implemented but inactive for Vero until 2026-11-24. As a substitute, **YoY same-month from `monthly_metrics`** (Vero has 16 months) provides a trend anchor.

### Migration path from existing forecasters

**Phase A — Shadow mode:**
- `dailyForecast()` runs alongside legacy, logs as `consolidated_daily`.
- Both legacy forecasters keep running and additionally log to `daily_forecast_outcomes`.
- Nothing in customer UI changes.
- After 2 weeks of shadow: compare MAPE in admin view.

**Phase B — Controlled cutover (separate ~1.5-week window, see Section 9):**

Four staged flag flips, each its own PR:

1. **Dashboard chart** — flag `PREDICTION_V2_DASHBOARD_CHART`. Affects `OverviewChart`, `computeWeekStats`.
2. **Scheduling page** — flag `PREDICTION_V2_SCHEDULING_PAGE`. Affects `app/scheduling/page.tsx`.
3. **Monday Memo** — flag `PREDICTION_V2_MONDAY_MEMO`. Affects `lib/ai/weekly-manager.ts:17,327`.
4. **Exports / report templates** — flag `PREDICTION_V2_EXPORTS` (audit needed during implementation to enumerate).

Each is reversible per-business in seconds. None ship until Phase 2 validation says they should.

**Phase C — Deprecation (post-cutover):**
- Stop logging legacy surfaces.
- Remove `LEGACY_*_FALLBACK` flags after one stable month.
- Keep lib functions for re-comparison if needed.

### Conflict with existing `forecast_calibration.dow_factors`

**Decision: deprecate.** The consolidator's per-weekday rolling baselines (with anomaly-contamination filtering and sample-size guardrails) replace what `dow_factors` was attempting. The cron at `/api/cron/forecast-calibration` is removed from `vercel.json` in Piece 0. The `forecast_calibration` table stays (M020 reconciler still writes `accuracy_pct` and `bias_factor`); only `dow_factors` is dead.


---

## Section 4 — Signals: what's used today, what we're adding

### Already used in legacy forecasters

- Per-business per-weekday recency-weighted baselines (`lib/forecast/recency.ts`: 28-day cutoff, 2.0 multiplier on recent vs older)
- Weather bucket multipliers (when `weather_daily` exists; **broken in prod until Piece 0 fixes M015**)
- Swedish public holidays (binary flag, type-aware lift via `lib/holidays/sweden.ts`)
- This-week scaler clamp (floor 0.75, ceil 1.25)

### New signals — full specifications

#### 1. YoY same-month (interim) and same-weekday (long-term)

**Same-month logic:** For target date's month, look up `monthly_metrics.revenue` for the same month one year prior. Apply trailing-12-month growth multiplier.

**Same-weekday logic:** For target date, find the same weekday closest to one year prior in `daily_metrics`. Apply trailing-12-month growth multiplier.

**Vero status:**
- Same-month: 16 months of `monthly_metrics`. **Active immediately.**
- Same-weekday: first positive day 2025-11-24. **Active 2026-11-24 onwards.**

**Sequencing:** Week 8 implements both code paths. Same-month is active for Vero; same-weekday logs unavailability until enough history accumulates.

#### 2. Klämdag detection

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
**Fallback:** national default factor of 0.90 (cluster-derived later). Active immediately.
**Vero status:** ~1-2 klämdag candidates crossed since 2025-11-24. National default applies for several years.

#### 3. School holidays

**Schema:**

```sql
CREATE TABLE school_holidays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kommun TEXT NOT NULL,         -- SCB kommun code, e.g. '0180' (Stockholm)
  lan TEXT NOT NULL,            -- 'STHM', 'GBG', 'MMX' etc
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  name TEXT NOT NULL,           -- 'sportlov', 'paasklov', 'sommarlov', 'hostlov', 'jullov'
  source TEXT NOT NULL,         -- 'skolverket'
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (kommun, start_date, name)
);
```

`businesses.city` is currently free-text. Implementation needs `business → city → kommun` resolution. Decision (per "build it right"): proper kommun-level mapping. Adds a `kommun TEXT` column to `businesses` (Piece 3 batch 2 migration), with manual backfill for existing customers.

**Skolverket scraper:** monthly cron at `/api/cron/skolverket-sync`, schedule `0 4 1 * *`. Scrapes Skolverket's published lov calendar per kommun. On scrape failure: logs error, retries next month, falls back to last-known data. Effort estimate: 2-3 days.

#### 4. Salary cycle (Swedish payday is the 25th)

Day-of-month features:
- `days_since_last_25th` (0-30)
- `days_until_next_25th` (0-30)
- `phase`: 'post_payday' (0-6), 'mid_month' (7-21), 'pre_payday' (22-30)

**Per-business factor learner:** per-phase median ratio of revenue / weekday-baseline, computed monthly from audit data. Simpler and more interpretable than continuous regression for v1.

**Date convention:** ISO mid-day UTC (`'T12:00:00Z'`) — matches `lib/forecast/recency.ts`. The legacy `lib/weather/demand.ts` mixed convention is fixed when its logic is consolidated into `dailyForecast()`.

**Vero status:** 145 days available, meets threshold immediately.

#### 5. Weather change relative to seasonal norm

Today's forecast minus multi-year average for this calendar date.

**Dependencies:** `weather_daily` with at least 1 prior year. **Currently missing in prod (M015 not applied).** Piece 0 fix:
- Apply M015 (5 minutes)
- Backfill 2-3 years of historical Open-Meteo data via `app/api/admin/weather/backfill/route.ts` (extended with `start_date` query param)

**Sequencing:** Week 13. Active once Piece 0 backfill is complete.

#### 6. Day-of-month patterns

Per-business factor for day-of-month buckets (1-7, 8-14, 15-21, 22-31). Same learner type as salary cycle.

**Vero status:** 145 days available, meets 60-day threshold.

### Signal addition strategy

One at a time. Each addition is followed by 5-7 days of audit accumulation, then check the log: did MAPE improve? If a signal didn't help, **cut it**.

Order:

1. Week 8: YoY same-month + YoY same-weekday code path
2. Week 8: klämdag detection
3. Week 9: salary cycle
4. Week 9: model_version bump; freeze v1 spec
5. Week 13: school holidays (proper kommun mapping + scraper)
6. Week 14: weather_change_vs_seasonal
7. Week 14: day_of_month patterns

(Phase B switchover lands in its own dedicated window between signal batches — see Section 9.)

---

## Section 5 — Capture and reconciliation

### Capture sites

Three production paths produce predictions:

1. `/api/forecast/daily` — new canonical endpoint (POST, body `{ business_id, date }`).
2. `/api/scheduling/ai-suggestion` — Phase A logs in addition to existing logic; Phase B (gated by `PREDICTION_V2_SCHEDULING_PAGE`) routes through `dailyForecast()`.
3. `/api/weather/demand-forecast` — same pattern, gated by `PREDICTION_V2_DASHBOARD_CHART`.

All three writes go through `ON CONFLICT (business_id, forecast_date, surface) DO UPDATE` — multiple calls in a day update the same row, latest prediction wins.

### Backtest write guard

**Decision: skip the audit insert if `forecast_date < CURRENT_DATE` and not in backfill mode.** This avoids dashboard back-test calls (where the operator is reviewing what we predicted yesterday with today's data) polluting MAPE-by-horizon with negative values.

### Backfill on Vero

After Piece 0 + Piece 1 + Piece 2 ship, run a one-time backfill walking Vero's 145 days through `dailyForecast({ skipLogging: true, asOfDate, backfillMode: true })` followed by inline insert.

```typescript
async function backfillVeroAuditLedger() {
  const veroBusinessId = '...';
  const startDate = new Date('2025-11-24');
  const endDate = subDays(new Date(), 1); // through yesterday
  const dates = enumerateDates(startDate, endDate);

  for (const date of dates) {
    const actual = await getActual(veroBusinessId, date);
    if (!actual || actual === 0) continue; // skip missing/zero

    const forecast = await dailyForecast(veroBusinessId, date, {
      skipLogging: true,
      asOfDate: subDays(date, 1),
      backfillMode: true
    });

    // Add data quality flag for backfill methodology
    forecast.inputs_snapshot.data_quality_flags.push('backfilled_observed_as_forecast');

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

### Backfill weather data leakage (Decision J)

Historical weather data from Open-Meteo's `archive-api` returns **observed** weather, not the forecast that existed N days before. We don't have stored historical forecasts. So when the backfill script computes the consolidated_daily prediction for 2026-04-15 "as of" 2026-04-14, it uses *observed* 2026-04-15 weather as if it were the forecast.

**Decision:** accept this with explicit caveat. Backfilled rows carry `data_quality_flags: ['backfilled_observed_as_forecast']` so any analysis can filter them out or treat them differently. MAPE comparisons across backfilled vs live data are not strictly comparable; admin view labels them distinctly.

This gives us 90+ days of audit data on day 1 of Phase A instead of waiting two weeks of shadow mode. The trade-off: backfilled MAPE will look slightly better than real-life forecasts produce, because we're cheating on weather. Documented; not hidden.

### `dailyForecast({ asOfDate })` data scoping

Every input source is filtered by `asOfDate`:

| Source | Filter |
|---|---|
| `daily_metrics` | `WHERE date <= asOfDate` |
| `monthly_metrics` | `WHERE month <= month(asOfDate)` |
| `anomaly_alerts` | `WHERE created_at <= asOfDate` |
| `forecast_calibration` (pre-deprecation) | `WHERE updated_at <= asOfDate` |
| Holiday calendar | Time-invariant ✓ |
| `school_holidays` | Time-invariant for past dates ✓ |
| `weather_daily` | Uses observed (the leakage above) |
| `forecast_patterns` | `WHERE found_at <= asOfDate AND status='active'` |

### Reconciler cron

Schedule: **07:30 UTC daily** at `/api/cron/daily-forecast-reconciler`. Runs after master-sync (05:00) and `ai-accuracy-reconciler` (07:00).

```typescript
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
        SELECT revenue FROM daily_metrics
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

      // Anomaly contamination check (uses Piece 0 confirmation_status)
      const isContaminated = await db.query(`
        SELECT 1 FROM anomaly_alerts
        WHERE business_id = $1
          AND period_date = $2
          AND alert_type IN ('revenue_drop', 'revenue_spike')
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
      log.error('reconciler.row_failed', { id: row.id, error: err });
    }
  }

  await alertOnStalePending();
  return { resolved, deferred, marked_unresolvable };
}
```

Idempotent re-run via `WHERE resolution_status = 'pending'`.

### Anomaly-confirm workflow (Piece 0)

**Schema migration:**

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

**API: extend existing `/api/alerts` PATCH endpoint** with two new actions. v3 does NOT create a new `/api/anomalies/*` namespace.

```typescript
// app/api/alerts/route.ts (extended)
// Existing PATCH: { id, action } where action ∈ {'dismiss', 'mark_read'}
// Adds:           { id, action, notes? } where action ∈ {'confirm', 'reject'}

if (action === 'confirm') {
  await supabase.from('anomaly_alerts')
    .update({
      confirmation_status: 'confirmed',
      confirmed_at: new Date().toISOString(),
      confirmed_by: user.id,
      confirmation_notes: body.notes ?? null
    })
    .eq('id', body.id)
    .eq('org_id', auth.orgId);
}
// similar for 'reject'
```

**UI scope: alerts page only.**

The action buttons land on `app/alerts/page.tsx` next to the existing dismiss/mark-read buttons. The dashboard pill (`components/dashboard/DashboardHeader.tsx`) **stays a one-line link**. No popover work in Piece 0.

Operator copy:
- Confirm button: **"Yes — exclude from baseline predictions"** (concrete, action-oriented)
- Reject button: **"No — this was a normal day"** (matches operator mental model better than "the prediction was wrong")
- Confirmed-status badge: **"Confirmed"** with a checkmark icon
- Tooltip on confirm: "Marks this day as a real one-time event so future predictions don't treat it as typical."

### Vero anomaly triage runbook (Piece 0 deployment step)

After Piece 0 ships, Vero has 11 existing alerts (per investigation), all defaulting to `confirmation_status='pending'`. The contamination filter has nothing to filter on until these are triaged.

**Runbook step:** schedule a 20-30 minute call with Vero's operator within the first week of Piece 0. Walk through each alert. Confirm or reject each one. Document in deployment log. After this triage, the contamination filter has real data to operate on.

For new customers in the future: a similar triage happens within their first month.

### Stale-pending alerting

Reuses existing ops alert channel (`data-source-disagreements-alert` pattern):

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
- Rolling 7/30/90-day MAPE per business per surface (excluding zero-actual rows; backfilled rows separately labeled)
- MAPE-by-horizon chart using `prediction_horizon_days`
- MAPE trend sparkline
- Distribution of `error_attribution.primary_factor`
- List of recent `pending` rows past 3 days
- Per-signal contribution to error reduction
- LLM-adjusted vs baseline-only MAPE comparison

Admin-only initially. Operator-facing view (`/predictions/accuracy`) is gated behind `PREDICTION_V2_ACCURACY_VIEW` flag, default OFF.


---

## Section 6 — LLM adjustment layer

### Purpose

The LLM does not predict revenue from scratch. It adjusts a math baseline based on context the math doesn't see, and produces an operator-facing explanation. Math produces the number, LLM adjusts and explains.

### Activation criteria

LLM layer activates per-business when **all** of:

1. ≥30 days of resolved audit data in `daily_forecast_outcomes` for this business
2. `consolidated_daily` MAPE is being computed reliably
3. Per-business kill switch flag is unset
4. Cost cap not exceeded
5. **Per-business feature flag** `PREDICTION_V2_LLM_ADJUSTMENT` is ON

If the LLM call fails (timeout, 5xx, parse error): no `llm_adjusted` row written; caller falls back to `consolidated_daily`. Failure logged via `lib/ai/usage.ts` (existing infra). Alert fires if failure rate exceeds 10% in any 1-hour window.

### When the layer runs

Re-adjust on context change, not on every refresh. Triggered when:
- A new consolidated_daily prediction has been computed AND
- One of:
  - The previous llm_adjusted row for this (business, forecast_date) is more than 24h old
  - Weather forecast changed materially (>2°C or precipitation flip)
  - A new owner-flagged event has been added/removed for forecast_date
  - A new active pattern has been promoted for this business
  - A new anomaly has been confirmed in the last 7 days

The 14-day horizon refresh is **staggered**: 1 horizon per day rotating across the business's 14 forecast days, rather than firing all 14 simultaneously. Spreads cost and respects rate limits.

### Prompt structure

```typescript
async function generateAdjustment(
  forecast: DailyForecast,
  context: AdjustmentContext
): Promise<LLMAdjustment> {

  // Deterministic summary computed client-side, not via LLM
  const recentReconciliation = await computeReconciliationSummary(
    forecast.business_id,
    { days: 90 }
  );
  // Returns structured JSON:
  // {
  //   weekly_mape: [...],
  //   mape_by_weekday: {...},
  //   mape_by_horizon: {...},
  //   five_worst_days: [{ date, predicted, actual, primary_factor }, ...],
  //   total_resolved_count: N
  // }

  const upcomingContext = {
    holidays_next_14d: await getUpcomingHolidays('SE', forecast.date, 14),
    school_holidays_active: await fetchActiveSchoolHolidays(forecast.business_id),
    weather_forecast: forecast.inputs_snapshot.weather_forecast,
    recent_anomalies: await fetchRecentConfirmedAnomalies(forecast.business_id, { days: 14 }),
    owner_flagged_events: await fetchOwnerFlaggedEvents(forecast.business_id, forecast.date),
    learned_patterns: await fetchActivePatterns(forecast.business_id)
  };

  const systemPrompt = `You are a forecast adjustment system for a Swedish restaurant.

Your job: take a math-based revenue prediction and adjust it ONLY when there is concrete reason to believe the math missed something. Default to no adjustment.

You receive:
- The baseline math prediction with components and inputs_snapshot
- Recent reconciliation history (deterministic stats, not narrative)
- Upcoming context (holidays, weather, anomalies, owner-flagged events, learned patterns)

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
- Confidence reflects certainty about direction, not magnitude.`;

  const userPrompt = JSON.stringify({
    forecast_date: forecast.date,
    baseline_prediction: forecast.predicted_revenue,
    components: forecast.components,
    inputs_snapshot: forecast.inputs_snapshot,
    recent_reconciliation: recentReconciliation,
    upcoming_context: upcomingContext
  }, null, 2);

  const startTime = Date.now();

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

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
  } catch (err) {
    await logAiRequest(db, {
      request_type: 'forecast_adjustment',
      status: 'error',
      duration_ms: Date.now() - startTime,
      business_id: forecast.business_id,
      org_id: forecast.org_id,
      error: String(err)
    });
    return null; // caller falls back to baseline
  }
}
```

### Cost projection (deterministic summary, realistic input size)

- System prompt: ~500 tokens (cacheable)
- inputs_snapshot: ~600 tokens
- recent_reconciliation (deterministic JSON): ~1,500 tokens
- upcoming_context: ~1,500 tokens
- learned_patterns: 0-1,000 tokens
- **Total input: ~4,000-5,000 tokens** (down from v2's 5,500-6,500 because no narrative summarization needed)
- **Output: ~400 tokens**

**Per-call (Haiku 4.5):** ~$0.006

**Per-business-per-day with staggered + change-driven activation:** ~10 calls average, worst-case ~18.

- Average: $0.06/business/day = ~$1.80/business/month
- Worst case: $0.11/business/day = ~$3.30/business/month

**At scale:**
- 10 customers: $18-33/month
- 50 customers: $90-165/month
- 500 customers: $900-1,650/month

Tracked via existing `ai_request_log` and `ai-daily-report` cron.

### Rate limits

Anthropic Tier 2 (~$1k/month spend): 1000 RPM, ~80k input TPM. Staggered horizon refresh + change-driven activation keeps per-minute load well under limits at any reasonable customer count. For N≥20 customers, switch to Anthropic Message Batches API for non-urgent re-adjustments — same-day re-adjustments stay sync.

### Output schema

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

Adjusted prediction logged with `surface = 'llm_adjusted'`. Both surfaces reconciled. After 90 days we directly compare which has lower MAPE.

### Kill switch criteria

Per-business automatic:

```
After 90 days of LLM-adjusted predictions:
  baseline_mape   = avg MAPE of consolidated_daily
  adjusted_mape   = avg MAPE of llm_adjusted (excluding zero-actual)

  If adjusted_mape >= baseline_mape:
    auto-disable LLM adjustment for this business
    log decision to ops alert channel
    notify admin

  If adjusted_mape < baseline_mape - 0.02:
    confirm LLM is adding value (>2pp improvement)
```

Manual kill switch: admin route + per-business config (matches `is-agent-enabled.ts` pattern).
Globally killable: env-level `LLM_ADJUSTMENT_ENABLED` flag.

---

## Section 7 — Pattern extraction and feedback

### The weekly job

Schedule: **Sunday 01:30 UTC** at `/api/cron/weekly-pattern-extraction`. Verified open in `vercel.json` (api-discovery is at 02:00).

```typescript
async function extractPatterns(businessId: string, orgId: string) {
  const recent = await fetchResolvedForecasts(businessId, { days: 60 });

  if (recent.length < 30) return; // not enough data

  const systemPrompt = `You are a pattern extraction system. Given 60 days of revenue prediction outcomes for a Swedish restaurant, identify systematic patterns in the prediction errors.

A "pattern" is a consistent, evidence-backed observation that suggests the math model could be improved.

You receive an array of resolved predictions, each with:
- forecast_date, day_of_week, predicted_revenue, actual_revenue, error_pct
- inputs_snapshot (signals at prediction time)
- error_attribution

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

  // ... LLM call, parseAndValidate, storePatterns
}
```

### Storage schema

```sql
CREATE TABLE forecast_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  cluster_id TEXT,
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

Pattern auto-promotion deferred to v2 (manual promotion only for first 6 months).

### Pattern lifecycle

1. **proposed** — LLM job identified, logged.
2. **active** — Manually promoted; read by LLM adjustment layer.
3. **invalidated** — Subsequent extraction found pattern no longer holds.
4. **rejected** — Admin marked as not useful. Won't be re-proposed for 90 days.

### Operator visibility

Admin-only initially. Becomes operator-facing under `PREDICTION_V2_ACCURACY_VIEW` flag.

---

## Section 8 — Cross-customer extension

### Cluster definition

`(cuisine, location_segment, size_segment)` tuple. Schema additions:

```sql
ALTER TABLE businesses
  ADD COLUMN cuisine TEXT,             -- 'italian', 'asian', 'nordic', etc.
  ADD COLUMN location_segment TEXT,    -- 'city_center', 'residential', etc.
  ADD COLUMN size_segment TEXT,        -- 'small', 'medium', 'large'
  ADD COLUMN kommun TEXT;              -- SCB kommun code, for school holidays

CREATE TABLE business_cluster_membership (
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  cluster_dimension TEXT NOT NULL,
  cluster_value TEXT NOT NULL,
  manually_set BOOLEAN DEFAULT FALSE,
  set_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (business_id, cluster_dimension, cluster_value)
);

CREATE INDEX idx_cluster_lookup ON business_cluster_membership (cluster_dimension, cluster_value);
```

The columns on `businesses` are denormalized for fast lookup. The `business_cluster_membership` table allows multi-cluster membership (e.g. a restaurant in both 'tourist_zone' and 'city_center'). For Vero: pre-populate as `('italian', 'city_center', 'medium')` plus `kommun = '0180'` (Stockholm).

### What activates when N≥5

- Cluster-level baselines for cold-start
- Cluster-level patterns
- Cross-validation of per-business patterns
- Operator-facing "businesses like yours" insights (pending privacy review)

### Schema decisions locked in now

- Every prediction tagged by `business_id` AND `org_id`
- Every signal in `inputs_snapshot` tagged by scope (`universal`, `locale_se`, `integration`)
- `forecast_patterns.cluster_id` exists from day 1 (null until activated)
- `business_cluster_membership` schema defined and populated for Vero on day 1

### Synthetic test business

For testing cluster machinery before customer #5 lands: seed file `seed/synthetic_business.sql` inserts a fake business in a separate test org with synthetic `daily_metrics` rows. Used in dev/staging only. ~1 day to set up. **Recommended but deferred to post-Piece 5 work.**


---

## Section 9 — Sequencing and milestones

### The revised plan: ~23-24 calendar weeks total

19-20 weeks of build phase + 3-4 weeks of validation + controlled cutover. Throughout the build phase, **Vero sees zero customer-facing changes** except where explicitly noted (the "silent improvement" cases in Section 11).

#### Weeks 1-3: Piece 0 — Foundation fixes

- **Week 1:**
  - Apply M015 (`weather_daily` table) — 5-minute task
  - Backfill 2-3 years of Open-Meteo historical data (extend `app/api/admin/weather/backfill/route.ts` with `start_date` query param) — bandwidth-bound, runs in parallel
  - Disable `forecast-calibration` cron (remove from `vercel.json`); document deprecation
  - Backfill `created_via` on the 21 pre-M047 `tracker_data` rows
- **Week 2:**
  - Anomaly-confirm workflow migration (add columns, add index)
  - Extend `app/api/alerts` PATCH with `confirm`/`reject` actions
  - UI: add confirm/reject buttons to `app/alerts/page.tsx` action row + confirmed badge + status filter
  - OB-supplement detector tuning — adapt baseline window for step-changes
- **Week 3:**
  - Vero anomaly triage call (operator confirms/rejects existing 11 alerts)
  - Phase A pre-instrumentation: `school_holidays`, `business_cluster_membership`, `business_cluster_columns` migrations applied (DDL only, no data yet for school_holidays)
  - Documentation pass: ops runbook for the new workflows

**Ships:** working weather lift logic (silent improvement), end of OB false-alarm noise (silent improvement), real anomaly-confirm workflow operators can use, 11 existing alerts triaged.

**Milestone:** Vero alerts list shows confirmed/rejected/pending status. Contamination filter has real data.

#### Week 4: Piece 1 — Daily forecast audit ledger

- Migration: `daily_forecast_outcomes` (full schema with `org_id`, RLS, retention RPC matching M020 verbatim)
- Capture instrumentation in `/api/scheduling/ai-suggestion` and `/api/weather/demand-forecast` writing to legacy surfaces
- Reconciler at `/api/cron/daily-forecast-reconciler/route.ts`, scheduled `30 7 * * *` in `vercel.json`
- Backtest write guard
- Admin view: `/admin/predictions/accuracy`
- Stale-pending alerter via existing ops alert channel

**Ships:** every daily prediction logged with full provenance. Reconciler runs nightly. Two legacy surfaces accumulating MAPE data.

#### Weeks 5-6: Customer-facing sprint #1

Whatever's most pressing for AB/Stripe completion or the next customer close. Audit data accumulates.

#### Weeks 7-8: Piece 2 — Consolidated forecaster

- Implement `lib/forecast/daily.ts` with the API from Section 3, including `asOfDate` and `backfillMode` options
- Phase A shadow mode: runs alongside legacy, logs as `consolidated_daily`
- One-time backfill of Vero's 145 days as resolved audit rows (with `data_quality_flags: ['backfilled_observed_as_forecast']`)
- After 1 week of shadow + backfill: compare MAPE in admin view

**Ships:** 90+ days of consolidated_daily MAPE data. Comparison vs legacy in admin view.

#### Weeks 9-10: Piece 3 batch 1 — New signals

- Week 9: YoY same-month + YoY same-weekday code paths, klämdag detection
- Week 10: salary cycle, model_version freeze v1, audit log accumulates

**Ships:** consolidated_daily integrates same-month YoY, klämdag, and salary cycle. 10 days of new audit data with new signals.

#### Weeks 11-12.5: Phase B preparation (its own dedicated window)

- Week 11: Implement four flag-gated cutover PRs (each behind its own `PREDICTION_V2_*` flag, all default OFF):
  - `PREDICTION_V2_DASHBOARD_CHART` (OverviewChart, computeWeekStats)
  - `PREDICTION_V2_SCHEDULING_PAGE` (app/scheduling/page.tsx)
  - `PREDICTION_V2_MONDAY_MEMO` (lib/ai/weekly-manager.ts)
  - `PREDICTION_V2_EXPORTS` (audit + adapt any export templates)
- Week 12: Code review, integration testing on all four PRs
- Week 12.5: Smoke test in staging — verify flag flips work cleanly in both directions

**Ships:** all four cutover paths code-complete and merged. Flags stay OFF — no customer-facing change.

#### Weeks 13-14: Piece 3 batch 2 — Remaining signals

- Week 13: school holidays (Skolverket scraper at `/api/cron/skolverket-sync`, schedule `0 4 1 * *`; kommun mapping for Vero)
- Week 14: weather_change_vs_seasonal (uses backfilled weather_daily history); day_of_month patterns

**Ships:** all six new signals integrated.

#### Week 15: Piece 4.5 — Owner-flagged events

- Migration: `owner_flagged_events` table (DDL below)
- API: CRUD endpoints under `/api/owner-events/*` with full RLS
- UI: dashboard widget at `components/dashboard/OwnerEventFlag.tsx` — operator clicks a date, fills form
- Sync POST + `waitUntil` background fire to re-trigger LLM adjustment for affected horizon dates
- Integration with `dailyForecast()` — events surface in `inputs_snapshot.owner_flagged_events`
- Gated behind `PREDICTION_V2_OWNER_EVENTS_UI`, default OFF

**Ships:** infrastructure ready for owner-flagged events. Customer-facing widget hidden behind flag.

#### Weeks 16-17: Piece 4 — LLM adjustment layer

- Week 16: prompt engineering, output schema validation, kill switch infrastructure, change-driven activation logic, deterministic reconciliation summary computation
- Week 17: integration with `dailyForecast()`, both surfaces logged side-by-side, ai_request_log integration, error handling and graceful degradation

**Ships:** LLM adjustment running in shadow mode for Vero (gated behind `PREDICTION_V2_LLM_ADJUSTMENT`, default OFF — but writes `llm_adjusted` rows to audit ledger so we can compare MAPE without showing customers anything).

#### Week 18: Piece 5 — Pattern extraction (v1)

- Implement `extractPatterns()` and `forecast_patterns` table
- Sunday 01:30 UTC cron at `/api/cron/weekly-pattern-extraction`
- Admin view of proposed patterns
- Manual promotion for first 6 months

**Ships:** the system is now learning from itself. Patterns visible in admin view. **Build phase complete.**

### Weeks 19-22: Validation period

**This is new in v3 and the heart of the build-on-the-side approach.**

- All flags stay OFF for customers throughout
- Audit ledger accumulates real shadow data (~5 weeks of consolidated_daily, llm_adjusted, plus all legacy surfaces)
- Daily check by you / a member of the team:
  - Is `consolidated_daily` MAPE at parity or better than `scheduling_ai_revenue` and `weather_demand` MAPEs?
  - Is `llm_adjusted` MAPE measurably better than `consolidated_daily` baseline?
  - Are pattern extractions producing real patterns or noise?
  - Are reconciler errors low (<2% rows in `unresolvable_*` states)?
- Identify any issues; fix in-place; restart the validation clock if material changes ship
- Don't flip flags until the data says we should

**Gate to proceed to cutover:** `consolidated_daily` MAPE on resolved live (non-backfilled) data must be at parity (within 1pp) of legacy or better, sustained over 30+ days. If not, do not cut over — investigate.

### Weeks 23-24: Phase 3 controlled cutover

Flip flags one at a time for Vero. Each flip is 1 week minimum before the next:

- Week 23 day 1: enable `PREDICTION_V2_OWNER_EVENTS_UI` (operator sees the new event-flag widget)
- Week 23 day 3: enable `PREDICTION_V2_DASHBOARD_CHART` (chart predicted bars switch to consolidated_daily)
- Week 23 day 5: enable `PREDICTION_V2_SCHEDULING_PAGE`
- Week 24 day 1: enable `PREDICTION_V2_MONDAY_MEMO`
- Week 24 day 3: enable `PREDICTION_V2_LLM_ADJUSTMENT` (operator sees adjusted predictions with reasoning)
- Week 24 day 5: enable `PREDICTION_V2_ACCURACY_VIEW` (operator-facing track-record panel)

If any flip looks wrong (operator complaint, MAPE regression, error spike): flip back immediately. Investigate. Re-flip when fixed.

### What absolutely cannot be reordered

- Piece 0 must come first.
- Piece 1 must come before Piece 2-5.
- Piece 4.5 must come before Piece 4 (owner events feeds LLM context).
- Validation period must complete before any flag flips.

### Total calendar time

~23-24 weeks build + validation + cutover. Pieces 0-5: 18 weeks. Validation: 4 weeks. Cutover: 1-2 weeks. Realistic given AB/Stripe parallel track and two customer-facing sprints.

---

## Section 10 — Decisions still open

### Decided in v3

1. ~~Schema parallel vs extend M020~~ — parallel
2. ~~UI loudness~~ — quiet first, loud after testing
3. ~~Customer-facing accuracy claim~~ — conservative version
4. ~~Sequencing~~ — interleave with two customer-facing sprints
5. ~~Anomaly contamination~~ — proper owner-confirm workflow in Piece 0
6. ~~Logging frequency~~ — once per (business, date, surface) per day
7. ~~Owner-flagged events~~ — Piece 4.5
8. ~~Dashboard pill UI scope~~ — alerts page only; pill stays a link
9. ~~API namespace~~ — extend `/api/alerts` PATCH
10. ~~Owner-event trigger~~ — sync POST + `waitUntil`
11. ~~Backfill weather data leakage~~ — observed-as-forecast with `data_quality_flags` caveat
12. ~~Phase B window~~ — own dedicated 1.5 weeks (Weeks 11-12.5)
13. ~~Recent-reconciliation summary~~ — deterministic client-side, not LLM
14. ~~Launch model~~ — build on the side, validate, controlled cutover
15. ~~Edge cases (weather fix, OB detector)~~ — accept silent improvement; both are bug fixes
16. ~~Edge case (anomaly-confirm)~~ — launch early in Piece 0; gives Vero immediate value

### Still open (operator/business calls)

#### A. Specific MAPE target for the public claim

Recommendation: commit publicly to "within 12% on average" at 90-day mark; aim internally for <10%.

#### B. Salary cycle learner type

Per-phase median (interpretable) vs continuous regression. Recommendation: per-phase median for v1.

#### C. Day-of-month learner type

Same question. Same recommendation.

#### D. Operator visibility of LLM reasoning

Always visible / on-click only / threshold-gated. Recommendation: always visible but de-emphasized.

#### E. Cold-start strategy for future customers

Show nothing for 30 days / cluster baselines / day-of-week + weather only. Recommendation: low-confidence weather + day-of-week + holidays from day 1; cluster baselines once N≥5.

#### F. Privacy review for cross-customer learning

Founder/legal review before Piece 6 activates.

#### G. Pattern auto-promotion threshold

Manual forever / auto at evidence_count ≥ 10. Recommendation: manual for first 6 months.

#### H. Validation gate threshold

The architecture says `consolidated_daily` MAPE must be at parity (within 1pp) of legacy. Is 1pp the right tolerance? Tighter (0.5pp) means more confidence but longer validation; looser (2pp) means faster cutover but more risk.

Recommendation: **1pp on resolved non-backfilled data sustained over 30+ days.**

#### I. Sequencing of cutover flag flips

The week-23-24 schedule above flips 6 flags across 2 weeks. Conservative version: 1 flag per week, 6 weeks total. Aggressive: all in 1 week. Recommendation: as written (mid-pace), with explicit "if any flip causes issues, pause and revert" rule.

---

## Section 11 — Launch strategy: build on the side

This is the most important architectural decision in v3. The system is built entirely in production (we need real data flowing through the audit ledger), but every customer-visible surface is gated behind a per-business feature flag, default OFF. Vero sees zero changes during the entire 19-week build phase.

### Why

A 19-week build is too long to ship piecewise to customers. Half-finished prediction systems erode trust faster than no prediction system at all. The marketing claim is "predictions get more accurate the longer you use it" — we don't get to ship a less-accurate version while still calling it an improvement. Better to build the full system, validate it works against real shadow data, then cut over cleanly.

### What runs in prod from week 1

- **Audit ledger** captures real predictions and actuals continuously
- **Reconciler cron** computes errors nightly
- **Consolidated forecaster** runs in shadow mode (logs to audit, doesn't drive any customer UI)
- **LLM adjustment** runs in shadow mode (logs to audit, customer doesn't see)
- **Pattern extraction** runs (admin-only initially)

This is the minimum required to:
- Prove the system works against real Vero data
- Accumulate enough audit history that the LLM has context when activated
- Validate that learning is actually happening before claiming it

### What stays gated (default OFF)

Per-business feature flags following the existing `is-agent-enabled.ts` pattern:

| Flag | Controls |
|---|---|
| `PREDICTION_V2_ANOMALY_CONFIRM_UI` | Confirm/reject buttons on `/alerts` page |
| `PREDICTION_V2_OWNER_EVENTS_UI` | Owner event flagging widget |
| `PREDICTION_V2_DASHBOARD_CHART` | Dashboard chart predicted bars use `consolidated_daily` |
| `PREDICTION_V2_SCHEDULING_PAGE` | Scheduling page uses `consolidated_daily` |
| `PREDICTION_V2_MONDAY_MEMO` | Monday Memo uses `consolidated_daily` |
| `PREDICTION_V2_EXPORTS` | Exports/reports use `consolidated_daily` |
| `PREDICTION_V2_LLM_ADJUSTMENT` | Operator sees LLM-adjusted prediction with reasoning |
| `PREDICTION_V2_ACCURACY_VIEW` | Operator-facing track-record panel |

Each flag is independently flippable per-business. Flips are reversible in seconds. Each flip has a rollback runbook entry.

### Three "silent improvement" exceptions

Three Piece 0 changes can't easily be gated and they're all bug fixes, not features:

1. **`weather_daily` migration M015** — once applied, the existing legacy weather-demand forecaster automatically picks up the data and produces better numbers. Customer sees demand outlook day cards shift slightly. **Documented as a bug fix in changelog. Not gated.**

2. **OB-supplement detector tuning** — once tuned, the detector stops firing daily false alarms. Customer sees fewer alerts. **Documented as a bug fix in changelog. Not gated.**

3. **Anomaly-confirm workflow UI buttons** — the confirm/reject buttons on `/alerts` ARE gated behind `PREDICTION_V2_ANOMALY_CONFIRM_UI`, BUT we flip this flag for Vero in Week 3 of Piece 0 — not at cutover. Reasoning: operator needs to triage existing alerts so the contamination filter has data to work with during shadow. Vero gets one new feature ahead of the rest of the package. If the buttons cause issues, flip back.

These three exceptions are explicitly documented in the deployment runbook and the customer changelog. Vero's operator should be informed before Piece 0 ships.

### Validation gate

After Piece 5 ships (Week 18), no flag flips for at least 4 weeks. During this period:

- Audit ledger accumulates ~30 days of fresh resolved data (live, not backfilled)
- MAPE of `consolidated_daily` must reach parity (within 1pp) of legacy surfaces
- LLM-adjusted MAPE compared to baseline; if not better, kill switch fires before cutover (no operator ever sees the LLM output)
- Pattern extraction reviewed for quality

If validation fails: do not cut over. Identify the issue, fix, restart the validation clock.

### Cutover

Once validation passes, flip flags one at a time for Vero with 1-3 days between each. Watch logs and operator feedback after each flip. Rollback = flip flag off; legacy behavior returns within seconds.

### What "go live" means for new customers

After Vero has been on the new system for 30+ days post-cutover and looks good: future customers onboard with all `PREDICTION_V2_*` flags ON by default. By that point we have receipts.

### Kill switches at every layer

- Per-business feature flags (controlled via admin UI)
- Per-business LLM adjustment kill switch (auto-fires if MAPE worse than baseline)
- Global env-level `LLM_ADJUSTMENT_ENABLED` flag
- Deprecated forecasters kept in code for one stable month post-Phase B Phase C — full revert is `git checkout`

### Communication to Vero

Before any cutover flag flips, send Vero's operator a heads-up:
- "We're rolling out a new prediction system that improves accuracy over time"
- "You'll see [list of changes] over the next 1-2 weeks"
- "If anything looks wrong, tell us — we can roll back any individual change in seconds"

Do not surprise the operator with changed numbers.


---

## Appendix A — Code paths and migration ordering

### Migration order (Piece 0 first; each subsequent migration in its piece)

1. `MXXX_anomaly_confirmation_workflow.sql` (Piece 0, Week 2)
2. `MXXX_weather_daily.sql` — re-applies M015 if needed (Piece 0, Week 1)
3. `MXXX_business_cluster_columns.sql` — adds cuisine, location_segment, size_segment, kommun to `businesses` (Piece 0, Week 3, DDL only)
4. `MXXX_business_cluster_membership.sql` (Piece 0, Week 3, DDL only)
5. `MXXX_school_holidays.sql` (Piece 0, Week 3, DDL only — populated in Week 13)
6. `MXXX_daily_forecast_outcomes.sql` (Piece 1, Week 4)
7. `MXXX_owner_flagged_events.sql` (Piece 4.5, Week 15)
8. `MXXX_forecast_patterns.sql` (Piece 5, Week 18)

Plus deletions:
- Remove `forecast-calibration` cron entry from `vercel.json` (Piece 0, Week 1)

### Existing files modified

- `app/api/scheduling/ai-suggestion/route.ts` — capture instrumentation (Piece 1); flag-gated cutover (Phase B prep, Week 11)
- `app/api/weather/demand-forecast/route.ts` — same
- `lib/forecast/recency.ts` — extended (Piece 2)
- `lib/weather/demand.ts` — most logic lifted into `dailyForecast()` (Piece 2)
- `lib/ai/weekly-manager.ts` — Monday Memo flag-gated cutover (Phase B prep)
- `components/dashboard/OverviewChart.tsx` — flag-gated cutover (Phase B prep)
- `components/scheduling/computeWeekStats.ts` — flag-gated cutover (Phase B prep)
- `app/scheduling/page.tsx` — flag-gated cutover (Phase B prep)
- `app/alerts/page.tsx` — confirm/reject button row (Piece 0, Week 2); flag-gated visibility per `PREDICTION_V2_ANOMALY_CONFIRM_UI`
- `app/api/alerts/route.ts` — extend PATCH with confirm/reject actions (Piece 0)
- `lib/alerts/detector.ts` — handle new confirmation columns (Piece 0)
- `app/api/admin/weather/backfill/route.ts` — accept `start_date` query param override (Piece 0, Week 1)
- `vercel.json` — add new cron entries; remove forecast-calibration

### New files

```
migrations/
  MXXX_anomaly_confirmation_workflow.sql
  MXXX_business_cluster_columns.sql
  MXXX_business_cluster_membership.sql
  MXXX_school_holidays.sql
  MXXX_daily_forecast_outcomes.sql
  MXXX_owner_flagged_events.sql
  MXXX_forecast_patterns.sql

lib/forecast/
  daily.ts                         (Piece 2)
  signals/
    yoy-monthly.ts                 (Piece 3 batch 1)
    yoy-weekday.ts                 (Piece 3 batch 1)
    klamdag.ts                     (Piece 3 batch 1)
    salary-cycle.ts                (Piece 3 batch 1)
    school-holidays.ts             (Piece 3 batch 2)
    weather-change.ts              (Piece 3 batch 2)
    day-of-month.ts                (Piece 3 batch 2)
  llm-adjustment.ts                (Piece 4)
  pattern-extraction.ts            (Piece 5)
  reconciliation-summary.ts        (Piece 4 — deterministic stats helper)
  owner-events.ts                  (Piece 4.5)

lib/anomalies/
  confirmation.ts                  (Piece 0)

lib/skolverket/
  scraper.ts                       (Piece 3 batch 2)

lib/featureFlags/
  prediction-v2.ts                 (Piece 0 — wraps existing is-agent-enabled.ts pattern)

app/api/forecast/
  daily/route.ts                   (Piece 2)

app/api/owner-events/
  route.ts                         (Piece 4.5)
  [id]/route.ts                    (Piece 4.5)

app/api/cron/
  daily-forecast-reconciler/route.ts   (Piece 1)
  weekly-pattern-extraction/route.ts   (Piece 5)
  skolverket-sync/route.ts             (Piece 3 batch 2)

app/admin/predictions/
  accuracy/page.tsx                (Piece 1)
  patterns/page.tsx                (Piece 5)

components/dashboard/
  OwnerEventFlag.tsx               (Piece 4.5)

seed/
  synthetic_business.sql           (post-Piece 5, optional)
```

### `vercel.json` cron additions

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

`forecast-calibration` cron entry **removed** in Piece 0.

### Implementation prompts to write

In order:

1. **Piece 0** — Foundation fixes incl. anomaly-confirm workflow (the prompt accompanying this v3 doc)
2. **Piece 1** — Audit ledger
3. **Piece 2** — Consolidated forecaster + Vero backfill
4. **Piece 3 batch 1** — YoY signals, klämdag, salary cycle
5. **Phase B preparation** — Flag-gated cutover PRs (no flip yet)
6. **Piece 3 batch 2** — School holidays, weather change, day-of-month
7. **Piece 4.5** — Owner-flagged events
8. **Piece 4** — LLM adjustment layer
9. **Piece 5** — Pattern extraction
10. **Validation + cutover runbook** — checklist for the 4-week validation period and flag-flip sequencing

Each prompt follows the disciplined investigation-first pattern: read current state, then implement.

### Owner-flagged events DDL (referenced in Piece 4.5)

```sql
CREATE TABLE owner_flagged_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  event_date DATE NOT NULL,
  event_type TEXT NOT NULL,            -- 'private_event', 'closed', 'extended_hours', 'special_menu', 'other'
  description TEXT,
  expected_impact_direction TEXT
    CHECK (expected_impact_direction IN ('up', 'down', 'neutral')),
  expected_impact_magnitude TEXT
    CHECK (expected_impact_magnitude IN ('small', 'medium', 'large')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES auth.users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_owner_events_business_date ON owner_flagged_events (business_id, event_date);

ALTER TABLE owner_flagged_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY owner_events_read ON owner_flagged_events
  FOR SELECT USING (
    org_id IN (SELECT org_id FROM organisation_members WHERE user_id = auth.uid())
  );

CREATE POLICY owner_events_write ON owner_flagged_events
  FOR ALL USING (
    org_id IN (SELECT org_id FROM organisation_members WHERE user_id = auth.uid())
  );
```

---

## Appendix B — What this architecture commits us to

1. **Predictions are auditable.** Every number we show has a row with full inputs.
2. **The system has a track record.** MAPE-over-time chart per business per surface.
3. **LLM costs scale linearly with customer count** (~$1.80-3.30/business/month at activation).
4. **The audit log is a regulated artifact** — privacy policy must reflect it before customer #2.
5. **Model changes are traceable** via `model_version` and `snapshot_version`.
6. **The system is killable at every layer.**
7. **The moat takes time to manifest.** Proof is the chart of MAPE-over-time.
8. **This investment crowds out other work** (~23-24 weeks total).
9. **Operators have meaningful ways to teach the system.** Anomaly-confirm + owner-flagged events.
10. **Vero sees zero changes during the build.** Trust isn't burned by half-finished features.
11. **Cutover is reversible.** Every flag flip can be reverted in seconds.

---

## Closing

v3 is ready to base implementation prompts on. The architecture is internally consistent, validated against codebase reality (twice), and accommodates the build-on-the-side launch model.

Implementation order: Piece 0 first. Don't deviate.

Each implementation prompt should be reviewed before the next is written — what we learn building Piece 0 informs the schema details and code patterns for everything that follows.

The accompanying Piece 0 implementation prompt is the next deliverable.

---

## Appendix Z — v3.1 decision log (2026-05-08)

Piece 0 investigation surfaced four contradictions between v3 and the codebase. Halt-and-report at `PIECE-0-INVESTIGATION-HALT-2026-05-08.md`. User decision: go with the Claude-recommended path on each.

| # | Issue | Decision | Implementation |
|---|---|---|---|
| 1 | M020 reconciler does NOT write `accuracy_pct`/`bias_factor` to `forecast_calibration` (spec assumed it did). Disabling the `forecast-calibration` cron would freeze those columns and stale the `lib/ai/contextBuilder.ts:483-485` reader feeding /api/ask. | **Move the writes.** Add `accuracy_pct`/`bias_factor` UPSERT to `app/api/cron/ai-accuracy-reconciler/route.ts` BEFORE disabling the legacy cron. Reconciler already aggregates the `actual_revenue`/`suggested_revenue` deltas it would need; one writer is cleaner than two. | Stream B is now "patch reconciler + disable cron," not just "disable cron." |
| 2 | `feature_flags` is keyed `(org_id, flag)`, defaults ENABLED. v3 spec assumes per-business `(business_id, flag)` defaulting OFF — neither matches existing infrastructure. Vero org has TWO businesses (`0f948ac3…` Vero Italiano, `97187ef3…` Rosali Deli); an org-scoped flag flips both at once which defeats Section 11's "Vero Italiano gets anomaly UI ON at end of Week 3" intent. | **New `business_feature_flags` table** parallel to existing `feature_flags`. Same shape plus `business_id`; defaults OFF. Existing `feature_flags` + `is-agent-enabled.ts` stay unchanged for org-scoped agents. | Stream F.1 gains a new migration; Stream F.2 wrapper queries the new table. |
| 3 | Vero org has TWO businesses; v3 spec implies single-row cluster pre-populate. | **Both businesses get rows** with distinct values: Vero Italiano = (italian, city_center, medium, 0180); Rosali Deli = (deli, city_center, small, 0180). Operator can correct during the triage call. | Stream F.1 cluster columns migration includes both UPDATE statements. |
| 4 | v3 spec uses `migrations/MXXX_*.sql` paths — folder doesn't exist; archive/migrations is non-authoritative per CLAUDE.md. | **Use `sql/MXXX-*.sql`** with hyphenated names, matching existing convention (`sql/M048-VERIFICATION-TABLES.sql`, `sql/M051-OVERHEAD-DRILLDOWN-CACHE.sql`). Next free numbers M052+. | All Piece 0 migrations renumbered to M052-M057. |

### v3.1 migration list (Piece 0)

| File | Purpose |
|---|---|
| `sql/M052-TRACKER-CREATED-VIA-BACKFILL.sql` | One-line UPDATE: backfill the ~21 NULL `tracker_data.created_via` rows to `'manual_pre_m047'`. |
| `sql/M053-ANOMALY-CONFIRMATION-WORKFLOW.sql` | ALTER `anomaly_alerts` to add `confirmation_status` / `confirmed_at` / `confirmed_by` / `confirmation_notes` + partial index on `confirmation_status='confirmed'`. |
| `sql/M054-BUSINESS-CLUSTER-COLUMNS.sql` | ALTER `businesses` to add `cuisine` / `location_segment` / `size_segment` / `kommun` IF NOT EXISTS + UPDATEs for both Vero businesses. |
| `sql/M055-BUSINESS-CLUSTER-MEMBERSHIP.sql` | New table `business_cluster_membership` with composite PK + lookup index. No RLS for v1; admin-only writes. |
| `sql/M056-SCHOOL-HOLIDAYS.sql` | New table `school_holidays` with `(kommun, start_date, name)` UNIQUE + lookup index. DDL only — no scraper, no data. |
| `sql/M057-BUSINESS-FEATURE-FLAGS.sql` | New table `business_feature_flags (id, org_id, business_id, flag, enabled, notes, set_by, updated_at)` with `(business_id, flag)` UNIQUE + RLS. Defaults `enabled = false`. |

### Launch model — Piece 0 silent improvements (decided 2026-05-08)

User confirmed the architecture's default: weather backfill and OB-supplement detector tuning ship as silent improvements (no flags). The current "broken weather" (`weather_daily` empty → all-weather averages) and "OB false-alarm spam" (daily re-fires of the same step-change) states are worse than the fixed states; gating bug fixes behind flags whose only purpose is "decide whether to stay broken" was rejected as over-engineering.

The anomaly-confirm UI stays gated behind `PREDICTION_V2_ANOMALY_CONFIRM_UI` per Section 11 — flag flips ON for Vero Italiano at end of Week 3 after the operator triage call.

All Piece 1+ work (consolidated forecaster, audit ledger, LLM adjustment, owner-flagged events) stays gated until Section 11's validation period passes.
