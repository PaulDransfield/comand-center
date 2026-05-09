# Piece 0 Completion Report

> Generated 2026-05-09 by Claude Code at the close of Piece 0 implementation.
> Per `HANDOVER-README.md`, this is the input for writing the Piece 1 implementation prompt.
> The architecture is at `PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md` (with v3.1 decision log appended as Appendix Z).

---

## Status: Complete

Code merged across two commits:
- `0805486` — part 1 (weather backfill, calibration migration, 6 DDL migrations)
- `451d038` — part 2 (anomaly-confirm workflow, OB step-change detector, flag wrapper, runbook)

Plus an interim halt-and-report at `PIECE-0-INVESTIGATION-HALT-2026-05-08.md` that surfaced 4 contradictions between v3 and the codebase. All resolved before implementation; documented in v3 Appendix Z.

Operator actions completed by Paul:
- M052-M057 schema applied
- M058 backfill applied (14 pending alerts → 5 after step-change continuations were auto-resolved)
- `PREDICTION_V2_ANOMALY_CONFIRM_UI` flag flipped for Vero Italiano (and Rosali Deli)
- Vero anomaly triage call run; all remaining alerts decided

---

## What shipped

### Schema (8 migrations, all applied)
- M052 — backfill `tracker_data.created_via` for pre-M047 rows
- M053 — anomaly_alerts confirmation workflow columns + partial index
- M054 — businesses cluster columns (cuisine / location_segment / size_segment / kommun) + Vero pre-population
- M055 — business_cluster_membership join table
- M056 — school_holidays table (DDL only; scraper deferred to Piece 3 batch 2)
- M057 — business_feature_flags (per-business flags, defaults OFF, RLS service-role-write + member-read)
- M058 — Vero OB-supplement step-change auto-resolve backfill

### Code
- `app/api/admin/weather/backfill/route.ts` — accepts `start_date` query param for ≥3yr history
- `app/api/cron/ai-accuracy-reconciler/route.ts` — also writes `forecast_calibration.accuracy_pct`/`bias_factor`
- `app/api/cron/forecast-calibration/route.ts` — deprecation header (route preserved in tree)
- `vercel.json` — `forecast-calibration` cron removed; daily crons restaggered 04:00-09:00 UTC (separate commit `953208d` after Supabase resource warning)
- `app/api/alerts/route.ts` — PATCH handler accepts `confirm` + `reject` actions; GET accepts `?confirmation_status=` filter
- `app/api/feature-flags/prediction-v2/route.ts` — new GET endpoint for client-side flag lookup
- `app/alerts/page.tsx` — Confirm + Reject buttons + status badges + filter dropdown + notes modal (gated)
- `lib/alerts/detector.ts` — step-change auto-resolution (14-day continuation window)
- `lib/featureFlags/prediction-v2.ts` — per-business flag wrapper, defaults closed
- `docs/operations/vero-anomaly-triage-runbook.md` — operator runbook
- `locales/{en-GB,sv,nb}/alerts.json` — i18n keys for the new UI surface

### Operator-visible (silent improvements per architecture Section 11)
- DemandOutlook day cards on `/dashboard` shifted from all-weather averages to weather-bucket-correct values once Paul ran the weather backfill
- OB-supplement detector stopped firing daily duplicates (the auto-resolve patch + M058 backfill cleaned up the 13 dupes)
- `/alerts` page renders Confirm/Reject buttons + status badges + filter dropdown for businesses with `PREDICTION_V2_ANOMALY_CONFIRM_UI = true`

---

## Deviations from spec

| # | What spec said | What we did | Why |
|---|---|---|---|
| 1 | Disable forecast-calibration cron; rely on M020 reconciler to write `accuracy_pct`/`bias_factor` | Patched M020 reconciler to ALSO write those columns BEFORE disabling the legacy cron | Investigation found the M020 reconciler did NOT write those columns. Without the patch, disabling would have frozen `lib/ai/contextBuilder.ts:483-485` reader. v3.1 Decision 1. |
| 2 | Use `feature_flags` table backing storage (per-business override of `is-agent-enabled.ts` pattern) | Built new `business_feature_flags` table parallel to existing `feature_flags`. Defaults OFF. | Investigation found existing `feature_flags` is keyed `(org_id, flag)` and defaults ENABLED. Per-business with default OFF is the inverse semantic; new table avoided retrofit risk on every existing reader. v3.1 Decision 2. |
| 3 | Single Vero business gets cluster pre-populate | Both Vero businesses populated with distinct values (Italian vs Deli) | Vero org has TWO businesses; spec implied one. v3.1 Decision 3. |
| 4 | Migrations under `migrations/MXXX_*.sql` | Used `sql/MXXX-*.sql` (existing convention) | Folder doesn't exist; sql/ is canonical. v3.1 Decision 4. |
| 5 | Step-change detection via 14-day vs older-14-day window math | Used "any prior fire of same (business, alert_type) within 14d → auto_resolve" | Simpler, doesn't need additional window queries, behaves identically in the cases that matter. The math-window approach is still correct for first-time detection; this approach handles continuations. |

None of these are correctness bugs — they're architecture refinements that landed in v3.1 Appendix Z.

---

## Cron schedule changes (separate from prompt scope)

Mid-Piece-0 implementation, Supabase raised a "exhausting multiple resources" warning. Diagnosed as cron stacking: ~8 heavy crons fired in the 05:00-07:00 UTC band, all reading/writing the same tables. Ad-hoc fix in commit `953208d`:

- master-sync moved 05:00 → 04:00
- fortnox-backfill-worker (heaviest) gets its own 06:00 slot
- ai-accuracy-reconciler stays 07:00
- All other daily crons restaggered across 04:00-09:00 UTC with no two crons in the same minute

