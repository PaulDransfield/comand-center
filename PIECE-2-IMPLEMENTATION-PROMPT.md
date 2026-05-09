# Piece 2 Implementation Prompt — Consolidated Forecaster

> Third implementation piece of the Prediction System architecture (`PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md`).
> Written 2026-05-09 against architecture v3 + Appendix Z + Piece 0 + Piece 1 completion reports.
> Time budget: 4-6 days of focused work (the biggest single piece in the roadmap).
> Output: `lib/forecast/daily.ts` + `/api/forecast/daily` endpoint + Vero backfill, all gated behind a per-business feature flag (Phase A: build alongside; Phase B: cut over).

---

## Context — read this before doing anything

The two legacy forecasters (`/api/scheduling/ai-suggestion` revenue side, `lib/weather/demand.ts`) each compute their own version of "what'll this day's revenue be" using different math, different signals, and producing different numbers for the same day. Piece 1's audit ledger now captures both surfaces' predictions so we can grade them, but the goal of Piece 2 is **one canonical forecaster** that both surfaces (and any future surface) consume.

The architecture (§3) calls this `dailyForecast()` — a single function that produces:
- `predicted_revenue` (integer)
- 9 component breakdowns (weekday baseline, YoY anchor, weather lift, weather change, holiday, klämdag, school holiday, salary cycle, this-week scaler)
- A complete `inputs_snapshot` (consolidated_v1 shape, in arch §2)
- Confidence label

Piece 2 is the load-bearing piece. Pieces 3-5 (new signals, LLM adjustment, pattern extraction) all depend on the consolidated forecaster's `inputs_snapshot` carrying every signal in a known shape. Get this right.

Three things to internalize:

1. **Build alongside; don't replace.** Phase A of the migration plan: `dailyForecast()` ships behind the per-business flag `PREDICTION_V2_DASHBOARD_CHART` (and similar flags for scheduling). Both legacy forecasters keep running. The capture instrumentation now logs all three surfaces — `consolidated_daily`, `scheduling_ai_revenue`, `weather_demand` — so the reconciler can grade them side-by-side. If MAPE for `consolidated_daily` is competitive after a couple weeks, Phase B flips a flag flips and one consumer at a time cuts over. Don't rip out the legacy forecasters in Piece 2.

2. **Single function, single chokepoint.** Every call to `dailyForecast()` runs through one validation + capture path. No copy-paste of weekday-baseline math into multiple consumers. If a multiplier needs to change, it changes in one file, not five.

3. **Investigation before implementation.** Same discipline as Pieces 0-1. Before you touch anything, verify the assumptions in this prompt match the actual codebase state. Halt-and-report on contradictions — that pattern caught real spec errors twice in Piece 0 and once in Piece 1.

---

## Pre-flight: facts confirmed in Piece 1 completion report + today's session

Before reading the work streams:

