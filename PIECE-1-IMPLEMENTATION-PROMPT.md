# Piece 1 Implementation Prompt — Audit Ledger

> The second implementation piece of the Prediction System architecture (`PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md`).
> Written 2026-05-09 against architecture v3 + Appendix Z + the Piece 0 completion report (`PIECE-0-COMPLETION-REPORT-2026-05-09.md`).
> Time budget: 1-2 days of focused work.
> Output: working code merged. Phase A "shadow mode" — both legacy forecasters log to the audit ledger but their behaviour is unchanged. No flag flips. No customer-visible change.

---

## Context — read this before doing anything

This piece builds the **measurement infrastructure** for the prediction system. After it ships, every prediction the dashboard chart and DemandOutlook day cards make is logged to a new `daily_forecast_outcomes` table with the inputs used. A daily reconciler at 10:00 UTC pairs each prediction against the actual revenue once `daily_metrics` resolves it. From day 1, you start accumulating reconciliation data — without changing what the user sees on screen.

This is the **single most load-bearing piece** for the rest of the architecture. Every later piece (consolidated forecaster, new signals, LLM adjustment, pattern extraction) depends on the audit ledger being honest, idempotent, and complete. **Get it right.**

Three things to internalize:

1. **Phase A = shadow mode = no behaviour change.** Both legacy forecasters keep doing exactly what they do today. The only addition is a `captureForecastOutcome()` call after each generates its prediction. If a customer notices anything different, that's a bug.

2. **Investigation before implementation.** Same discipline as Piece 0 — Piece 0's halt-and-report caught fabricated columns that would have crashed the system. Before writing migration SQL or touching either forecaster, verify the exact columns, table names, and prop shapes the architecture references. If you find a discrepancy, **flag it and stop**.

3. **Idempotency is the contract.** The unique key `(business_id, forecast_date, surface)` plus `ON CONFLICT DO UPDATE` semantics is what stops the dashboard reloading 16 times per minute from polluting the table. Writes are batched at most one row per (business, date, surface) per day. Test this before you ship — re-fire the dashboard mount 5 times, verify exactly one row exists per (business, date, surface).

---

## Pre-flight: facts confirmed in Piece 0 completion report

Before reading the work streams, internalise these (from `PIECE-0-COMPLETION-REPORT-2026-05-09.md` §"What's now true that the architecture should reflect"):