Tradeoff documented in commit message: this redistributes load but doesn't fix any underlying inefficient query. Diagnostic queries for `pg_stat_activity` + `extraction_jobs` status were given to Paul; not yet run.

This isn't strictly Piece 0 scope but happened during the same window and is captured here so Piece 1 doesn't duplicate the analysis.

---

## What's now true that the architecture should reflect

For Piece 1's implementation prompt, these are the load-bearing facts:

1. **`anomaly_alerts.confirmation_status`** — exists. Values: `'pending' | 'confirmed' | 'rejected' | 'auto_resolved'`. Default `'pending'`. Partial index on `confirmation_status='confirmed'`.

2. **`business_feature_flags`** — exists. Use this for per-business v2 gates. Defaults OFF. Wrapper at `lib/featureFlags/prediction-v2.ts`. Don't reach for `feature_flags` for prediction-system gates — that's the org-scoped legacy table.

3. **`forecast_calibration.accuracy_pct` / `bias_factor`** — written by `app/api/cron/ai-accuracy-reconciler/route.ts` (07:00 UTC daily). The `dow_factors` column is no longer being updated; treat its values as stale.

4. **Detector step-change auto-resolution** — alerts fired within 14 days of a same-(business, alert_type) prior fire are auto-resolved at write time. The reconciler in Piece 1 should treat `auto_resolved` as a no-op for baseline contamination — only `'confirmed'` rows trigger exclusion.

5. **Cron timing** — `ai-accuracy-reconciler` at 07:00 UTC. The new daily reconciler (Piece 1) should NOT also be 07:00 — pick another slot. 07:30 is free; 08:00 is taken by `ai-daily-report`. 09:30 is free.

6. **Vero baseline state** — March 1 anomaly alerts (4 of them) likely got `'rejected'` during triage (operator probably didn't remember details and said "normal variation"). Verify state via the post-call SQL in the runbook before designing the contamination filter.

7. **`weather_daily` table** — populated for both Vero businesses with ~3 years of history. Bucket lift logic in `lib/weather/demand.ts` and `/api/scheduling/ai-suggestion` is no longer degraded.

---

## Open questions / loose ends

These are NOT blockers for Piece 1 but worth knowing:

- **Supabase resource warning root cause** — diagnostic queries (`pg_stat_activity`, `extraction_jobs` status) not yet run. The cron stagger may have been enough; if the warning recurs, those diagnostics are the next step.
- **`forecast_calibration.accuracy_pct` first values** — won't appear until the next 07:00 UTC reconciler run after Piece 0 deploys. Verify on Day 2 that the column is actually being updated.
- **Vero business 2 (Rosali Deli) anomaly UI flag** — confirmed flipped per Paul. If only Vero Italiano was flipped during the call, Rosali Deli's `staff_cost_spike` alert from April 1 stays unresolved.
- **March 1 alerts** — 4 of the 5 pending alerts pre-Piece-0 had period_date 2026-03-01. The operator's decisions on these will be guesses (~10 weeks ago). Piece 1's contamination logic should be careful: the further back the `period_date`, the lower confidence in the operator's `confirmed`/`rejected` decision.
- **`extraction-sweeper` every 2 min** — kept as-is in the cron stagger. If the resource warning recurs, this is suspect #1.

---

## Piece 1 ready-to-write checklist

Before writing the Piece 1 implementation prompt:

- [ ] Read this report
- [ ] Read the v3 architecture's Section 5 (Audit ledger) — that's Piece 1's primary scope
- [ ] Verify Day 2 that `forecast_calibration.accuracy_pct` updated (if no row updated, the M020 reconciler patch didn't fire)
- [ ] Decide: does Piece 1 also include the `daily_forecast_outcomes` row capture in BOTH the legacy forecasters (instrumentation only, no logic change) per architecture's Phase A "shadow mode"? Or just the schema + reconciler, with capture deferred to Piece 2?
- [ ] Confirm the cron slot for the new reconciler (suggest 07:30 UTC daily — between ai-accuracy-reconciler at 07:00 and onboarding-success at 07:30 — wait, onboarding-success is at 07:30. Pick 09:30 or extend to 24h granularity)

---

## Architecture corrections to fold into v3.2 (if next session writes one)

- Section 7 / Stream B: rewrite to "patch reconciler + disable cron" rather than "disable cron and rely on existing writes" (already in Appendix Z, but should be promoted into Section 7 proper for v3.2 readers who skim past appendices).
- Section 7 / Stream F: rewrite to use `business_feature_flags` instead of vaguely "the same backing storage as is-agent-enabled.ts" (likewise — Appendix Z covers it but the body section is misleading).
- Section 9 (Sequencing): the cron stagger (commit `953208d`) reshapes the cron-time landscape. Piece 1+ schedules need to fit into the new layout, not the legacy one. Add a note in Section 9.
- Appendix A (Code paths): add `lib/featureFlags/prediction-v2.ts` and `app/api/feature-flags/prediction-v2/route.ts` to the appendix. They're touched by every gated v2 surface going forward.

---

## Confidence

High. Piece 0 was the riskiest piece by margin (most surface area, customer-visible silent improvements, schema work, an operator triage call). It shipped without breaking anything customer-visible, with two halt-and-reports catching real spec errors before they crashed prod. The pattern of "investigate → halt on conflicts → resolve in arch doc → implement → completion report" worked exactly as the handover README intended.

Piece 1 should be smaller and lower-risk: pure backend (audit ledger schema + reconciler), no UI, no schema retrofitting, no operator interaction. Estimated 2-3 days focused work — most of which is writing the schema + reconciler + capture-instrumentation in the two existing forecasters.

> "Piece 0 complete. Ready for Piece 1 implementation prompt against v3 (and Appendix Z)."
