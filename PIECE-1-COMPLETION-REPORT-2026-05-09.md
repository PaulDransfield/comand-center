# Piece 1 Completion Report

> Generated 2026-05-09 by Claude Code at the close of Piece 1 implementation.
> Per `HANDOVER-README.md`, this is the input for writing the Piece 2 implementation prompt.
> Prompt: `PIECE-1-IMPLEMENTATION-PROMPT.md`. Architecture: `PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md` + Appendix Z.

---

## Status: code complete, awaiting M059 apply

Code merged in a single commit (auto-push at end of session). Operator action required:

- [ ] Apply `sql/M059-DAILY-FORECAST-OUTCOMES.sql` in Supabase SQL Editor (idempotent; should produce `daily_forecast_outcomes_rows = 0`).

Once M059 lands, the next dashboard load + the next 10:00 UTC cron tick complete the loop.

---

## Investigation pass — no halt-and-report

Five spec checks against the live codebase, all passed. (Same discipline that caught real spec errors in Piece 0's halt-and-report.)

| Check | Outcome |
|---|---|
| DDL columns / FKs / `gen_random_uuid()` exist | ✓ (matches M020 + M057 patterns verbatim) |
| `auth.uid()` against `organisation_members.user_id` is the right RLS predicate | ✓ |
| Cron slot 10:00 UTC is free in the post-stagger schedule | ✓ (catchup-sync at minute-0 is a separate route — Vercel handles concurrent crons fine) |
| Scheduling-AI `suggested[]` shape matches the legacy_v1 snapshot fields | ✓ (carries `weather.bucket`, `bucket_days_seen`, `under_staffed_note`, `est_revenue`) |
| `computeDemandForecast()` `DemandDay[]` shape matches | ✓ (with the `confidence: 'unavailable'` → `null` mapping called out in the prompt) |

No contradictions. Proceeded directly to implementation.

---

## What shipped

### Schema (1 migration, pending apply)

- `sql/M059-DAILY-FORECAST-OUTCOMES.sql` — `daily_forecast_outcomes` table + 5 indexes + RLS read policy + `prune_daily_forecast_outcomes()` retention RPC. DDL copied verbatim from architecture v3 §2; idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP POLICY IF EXISTS` before `CREATE POLICY`). Sanity SELECT at the bottom returns `COUNT(*) = 0`.

### Code (5 files)

- `lib/forecast/audit.ts` — `captureForecastOutcome()` + `captureForecastOutcomes()` helpers. Soft-fails on errors. Backtest write guard (`forecast_date < today` Stockholm-local boundary). Skips invalid date strings + non-positive predictions. Bulk variant runs `Promise.allSettled` so a single-row failure can't poison a 7-day batch. Fully typed (no `// @ts-nocheck`).
- `app/api/scheduling/ai-suggestion/route.ts` — captures `surface='scheduling_ai_revenue'` rows after `suggested[]` is built. Snapshot carries weekday, weather_bucket, this_week_scaler (applied + raw + samples), recency window/multiplier constants, model_target_hours, chosen target_hours, under_staffed_note. Existing response shape untouched.
- `lib/weather/demand.ts` — captures `surface='weather_demand'` rows after `out[]` is built. Snapshot carries weekday, weather_bucket, weather summary, temp_min/max, precip, baseline_revenue, delta_pct, sample_size, recency constants. Holiday days skipped (their pattern is structurally different and the architecture excludes them from baseline contamination). Confidence enum `'unavailable'` mapped to `null` per the M059 CHECK.
- `app/api/cron/daily-forecast-reconciler/route.ts` — new daily cron at 10:00 UTC. Walks pending rows ordered by forecast_date asc, applies the four resolution paths from architecture §5 verbatim. Late-arrival defer up to 7 days. Contamination filter uses Piece-0 `confirmation_status='confirmed' AND alert_type IN ('revenue_drop','revenue_spike')` — NOT the v3-pre-correction `metric='revenue'`. `error_attribution` left null in Piece 1 (Pieces 4-5 own that). Retention sweep at the end. Structured JSON log + JSON response with candidates/resolved/deferred/marked_unresolvable/pruned counts.
- `vercel.json` — added the cron entry at `0 10 * * *` between `supplier-price-creep` (09:30, monthly) and `today-data-sentinel` (14:00).
- `MIGRATIONS.md` — M059 entry under "Pending — apply when ready" with full apply order + companion code list.

### Operator-visible

None. Phase A is shadow mode by design — both forecasters return identical responses to before. The audit ledger fills up silently in the background; the next 10:00 UTC cron tick after deploy starts grading predictions.

---

## Deviations from spec

| # | What spec said | What we did | Why |
|---|---|---|---|
| 1 | Reconciler cron at 07:30 UTC (architecture §5 line 682) | 10:00 UTC | 07:30 is now occupied by `onboarding-success` after the Piece 0 stagger (commit `953208d`). The architecture was written before the stagger; the prompt called this out as a deviation in advance. 10:00 keeps the reconciler well clear of the morning crons (≤09:30) and `today-data-sentinel` (14:00). |
| 2 | Capture sites listed in §5 include `/api/forecast/daily` (new) | Not implemented in Piece 1 | That endpoint is the consolidated forecaster — Piece 2's deliverable. Piece 1 instruments only the two legacy forecasters per the prompt scope. |
| 3 | `error_attribution` JSONB populated on resolve | Left `NULL` | Piece 4-5 own attribution (the LLM consumes it). Documented in the cron file with an inline comment. The column accepts NULL; future migration to populate doesn't need schema change. |

None of these are correctness bugs. (1) was anticipated in the prompt; (2) is scope; (3) is intentional deferral.

---

## Idempotency / soft-fail behaviour verified by code review

- **UPSERT key.** `onConflict: 'business_id,forecast_date,surface'`. The unique constraint name is `unique_forecast_per_day_per_surface`. PostgREST matches by column list, so this works against the non-partial unique constraint declared in M059.
- **first_predicted_at preservation.** The capture row intentionally omits `first_predicted_at` so the column default fires only on INSERT. UPDATE doesn't touch it, so `prediction_horizon_days` (generated from `first_predicted_at::date`) reflects the true initial lead time even after multiple re-captures.
- **Soft-fail boundary.** `captureForecastOutcome()` wraps the whole body in try/catch; on error, it logs `console.warn` and returns void. The two forecasters await the bulk variant but `Promise.allSettled` inside means one bad row can't fail the batch. Even a totally borked DB connection only produces a warning — the parent response is unaffected.
- **Reconciler idempotent re-run.** `WHERE resolution_status = 'pending'` filters out already-resolved rows. Re-firing the cron the same minute is a no-op.

---

## Verification approach (manual, post-apply)

There's no test runner. After Paul applies M059:

1. **Open `/dashboard` once.** Verify N+M new rows appear in `daily_forecast_outcomes` (N from scheduling-AI = days in current/next week with positive est_revenue; M from weather-demand = future non-holiday days with positive predicted_revenue).
2. **Re-open the dashboard 5x quickly.** Verify the row count stays at N+M (UPSERT not INSERT).
3. **Check `inputs_snapshot` JSON.** Should validate against the legacy_v1 spec: contains `snapshot_version`, `weekday`, `weather_bucket`, `recency_weighted: true`, `data_quality_flags: []`.
4. **Manually fire the cron** with `curl -X GET https://comandcenter.se/api/cron/daily-forecast-reconciler -H "Authorization: Bearer $CRON_SECRET"`. Returns JSON with `candidates`, `resolved`, `deferred`, `marked_unresolvable`, `pruned`. Day 1 will likely show all `deferred` (no historical pending rows), or all `resolved` if dashboard fired during testing.
5. **Cross-tenant safety.** SELECT as a non-admin user — RLS should permit only the user's own org rows.

---

## What's now true that the architecture should reflect (for v3.2 if a doc rewrite happens)

For Piece 2's implementation prompt, these are the load-bearing facts:

1. **`daily_forecast_outcomes`** — exists. Surface enum admits `'consolidated_daily' | 'scheduling_ai_revenue' | 'weather_demand' | 'llm_adjusted'`. UNIQUE `(business_id, forecast_date, surface)`. RLS read-only for org members.
2. **`captureForecastOutcomes()` from `lib/forecast/audit.ts`** is the canonical write path. Piece 2's `dailyForecast()` should call it with `surface='consolidated_daily'`, `snapshot_version='consolidated_v1'`, full `inputs_snapshot` per architecture §2. Backtest write guard handled by the helper — pass `backfillMode: true` only inside the one-time backfill script (architecture §5).
3. **Reconciler at 10:00 UTC daily** (`/api/cron/daily-forecast-reconciler`) handles all surfaces uniformly. Piece 2 doesn't need its own reconciler — the existing one resolves consolidated_daily rows the same way it resolves the legacy ones, because the resolution logic is surface-agnostic (just reads daily_metrics).
4. **Anomaly contamination filter** is `alert_type IN ('revenue_drop','revenue_spike') AND confirmation_status = 'confirmed'` per Piece 0's column corrections. Piece 2's `dailyForecast()` should use the same predicate when computing baselines (architecture §3 step 2 already specifies this).
5. **Confidence enum in DB is strict 'high' | 'medium' | 'low'** (or NULL). Forecasters that produce `'unavailable'` must coerce to NULL before logging. Captured here in `lib/weather/demand.ts` instrumentation.
6. **`first_predicted_at` is the lead-time anchor** — never updated on UPSERT. `prediction_horizon_days` reflects the gap between `forecast_date` and the FIRST capture, not the most recent one. This is correct (we want to grade "what did we predict 3 days out?", not "what did we predict 3 hours before midnight?").

---

## Open questions / loose ends

These are NOT blockers for Piece 2 but worth knowing:

- **Vero backfill not run.** Architecture §5 specifies a one-time backfill walking Vero's 145 days through `dailyForecast({ skipLogging: true, asOfDate, backfillMode: true })`. That requires Piece 2's `dailyForecast()` to exist first. Defer to end of Piece 2.
- **`forecast_calibration.accuracy_pct` first values from M020 reconciler.** Piece 0 patched the M020 reconciler to write these columns; the first write happens at 07:00 UTC after Piece 0's deploy. Verify before Piece 2 starts that the column is non-null for Vero.
- **Holiday handling.** Weather-demand capture skips holiday days (matches the architecture's intent). Scheduling-AI capture does NOT (the route doesn't expose `is_holiday` in its response). Could re-derive via `getUpcomingHolidays()` but defer — holidays are rare and Piece 2's consolidated forecaster is the right place to centralise holiday treatment.
- **Backfill weather data leakage caveat.** Architecture §5 Decision J flags that backfilled rows carry `data_quality_flags: ['backfilled_observed_as_forecast']` — Piece 2's backfill script is where this materialises. Piece 1 hasn't backfilled anything; current capture is forward-only.
- **error_attribution remains TODO.** The DB column exists and is nullable. Pieces 4-5 (LLM adjustment + pattern extraction) populate it. Until then, MAPE-by-horizon analysis works fine without it.

---

## Architecture corrections to fold into v3.2 (if next session writes one)

- Section 5 / Reconciler cron timing: rewrite "07:30 UTC" → "10:00 UTC" to reflect the post-Piece-0 stagger reality.
- Section 5 / Capture sites table: note that `/api/forecast/daily` is Piece 2's deliverable; Piece 1 instruments only the two legacy forecasters in shadow mode.
- Section 2 / Confidence enum: clarify that callers producing `'unavailable'` (currently only `lib/weather/demand.ts`) must coerce to NULL before logging.
- Appendix A (Code paths): add `lib/forecast/audit.ts`, `app/api/cron/daily-forecast-reconciler/route.ts`, `sql/M059-DAILY-FORECAST-OUTCOMES.sql`. These become foundational refs for every future capture site.

---

## Confidence

High. Piece 1 was the smallest, lowest-risk piece on the roadmap (pure backend, no UI, no schema retrofitting, no operator interaction). Investigation found no contradictions; implementation tracked the prompt verbatim with one anticipated cron-slot deviation. TypeScript clean across the project (`npx tsc --noEmit` returned zero output).

Piece 2 is the biggest piece by far — the consolidated forecaster (`lib/forecast/daily.ts`), `/api/forecast/daily` endpoint, full `inputs_snapshot consolidated_v1` build-out, all 8 multiplicative components from architecture §3, sample-size guardrails, the Vero 145-day backfill script. Estimate: 4-6 days focused work. The audit ledger built in Piece 1 is what makes Piece 2 measurable — without it, the consolidated forecaster would ship blind.

> "Piece 1 complete. Awaiting M059 apply, then ready for Piece 2 implementation prompt against v3 (and Appendix Z)."