1. **`anomaly_alerts.confirmation_status`** exists with values `'pending' | 'confirmed' | 'rejected' | 'auto_resolved'`. Default `'pending'`. Partial index on `'confirmed'` rows. The reconciler's contamination filter uses `confirmation_status = 'confirmed' AND alert_type IN ('revenue_drop', 'revenue_spike')` — NOT the architecture's earlier `metric = 'revenue'` (column doesn't exist).
2. **`forecast_calibration.accuracy_pct` / `bias_factor`** are written by `app/api/cron/ai-accuracy-reconciler/route.ts` (07:00 UTC). The legacy `forecast-calibration` cron is removed from `vercel.json`. Consumers (`lib/ai/contextBuilder.ts:483-485`) keep working.
3. **Cron schedule changed during Piece 0** (commit `953208d`). The architecture's "07:30 UTC" slot for the new reconciler is **occupied** by `onboarding-success` after the stagger. **Pick 10:00 UTC** instead — clean slot between morning crons (≤09:30) and `today-data-sentinel` (14:00).
4. **Migration paths use `sql/MXXX-*.sql`** (not `migrations/MXXX_*.sql`). Next free number is **M059**.
5. **`weather_daily` is now populated** (~3 years of history) for both Vero businesses after the Stream A weather backfill. Bucket lift logic in both forecasters works. Their `inputs_snapshot` should reflect the actual lift values used.

If any of the above turns out to be wrong when you investigate the codebase, **halt and report**.

---

## What to do

This piece has three work streams. Stream A (schema + helper) is foundational and must ship first. Streams B and C (capture instrumentation in the two forecasters) can run in parallel after A. Stream D (reconciler cron) needs A and at least one of B/C.

### Stream A — Schema + capture helper (Day 1, ~2 hours)

#### A.1 Investigation

1. Read `PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md` Section 2 (DDL) end-to-end. The DDL is canonical — copy verbatim into the migration file.
2. Read `sql/M020-AI-FORECAST-OUTCOMES.sql` (in `archive/migrations/` — non-authoritative, but useful for the M020 RLS pattern). Match the RLS / retention RPC patterns exactly. M057's `business_feature_flags` is a good v2 reference for the same pattern applied to a fresh table.
3. Confirm `gen_random_uuid()` is available (it is — `pgcrypto` ext, also used by every other M0** migration).
4. Confirm `auth.uid()` is the right RLS predicate against `organisation_members.user_id` — this matches M057, M053, M020.

#### A.2 Migration

Create `sql/M059-DAILY-FORECAST-OUTCOMES.sql`:

- `CREATE TABLE daily_forecast_outcomes` per architecture §2 DDL verbatim
- All five indexes per the DDL (business+date desc, org+date desc, partial-pending-by-date, surface+business+date, horizon-resolved)
- RLS enabled + read policy via `organisation_members`
- Retention RPC `prune_daily_forecast_outcomes()` exactly mirroring M020's `prune_ai_forecast_outcomes()` — `language sql + volatile + security definer + set search_path = public + grant execute to service_role`
- Sanity-check SELECT at the bottom returning `COUNT(*)` (should be 0)

Idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP POLICY IF EXISTS` before `CREATE POLICY`). Safe to re-run.

#### A.3 Capture helper

Create `lib/forecast/audit.ts`:

```typescript
export interface CaptureForecastOutcome {
  org_id:               string
  business_id:          string
  forecast_date:        string  // YYYY-MM-DD
  surface:              'consolidated_daily' | 'scheduling_ai_revenue' | 'weather_demand' | 'llm_adjusted'
  predicted_revenue:    number
  baseline_revenue?:    number | null
  model_version:        string
  snapshot_version:     'consolidated_v1' | 'legacy_v1'
  inputs_snapshot:      Record<string, unknown>
  llm_reasoning?:       string | null
  confidence?:          'high' | 'medium' | 'low' | null
}

/**
 * Capture a prediction in daily_forecast_outcomes. Idempotent via
 * (business_id, forecast_date, surface) UNIQUE — re-firing on the same
 * (business, date, surface) UPDATEs the row, latest prediction wins.
 *
 * Backtest write guard: refuses if forecast_date < today UNLESS
 * options.backfillMode is true. Prevents dashboard back-test calls
 * from polluting the audit log with negative prediction_horizon_days.
 *
 * Soft-fails on errors — never blocks the parent forecast generation.
 * The forecaster's primary job is to emit a prediction; the audit log
 * is observability, not load-bearing for the response.
 */
export async function captureForecastOutcome(
  db: any,
  outcome: CaptureForecastOutcome,
  options?: { backfillMode?: boolean }
): Promise<void>
```

Implementation notes:

- Use `createAdminClient()` if no `db` is passed (writes need to bypass RLS)
- Validate forecast_date format with regex `/^\d{4}-\d{2}-\d{2}$/`; soft-fail if malformed
- Build the UPSERT using the SQL pattern in §2 "Idempotency" — `ON CONFLICT (business_id, forecast_date, surface) DO UPDATE SET ...` excluding `first_predicted_at`, `prediction_horizon_days`, and resolution columns
- Wrap in try/catch with `console.warn('[forecast-audit] capture failed:', err.message)` — never throw
- Add `--no-emit`-clean TypeScript types (this file is not `// @ts-nocheck`); the rest of the codebase relies on it for type-safety of new audit reads in Pieces 4-5

#### A.4 Acceptance

- M059 applies cleanly in Supabase SQL Editor; sanity SELECT returns `COUNT(*) = 0`
- `lib/forecast/audit.ts` typechecks under `npx tsc --noEmit`
- `captureForecastOutcome()` exists with the signature above; soft-fails on errors; honours backtest write guard

---

### Stream B — Scheduling-AI capture (Day 1, ~1 hour)

#### B.1 Investigation

1. Read `app/api/scheduling/ai-suggestion/route.ts` end-to-end. Already touched in Piece -1 (forecast recency weighting commit `f6029ca`). Knows about `RECENCY` constants, `weightedAvg()`, `thisWeekScaler()`. The response body's `summary.this_week_scaler` etc. are already exposed.
2. Confirm the `suggested[]` array contains entries with `{ date, est_revenue, est_cost, weather, ... }`. The `est_revenue` value is what gets logged to the audit ledger.
3. Confirm there's an authenticated org_id available — `getRequestAuth(req)` should already be wired.

#### B.2 Implementation

After the `suggested[]` array is fully built and BEFORE the response is returned:

1. For each entry in `suggested[]`:
   - If `entry.date < today` → skip (backtest guard)
   - If `entry.est_revenue <= 0` → skip (no useful signal)
   - Build an `inputs_snapshot` of shape `legacy_v1` per architecture §2:
     - `snapshot_version: 'legacy_v1'`
     - `model_version: 'scheduling_ai_v1.0'`
     - `surface: 'scheduling_ai_revenue'`
     - `weekday`, `weather_bucket`, `recency_weighted: true`, `this_week_scaler` (from summary), `bucket_days_seen`, `under_staffed_note`
   - Call `captureForecastOutcome(db, { … })` with the row
2. The captures are sequential `await` (low volume — at most 7-31 days per call) but wrapped so a single failure doesn't break the response: use `Promise.allSettled()` and log warnings only.
3. **Do NOT change any of the existing scheduling logic.** No touching `currentByDate`, no touching the rationale text, no touching the response shape (other consumers — labour scheduling card, dashboard chart — depend on it).

#### B.3 Acceptance

- The endpoint behaves identically to before from the caller's perspective (same response shape, same headers, same status codes)
- After firing the dashboard once, `daily_forecast_outcomes` has rows with `surface='scheduling_ai_revenue'` for each future day in the response
- Re-firing the same dashboard 5 times produces exactly the same number of rows (idempotent UPSERT)
- `inputs_snapshot` JSON validates against the legacy_v1 spec in architecture §2

---

### Stream C — Weather-demand capture (Day 1, ~1 hour)

#### C.1 Investigation

1. Read `lib/weather/demand.ts` end-to-end. Already touched in commit `f6029ca` for recency weighting. Returns `DemandForecast` with `days[]` containing `{ date, weekday, weather, baseline_revenue, predicted_revenue, delta_pct, confidence, sample_size }`.
2. Confirm `org_id` and `business_id` are available in scope — they're passed in via `opts.orgId` / `opts.businessId`.
3. Note that this function is called from `app/api/weather/demand-forecast/route.ts` and from anywhere else that imports it. The capture should happen INSIDE `computeDemandForecast()` so every caller benefits.

#### C.2 Implementation

In `computeDemandForecast()`, AFTER `out: DemandDay[]` is built and BEFORE the return statement:

1. For each `day` in `out`:
   - If `day.date < today` → skip (backtest guard)
   - If `day.predicted_revenue <= 0` → skip
   - Build `inputs_snapshot` of shape `legacy_v1`:
     - `snapshot_version: 'legacy_v1'`
     - `model_version: 'weather_demand_v1.0'`
     - `surface: 'weather_demand'`
     - `weekday`, `weather_bucket: day.weather.bucket`, `is_holiday`, `holiday_name`, `confidence`, `sample_size`, `delta_pct`, `recency_weighted: true`
   - Call `captureForecastOutcome(opts.db, { … })`
2. Same `Promise.allSettled()` pattern — single-day failure can't break the response
3. Map the architecture's `confidence` enum (`'high' | 'medium' | 'low' | null`) — the existing `'unavailable'` value should map to `null`

#### C.3 Acceptance

- `computeDemandForecast()` returns the same shape it did before
- After hitting `/api/weather/demand-forecast`, `daily_forecast_outcomes` has rows with `surface='weather_demand'` for each non-holiday future day with positive prediction
- Idempotent re-fires update existing rows

---

### Stream D — Reconciler cron (Day 2, ~3 hours)

#### D.1 Investigation

1. Read `app/api/cron/ai-accuracy-reconciler/route.ts` — that's the architectural reference for how a daily reconciler should look. The new one mirrors its shape: cron secret check, `withCronLog` wrapper, `db.from(...).select()` for pending rows, per-row resolution, retention pruning, structured log + JSON response.
2. Read architecture §5 "Reconciler cron" — that's the canonical pseudocode. Translate to actual TypeScript matching the M020 reconciler's style.
3. Read `app/api/cron/today-data-sentinel/route.ts` — uses `Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm' })` for the today-boundary. The reconciler should use the same pattern for "is this forecast_date in the past?" checks so the boundary respects the operator's local day, not UTC.

#### D.2 Implementation

Create `app/api/cron/daily-forecast-reconciler/route.ts`:

- Match the M020 reconciler's structure: `noStore()`, `checkCronSecret()`, `withCronLog('daily-forecast-reconciler', …)`, `createAdminClient()`, structured logs
- Pull pending rows via `from('daily_forecast_outcomes').select(...).eq('resolution_status', 'pending').lt('forecast_date', today)`
- Per-row resolution path matches architecture §5 exactly:
  - Look up `daily_metrics.revenue` for `(business_id, forecast_date)`
  - **Late-arrival defer:** if no actual AND `forecast_date >= today - 7 days`, leave as `pending`; reconciler retries tomorrow
  - **Give-up:** if no actual AND `forecast_date < today - 7 days`, mark `unresolvable_no_actual`
  - **Contamination check** (verbatim from architecture §5 with the v3.1 column corrections):
    ```sql
    SELECT 1 FROM anomaly_alerts
    WHERE business_id = $1
      AND period_date = $2
      AND alert_type IN ('revenue_drop', 'revenue_spike')
      AND confirmation_status = 'confirmed'
    ```
    If any row matches → mark `unresolvable_data_quality`
  - **Zero-revenue (closed day):** if actual = 0 → mark `unresolvable_zero_actual`, set `error_pct = NULL`
  - **Normal resolution:** compute `error_pct = (predicted - actual) / actual`, write `actual_revenue`, `error_pct`, `resolved_at`, `resolution_status = 'resolved'`
- Skip `error_attribution` JSONB for this piece — that's Piece 4-5 territory (the LLM uses it). Defer with a TODO comment.
- After the per-row loop, call `db.rpc('prune_daily_forecast_outcomes')` for the 3-year retention sweep.
- Log structured: `route, duration_ms, candidates, resolved, deferred, marked_unresolvable, pruned, status`. Return JSON with same fields.
- `maxDuration = 60`, `runtime = 'nodejs'`, `preferredRegion = 'fra1'`.

#### D.3 vercel.json

Add the cron entry. Pick **10:00 UTC** (`0 10 * * *`) — clean slot in the post-stagger schedule (no conflicts with morning crons that finish by 09:30 or `today-data-sentinel` at 14:00). Architecture proposed 07:30 UTC but that's now occupied by `onboarding-success` per the Piece 0 stagger. The new line goes between the existing `today-data-sentinel` and `catchup-sync` entries.

#### D.4 Acceptance

- Manually fire the endpoint with the cron secret. Should return JSON with the candidates / resolved / deferred / marked_unresolvable counts.
- For Vero, after a few days of capture rows accumulate and `daily_metrics` catches up, the reconciler resolves them with non-null `actual_revenue` and `error_pct`.
- Re-running the cron is a no-op (idempotent — `WHERE resolution_status = 'pending'` filters out already-resolved rows).
- Anomaly contamination filter actually fires when an operator-confirmed alert exists on a forecast_date.

---

## What NOT to do

- Do NOT modify the existing forecasters' core math. Stream B and C only ADD `captureForecastOutcome()` calls after the predictions are computed; they don't change what the predictions ARE.
- Do NOT introduce a `dailyForecast()` consolidated function. That's Piece 2 — explicitly out of scope.
- Do NOT add new signals (yoy, klämdag, etc.). That's Piece 3 — explicitly out of scope.
- Do NOT touch the `forecast_calibration` table or the M020 reconciler. Both are stable post-Piece-0.
- Do NOT add LLM logic. The `llm_reasoning` and `confidence` columns get populated by Piece 4 — Piece 1 captures them as nullable and writes nulls.
- Do NOT add new flags. The whole piece runs unconditionally — Phase A "shadow mode" requires the audit log to capture for everyone, regardless of flags. The Phase B switchover (Piece 2+) is when flags start gating behaviour.
- Do NOT delete `WeatherDemandWidget.tsx` even though it's unused. The architecture's Phase B cutover assumes it's available as a rollback target. Piece 0's completion report flagged it as deletable; defer that to Phase C.
- Do NOT add `error_attribution` computation. That's Piece 4-5 territory (LLM consumes it). Set the column NULL for now.

---

## What to flag and pause for

If during investigation you find any of the following, **stop and report rather than proceeding:**

1. The architecture's DDL references a column or constraint that doesn't exist on `organisations`, `businesses`, `organisation_members`, `auth.users`, or `daily_metrics`. (Same class of error v1 / v2 / Piece 0 reviews caught.)
2. `gen_random_uuid()` errors at migration time. (Means `pgcrypto` ext isn't loaded — would need a `CREATE EXTENSION IF NOT EXISTS pgcrypto` line.)
3. The scheduling-AI endpoint's `suggested[]` array shape is materially different from `{ date, est_revenue, weather: { bucket } }`. (E.g. if recent commits restructured the response.)
4. `computeDemandForecast()`'s `out: DemandDay[]` no longer carries the architecture-assumed fields. (Same shape concern for the weather forecaster.)
5. The contamination filter `confirmation_status = 'confirmed' AND alert_type IN ('revenue_drop', 'revenue_spike')` returns zero rows for any business that has confirmed alerts. (Means the filter is wrong and the reconciler would mis-classify rows.)
6. The 10:00 UTC cron slot is not actually free (someone added a cron between Piece 0 and Piece 1 starting). Pick the next free slot, document.

For each, write up what you found and what the architecture got wrong. Halt and wait for direction. The pattern from Piece 0's two halt-and-reports is the discipline pattern that's saved this build twice.

---

## Style guidance

- Match existing codebase conventions: `// @ts-nocheck` is **not** acceptable on new files (only legacy untouched files keep it). The reconciler cron + audit helper should be fully typed.
- Use the existing helpers: `getRequestAuth`, `createAdminClient`, `checkCronSecret`, `withCronLog`, `log` from `@/lib/log/structured`. Don't invent new patterns.
- Comments explain WHY, not WHAT. The architecture and this prompt explain what; the code should explain why a specific implementation was chosen.
- Every new file gets a header comment linking back to the architecture section it implements (e.g. `// See PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md Section 5 — Capture and reconciliation`).
- Logs use structured JSON via `log.info/warn/error` from `@/lib/log/structured` with `route` field. Don't `console.log` from cron paths — `console.warn` is OK for soft-fail paths in `audit.ts`.

---

## Acceptance gates (overall)

Piece 1 is complete when:

- [ ] `sql/M059-DAILY-FORECAST-OUTCOMES.sql` applied; sanity SELECT returns `COUNT(*) = 0`
- [ ] `lib/forecast/audit.ts` exists, fully typed, soft-fails on errors, honours backtest write guard
- [ ] `/api/scheduling/ai-suggestion` writes `daily_forecast_outcomes` rows with `surface='scheduling_ai_revenue'` after each call (visible in DB after one dashboard load)
- [ ] `lib/weather/demand.ts` writes `daily_forecast_outcomes` rows with `surface='weather_demand'` after each call
- [ ] Re-firing the dashboard 5x produces no duplicate rows (UPSERT verified)
- [ ] Both forecaster endpoints return identical responses to before — no behaviour change
- [ ] `app/api/cron/daily-forecast-reconciler/route.ts` exists; manual GET with cron secret returns the expected JSON
- [ ] `vercel.json` contains the new cron at 10:00 UTC daily; ordered consistent with the rest
- [ ] After 24h of operation, the cron resolves yesterday's rows: `actual_revenue` populated, `error_pct` computed, `resolution_status` flipped to one of `resolved` / `unresolvable_*`
- [ ] Contamination filter correctly marks rows as `unresolvable_data_quality` when an operator-confirmed alert exists for that date
- [ ] `MIGRATIONS.md` entry for M059 documents the schema + cron + capture sites
- [ ] Completion report at `PIECE-1-COMPLETION-REPORT-2026-05-XX.md` summarising what shipped, deviations from spec, and any architecture corrections to fold into v3.2

---

## Testing approach

The codebase has no test runner (per Piece 0 review). Manual verification:

1. **Happy-path capture:** open `/dashboard` once, verify N+M new rows in `daily_forecast_outcomes` (N = days in current week from scheduling-AI, M = days in DemandOutlook from weather-demand)
2. **Idempotent re-capture:** open the same dashboard 5 times in quick succession; verify the count stays at N+M (UPSERT not INSERT)
3. **Backtest guard:** if a code path tries to log for a `forecast_date` in the past, the helper soft-skips. Verify by calling `captureForecastOutcome(db, { forecast_date: '2025-01-01', ... })` directly from a one-off script — should log a warning but write nothing.
4. **Reconciler manual fire:** hit the cron endpoint with the secret. Confirm JSON return value matches expected shape. Re-fire — should return the same `resolved=0` etc. on the second run.
5. **Cross-tenant safety:** RLS policy verified by SELECT-ing as a non-admin user — should only see rows for businesses the user is in `organisation_members` for.

---

## Output

A working Piece 1 implementation merged to `main`:

1. M059 migration SQL applied to prod (via Supabase SQL Editor — Paul's manual step)
2. All code merged: `lib/forecast/audit.ts`, capture instrumentation in both forecasters, reconciler cron, vercel.json entry
3. `MIGRATIONS.md` entry
4. A short markdown report at the repo root: `PIECE-1-COMPLETION-REPORT-2026-05-XX.md` summarising what was done, what wasn't (and why), any open questions surfaced during implementation, and what to fold into v3.2 if a doc rewrite happens.

The completion report is the input to Piece 2's implementation prompt. Don't skip it.