1. **`daily_forecast_outcomes`** exists, has 30 rows (12 weather_demand + 18 scheduling_ai_revenue captures from today's testing). RLS reads work via `organisation_members`. Reconciler at 10:00 UTC daily.
2. **`captureForecastOutcome()`** in `lib/forecast/audit.ts` is the canonical write path — Piece 2 calls this for `surface='consolidated_daily'`. Backtest write guard already inside the helper.
3. **`anomaly_alerts.confirmation_status`** exists with values `'pending' | 'confirmed' | 'rejected' | 'auto_resolved'`. Use `confirmed` to filter contaminated days from baselines.
4. **`businesses.cuisine` / `location_segment` / `size_segment` / `kommun`** populated for Vero (Piece 0 M054). These power per-business signals (e.g. school holiday lookup uses `kommun`).
5. **`weather_daily`** populated with ~3 years for both Vero businesses (Piece 0 backfill). Bucket lift logic works.
6. **`tracker_data.is_provisional`** flag from M062 is live — readers should filter `is_provisional = false` for forecasts based on closed-month YoY (the prior session's work).
7. **Cron stagger** post-Piece-0: `master-sync` 04:00, `ai-accuracy-reconciler` 07:00, `daily-forecast-reconciler` (Piece 1) 10:00, `today-data-sentinel` 14:00. Piece 2 doesn't add a cron — it's a callable lib + endpoint.
8. **Vero's first positive-revenue day is 2025-11-24** — YoY same-weekday lookups for any 2026 date before 2026-11-24 return no data. Architecture §3 calls this an explicit deferral; YoY same-month (from monthly_metrics) substitutes for now.
9. **Recency helpers** at `lib/forecast/recency.ts` — `weightedAvg`, `thisWeekScaler`, `RECENCY` constants. Already used by both legacy forecasters; use for Piece 2's weekday baseline too.
10. **`is_provisional` filter** must apply to history reads (don't anchor on partial current/prior month).

If any of the above turns out to be wrong when you investigate the codebase, **halt and report**.

---

## What to do

This piece has six work streams. They're ordered by dependency — A is foundational, B-E build on it, F is the cutover gate.

### Stream A — `dailyForecast()` core function (Day 1-2, ~8 hours)

#### A.1 Investigation

1. Read `PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md` Sections 2-4 end-to-end. The `inputs_snapshot consolidated_v1` shape is the contract; read it carefully. The computation order in §3 step 5 is fixed — multipliers compose in the listed sequence.
2. Read `lib/forecast/recency.ts` to understand the existing `weightedAvg` semantics. Piece 2's weekday baseline calls this same function.
3. Read `lib/holidays/sweden.ts` and `lib/holidays/index.ts`. Confirm `getHolidaysForCountry()` and `getUpcomingHolidays()` are the right entry points.
4. Read `lib/weather/forecast.ts` and `lib/weather/demand.ts`. Pull out the bucket-lift computation pattern — Piece 2 needs the same logic but extracted into a callable.
5. Verify `tracker_data.is_provisional` is filtered by the queries Piece 2 will use (M062 added it; readers should respect it).
6. Confirm sample voucher activity dates — Vero's earliest `daily_metrics.revenue > 0` row should be 2025-11-24 per the architecture's deferral note.

#### A.2 Implementation

Create `lib/forecast/daily.ts` exporting:

```typescript
export type DailyForecast = {
  predicted_revenue: number
  baseline_revenue:  number
  components: {
    weekday_baseline:      number
    yoy_same_month_anchor: number | null
    weather_lift_pct:      number
    weather_change_pct:    number
    holiday_lift_pct:      number
    klamdag_pct:           number
    school_holiday_pct:    number
    salary_cycle_pct:      number
    this_week_scaler:      number
  }
  confidence:        'high' | 'medium' | 'low'
  inputs_snapshot:   ConsolidatedV1Snapshot
  model_version:     string         // 'consolidated_v1.0.0' initially
  snapshot_version:  'consolidated_v1'
}

export async function dailyForecast(
  businessId: string,
  date:       Date,
  options?: {
    skipLogging?:         boolean
    overrideModelVersion?: string
    asOfDate?:            Date     // for backtest / honest backfill
    backfillMode?:        boolean  // bypasses Piece 1's backtest write guard
    db?:                  any      // optional admin client; otherwise creates one
  }
): Promise<DailyForecast>
```

Implementation order (matches §3 step 5):

1. **Load inputs in parallel** scoped by `asOfDate` if provided:
   - `daily_metrics`: last 12 weeks of same weekday for baseline + last 7 days for this-week scaler. Filter contaminated days via `anomaly_alerts.confirmation_status = 'confirmed' AND alert_type IN ('revenue_drop','revenue_spike')`.
   - `monthly_metrics`: same month last year (for YoY anchor) + last 12 months (for trailing-12 growth multiplier). Filter `is_provisional = false` (or join through `tracker_data` if `monthly_metrics` doesn't carry it).
   - `weather_daily`: this date's forecast, prior years' same calendar week for change-vs-seasonal.
   - Holidays: `getHolidaysForCountry(businesses.country, year)` for current + adjacent years.
   - `school_holidays` (M056 DDL exists; lookups will work once Piece 3 populates them — for now, return empty and default to 1.0).
   - Business row: name, country, kommun, business_stage.
   - `forecast_calibration` for prior accuracy/bias (consumed by future LLM in Piece 4; in Piece 2 just read for context).

2. **Compute weekday baseline** via `weightedAvg(values, dates, today, { recentWindowDays: 28, recencyMultiplier: 2.0 })` from `lib/forecast/recency.ts`. Skip contaminated days.

3. **YoY anchor** — if `monthly_metrics` for same-month-last-year exists with revenue > 0, compute `trend_factor = (currentMonthActualSoFar / yoySameMonth) × trailing12mGrowth`. Apply to baseline.

4. **Multiplicative adjustments in fixed order**:
   - `weather_lift_factor`: bucket-lift from history (extract logic from `lib/weather/demand.ts`)
   - `weather_change_factor`: this date's weather vs same-calendar-week-prior-year average. Default 1.0.
   - `holiday_lift_factor`: lookup prior years' same holiday revenue ratio. Default 1.0.
   - `klamdag_factor`: prior klämdag observations median. National default 0.90.
   - `school_holiday_factor`: 1.0 for now (Piece 3).
   - `salary_cycle_factor`: revenue ratio by day-of-month phase (mid-month vs around-25th). Default 1.0.
   - `this_week_scaler`: from `lib/forecast/recency.ts` `thisWeekScaler()`.

5. **Round** the final integer.

6. **Confidence** per architecture §3 step 7: 'high' if all signals available AND >180 days history, 'medium' some missing OR 60-180 days, 'low' many missing OR <60 days.

7. **Build `inputs_snapshot`** matching architecture §2's `consolidated_v1` shape EXACTLY. Every multiplier carries `samples_used` and `applied_factor`. Every signal that defaulted to 1.0 carries `available: false` + `reason`.

8. **Capture via Piece 1's helper** (unless `skipLogging`):
   ```typescript
   await captureForecastOutcome({
     org_id, business_id, forecast_date,
     surface:           'consolidated_daily',
     predicted_revenue: result.predicted_revenue,
     baseline_revenue:  result.baseline_revenue,
     model_version:     result.model_version,
     snapshot_version:  'consolidated_v1',
     inputs_snapshot:   result.inputs_snapshot,
     confidence:        result.confidence,
   }, { backfillMode: options?.backfillMode })
   ```

#### A.3 Acceptance

- `lib/forecast/daily.ts` exports `dailyForecast()` matching the signature above
- Returns deterministic results given fixed `asOfDate` (verify: same `(businessId, date, asOfDate)` → same output bytewise)
- `inputs_snapshot` validates against the consolidated_v1 spec — every field present, every signal carries samples_used and reason-when-missing
- Vero call for any 2026-11-25+ date succeeds with `confidence: 'high'`; earlier 2026 dates return `confidence: 'medium'` due to YoY same-weekday absence
- Capture writes to `daily_forecast_outcomes` with `surface='consolidated_daily'` (verify by SQL after one call)
- Performance: cold call <1s. Warm (with daily_metrics already cached by next-data-fetch wrapper) <300ms.

---

### Stream B — `/api/forecast/daily` endpoint (Day 2, ~2 hours)

#### B.1 Implementation

Create `app/api/forecast/daily/route.ts`:

- POST `{ business_id, date }` (date as YYYY-MM-DD)
- Auth via `getRequestAuth(req)`; verify business is in caller's org
- Calls `dailyForecast(business_id, new Date(date))`
- Returns the full `DailyForecast` object
- `runtime: nodejs`, `dynamic: force-dynamic`, `maxDuration: 30`
- Cache header: `Cache-Control: no-store`

Mirror the structure of `/api/scheduling/ai-suggestion/route.ts` for auth + biz verification. The function call is the only meaningful work.

#### B.2 Acceptance

- POST with valid auth + business ownership returns `200` with the forecast JSON
- POST with wrong business_id returns `403`
- POST without auth returns `401`
- Calling the endpoint also writes to `daily_forecast_outcomes` (Piece 1 capture inside the function)

---

### Stream C — Sample-size guardrails + fallback chain (Day 2-3, ~4 hours)

This is the "doesn't crash on new customers with no history" surface area.

Per architecture §3 sample-size guardrails table, every signal has a min-samples threshold and a fallback. Implementation:

- Each signal computer returns `{ value, samplesUsed, available: boolean, reason?: string }`
- If `samplesUsed < threshold`, set `available: false`, `reason` describes why, fallback to neutral value
- The factor goes into `inputs_snapshot[signal].applied_factor`
- Confidence drops one level for each unavailable signal (but capped — 'low' is the floor)

#### C.1 Acceptance

- A brand-new business with 0 history calls `dailyForecast()` without throwing
- All signals report `available: false` with explicit reasons
- `predicted_revenue` falls back to weekday-baseline if available, else 0 (with confidence: 'low')
- A Vero call for 2026-04-01 produces `weather_lift` available, `klamdag_factor` available with prior data, `school_holiday_factor` available: false reason: 'pending_piece_3'
- Tested by changing `asOfDate` to early 2025 and verifying outputs

---

### Stream D — Vero 145-day backfill script (Day 3, ~3 hours)

Architecture §5 specifies a one-time backfill walking Vero's 145 days through `dailyForecast({ skipLogging: true, asOfDate, backfillMode: true })` to populate the audit ledger with retrospective forecasts.

Build `scripts/backfill-vero-consolidated-forecasts.ts`:

- Iterate dates from 2025-11-24 to yesterday
- For each date:
  - `actual = await getActual(veroBusinessId, date)` — query daily_metrics
  - if no actual or actual === 0: skip
  - `forecast = await dailyForecast(veroBusinessId, date, { skipLogging: true, asOfDate: subDays(date, 1), backfillMode: true })`
  - Add `data_quality_flags.push('backfilled_observed_as_forecast')` (per architecture §5 Decision J — weather is observed-not-forecast for backfill)
  - Direct INSERT into `daily_forecast_outcomes` with `actual_revenue`, `error_pct`, `resolution_status='resolved'`, `resolved_at=NOW()` so reconciler doesn't re-process
- Run script via `npx -y dotenv-cli -e .env.production.local -- npx tsx scripts/backfill-vero-consolidated-forecasts.ts` (or admin endpoint wrapper)

#### D.1 Acceptance

- After running: ~120-145 new rows in `daily_forecast_outcomes` with `surface='consolidated_daily'`, `resolution_status='resolved'`
- Each row carries `data_quality_flags: ['backfilled_observed_as_forecast']`
- MAPE-by-horizon analysis can pull these (will be biased optimistically due to weather leakage; documented)

---

### Stream E — Per-business feature flag (Day 4, ~2 hours)

Per architecture §11 + Piece 0's flag wrapper:

- New flag: `PREDICTION_V2_FORECAST_API` (gates the new endpoint on a per-business basis)
- Use `lib/featureFlags/prediction-v2.ts` already shipped in Piece 0
- The endpoint at `/api/forecast/daily` checks the flag; returns 403 + `flag_disabled` if off

This is the safety net — even though the function is callable from anywhere, the public endpoint is gated. New callers (Piece 4 onwards) check the flag before consuming.

#### E.1 Acceptance

- Vero with flag off: endpoint returns 403
- Vero with flag on: endpoint returns the forecast
- Flag flip via admin UI works

---

### Stream F — Phase A capture-only verification (Day 5-6, ~4 hours)

Once A-E are done, Phase A starts: the function exists, captures, but no consumer is using it for production decisions yet.

For 1-2 weeks, the daily reconciler grades all three surfaces side-by-side:
- `consolidated_daily` (new)
- `scheduling_ai_revenue` (legacy, unchanged)
- `weather_demand` (legacy, unchanged)

Build a verification SQL view + admin diagnostic tile so MAPE-by-horizon can be compared:

```sql
CREATE OR REPLACE VIEW v_forecast_mape_by_surface AS
SELECT
  business_id,
  surface,
  prediction_horizon_days,
  COUNT(*) AS resolved_rows,
  AVG(ABS(error_pct)) AS mape,
  STDDEV(error_pct) AS error_stddev
FROM daily_forecast_outcomes
WHERE resolution_status = 'resolved'
  AND prediction_horizon_days BETWEEN 0 AND 14
GROUP BY business_id, surface, prediction_horizon_days
ORDER BY business_id, surface, prediction_horizon_days;
```

Plus an admin tile on `/admin/v2/tools` (or new `/admin/v2/forecast-accuracy` page) rendering this for quick comparison.

#### F.1 Acceptance

- View exists and returns rows after Vero backfill + a few days of capture
- Admin tile renders 3 columns (one per surface) with horizon × MAPE matrix
- Decision criteria for Phase B documented: "consolidated_daily ships when MAPE-by-horizon is within 2pp of the better of the two legacy surfaces, AND no horizon shows >20% MAPE divergence"

---

## What NOT to do in Piece 2

- DO NOT replace either legacy forecaster. Both keep running. Phase B (one consumer at a time) is post-Piece-2.
- DO NOT add LLM logic. That's Piece 4. Build deterministic-only.
- DO NOT add new signals beyond the architecture's 9. School holidays + klämdag accuracy are Piece 3.
- DO NOT touch `lib/forecast/recency.ts`. Use it as-is.
- DO NOT modify Piece 1's audit ledger schema. Capture via the existing helper, with the existing surface tag.
- DO NOT skip the per-business flag. Even if it feels overkill for one customer, the flag is what enables Phase B safe rollout.

---

## What to flag and pause for

If any of the following turns up during investigation, **stop and report:**

1. `daily_forecast_outcomes` schema differs from architecture §2 (Piece 1 should have shipped it correctly)
2. `captureForecastOutcome()` doesn't accept `surface='consolidated_daily'` — verify it's in the union type
3. `lib/forecast/recency.ts` interface differs from what the legacy forecasters use — would suggest mid-stream refactor
4. `lib/holidays/index.ts` doesn't expose `getHolidaysForCountry` (architecture assumed it does)
5. Vero's `daily_metrics` row count for revenue > 0 differs from the assumed 145 days — recompute backfill bounds
6. `forecast_calibration.accuracy_pct` is null for Vero — would indicate Piece 0's reconciler patch didn't fire (unlikely after a month, but possible)

---

## Acceptance gates (overall)

Piece 2 is complete when:

- [ ] `lib/forecast/daily.ts` exports `dailyForecast()` matching the signature in Stream A
- [ ] `inputs_snapshot consolidated_v1` validates against architecture §2's spec for ALL fields
- [ ] `/api/forecast/daily` endpoint returns valid `DailyForecast` JSON for an authorised caller
- [ ] Per-business flag `PREDICTION_V2_FORECAST_API` gates the endpoint
- [ ] `scripts/backfill-vero-consolidated-forecasts.ts` runs cleanly, populates ~120-145 rows
- [ ] `v_forecast_mape_by_surface` view exists, admin tile renders three-column comparison
- [ ] After 1-2 weeks of Phase A: write `PIECE-2-PHASE-A-REPORT.md` with MAPE comparison numbers; if competitive, propose Phase B cutover plan
- [ ] All TypeScript clean (`npx tsc --noEmit` returns zero errors)
- [ ] No customer-visible behaviour change — both legacy forecasters still produce the same outputs they did before

---

## Output

Beyond the code:

1. `PIECE-2-COMPLETION-REPORT.md` summarising what shipped, deviations from spec, MAPE numbers from initial capture
2. A list of follow-ups for Piece 3 (e.g. school_holidays needs population, klamdag_factor needs richer history)
3. Architecture corrections to fold into v3.2 if any spec issues surface during implementation

The completion report is the input to Piece 3's implementation prompt. Don't skip it.
