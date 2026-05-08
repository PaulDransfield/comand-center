# Piece 0 Investigation — Halt Report

> Generated 2026-05-08 by Claude Code during Piece 0 investigation pass.
> Per `PIECE-0-IMPLEMENTATION-PROMPT.md` "What to flag and pause for", halting before implementation because three material contradictions with the spec were found.
> No code changes made. No migrations applied. No commits.

---

## What I confirmed (8 of 11 spec assertions hold)

| Stream | Assertion | Status |
|---|---|---|
| A | `sql/M015-weather-daily.sql` exists | ✓ |
| A | `app/api/admin/weather/backfill/route.ts` exists, uses `firstRev?.date` as default lower bound | ✓ |
| A | Default behaviour can be preserved while adding optional `start_date` query param | ✓ |
| B | `vercel.json` has `forecast-calibration` cron entry (line 24) | ✓ |
| B | `lib/ai/contextBuilder.ts:483-485` reads `forecast_calibration.accuracy_pct, bias_factor, calibrated_at` for the /api/ask context | ✓ |
| C | `archive/migrations/M047-FORTNOX-GUARDRAILS.sql:110` adds `tracker_data.created_via` | ✓ |
| D | `app/api/alerts/route.ts` PATCH handler at line 36-58 supports `dismiss` and `mark_read` actions, org-scoped via `auth.orgId`, no `notes` field | ✓ |
| D | `app/alerts/page.tsx:125-136` — action button row layout exactly as the spec describes | ✓ |
| D | `lib/alerts/detector.ts:9-20` Alert interface lists exactly the columns the spec claims (`org_id, business_id, alert_type, severity, title, description, metric_value, expected_value, deviation_pct, period_date`) plus the `is_read`/`is_dismissed` toggles via the route | ✓ |
| D | `alert_type` values produced by the detector: `revenue_drop`, `food_cost_spike`, `staff_cost_spike`, `ob_supplement_spike` (and likely more — incomplete read) | ✓ |
| D | NO `metric` column on `anomaly_alerts`; NO writes to one anywhere in detector.ts. Reconciler in Piece 1 must use `alert_type IN (...)`, NOT `metric =` (matches v2 review's must-fix #1) | ✓ |

---

## What I found that contradicts the spec

### Contradiction 1 — `accuracy_pct` / `bias_factor` writer (BLOCKING)

**Spec says** (`PIECE-0-IMPLEMENTATION-PROMPT.md:56-57`):

> "Confirm `accuracy_pct` and `bias_factor` are written by `app/api/cron/ai-accuracy-reconciler/route.ts` (M020 reconciler) — they should keep working after this cron is disabled."

And in the deprecation comment template (line 66):

> "accuracy_pct and bias_factor are written by ai-accuracy-reconciler instead."

**Codebase reality:**
- `app/api/cron/ai-accuracy-reconciler/route.ts:104-117` writes only to `ai_forecast_outcomes` columns (`actual_revenue`, `actual_staff_cost`, `actual_food_cost`, `actual_other_cost`, `actual_net_profit`, `actual_margin_pct`, `actuals_resolved_at`, `revenue_error_pct`, `revenue_direction`, `staff_cost_error_pct`, `margin_error_pp`, `updated_at`).
- It does NOT write to `forecast_calibration` at all. Verified via `Grep('accuracy_pct|bias_factor', path=app/api/cron/ai-accuracy-reconciler/route.ts)` — zero matches.
- The ONLY writer to `forecast_calibration.accuracy_pct` and `bias_factor` is `app/api/cron/forecast-calibration/route.ts` itself.

**Implication if we proceed as written:**
- Disabling the `forecast-calibration` cron freezes both columns indefinitely.
- `lib/ai/contextBuilder.ts:483-485` continues reading the stale values forever — it's the AI ASSIST context builder, so /api/ask responses will quote frozen accuracy claims to the owner.
- The architecture review v2 (`ARCHITECTURE-REVIEW-V2-2026-05-08.md:352`) made the same untested assumption and signed it off as "should be safe."
- This is the same class of error v1 and v2 reviews caught (`status='confirmed'`, `metric='revenue'`): a structurally important data flow assumed to exist, isn't actually wired.

**Decision needed:** one of —
- (a) **Patch the cron in place.** Keep `forecast-calibration` running; just add a sample-size guardrail to fix the Vero Sun=0.009 bug. ~30 min of work. Defers the deprecation to Piece 1+ when there's a real replacement.
- (b) **Move the writes.** Add `accuracy_pct`/`bias_factor` UPSERT to `ai-accuracy-reconciler`. ~1-2h. Clean cutover.
- (c) **Accept the freeze.** Disable the cron, add a TODO at the contextBuilder reader, plan to remove the reader in a later piece. Stale-but-honest values.

I'd pick (b) — the M020 reconciler already aggregates the same actuals it would need to compute these, and one place writing the accuracy data is cleaner than two. But the spec doesn't say which way to go.

### Contradiction 2 — `feature_flags` is per-org, not per-business (BLOCKING for D.4 + F.2)

**Spec says** (`PIECE-0-IMPLEMENTATION-PROMPT.md:289-291`):

> "Read from per-business config table; default false. Use the same backing storage as is-agent-enabled.ts."

And the `isPredictionV2FlagEnabled(businessId, flag)` signature is parameterised on `businessId`.

**Codebase reality** (`sql/M012-orphan-tables.sql:48-59`):

```sql
CREATE TABLE IF NOT EXISTS public.feature_flags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,        -- ← per-org, not per-business
  flag       text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,  -- ← default ON, not OFF
  notes      text,
  set_by     text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, flag)
);
```

And `lib/ai/is-agent-enabled.ts:8-23` queries by `org_id`, defaults to ENABLED on no-row, fails open on error.

**Implication if we proceed as written:** there is no "per-business" backing storage. Building `isPredictionV2FlagEnabled(businessId, …)` against this table requires either —
- (a) **Migrate `feature_flags`** to add `business_id` + change unique constraint to `(org_id, business_id, flag)` — schema change with possible downstream impact (need to check every other reader; `is-agent-enabled.ts` would need to handle nullable `business_id`).
- (b) **New table** `business_feature_flags` purpose-built per-business. Cleaner separation.
- (c) **Scope to org for now.** Vero org has TWO businesses (Vero Italiano + Rosali Deli). An org-scoped flag flips both at once. The PIECE-0 spec wants per-business so the flip can be Vero-Italiano-only — the use case is real.

This is a non-trivial design decision the spec treats as already settled.

### Contradiction 3 — `business_cluster_columns` migration target ambiguity (NON-BLOCKING but flag)

**Spec says** (`PIECE-0-IMPLEMENTATION-PROMPT.md:222-225`):

> "For Vero specifically, populate manually:
> `UPDATE businesses SET cuisine = 'italian', location_segment = 'city_center', size_segment = 'medium', kommun = '0180' WHERE id = '<vero_business_id>';`"

**Codebase reality:** the org `e917d4b8-635e-4be6-8af0-afc48c3c7450` (Vero) has TWO businesses:
- `0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99` — Vero Italiano
- `97187ef3-b816-4c41-9230-7551430784a7` — Rosali Deli

These are not the same restaurant; cuisine differs (Italian vs Deli). The spec implies one row but the reality is two.

**Decision needed:** confirm the manual population is per business with different values, or pick one as the "primary" Vero. Trivial to fix in the prompt — flagging because the spec implies a single row.

### Contradiction 4 — Migrations folder path (cosmetic but flagged)

**Spec says** (`PIECE-0-IMPLEMENTATION-PROMPT.md:106, 211, 228, 245`):

> "Create `migrations/MXXX_anomaly_confirmation_workflow.sql`"
> "Create the following migrations" — listed as `migrations/MXXX_*.sql`

**Codebase reality:** there is NO `migrations/` folder. Migrations live in `sql/` with hyphenated names: `sql/M015-weather-daily.sql`, `sql/M048-VERIFICATION-TABLES.sql`, etc. The `archive/migrations/` folder exists but per `feedback_archive_migrations_not_authoritative.md` is NOT trusted for prod schema.

This is cosmetic and v2 review flagged it. Easy fix: change every `migrations/MXXX_*` reference to `sql/MXXX-*` and decide the next free number (M052 is currently free per `ls sql/`).

---

## What I deferred

- **Live prod schema verification of `anomaly_alerts`** — I confirmed columns indirectly via the detector's TypeScript interface and the existing PATCH route. I did NOT query Supabase directly to verify. The Alert interface in `lib/alerts/detector.ts:9-20` is the closest authority I could find; the v2 architecture review claims it covers all the columns the spec lists. A direct Supabase `\d anomaly_alerts` would close this loop in 5 seconds — recommend doing it before Piece 0 implementation actually runs the migration.
- **OB-supplement detector pattern (Stream D.5)** — I read enough of `lib/alerts/detector.ts` to confirm the OB detector exists at line 378+ but didn't read the full step-change logic. The spec asks for an enhancement but doesn't specify the comparison window. Will need a closer read when D.5 actually starts.
- **Stream E (Vero triage runbook)** — pure docs, deferred until the implementation is unblocked. No investigation needed.

---

## Recommended next step

**One round of architecture-doc patches before Piece 0 implementation starts.** Specifically:

| Patch | Section | Effort |
|---|---|---|
| Pick (a/b/c) for the `accuracy_pct`/`bias_factor` issue | Stream B + arch §5 | 30-min decision |
| Pick (a/b/c) for the per-business flag issue | Stream F + arch §F.2 | 30-min decision |
| Confirm whether Vero Italiano and/or Rosali Deli get manual cluster columns and with what values | Stream F.1 | trivial |
| Replace all `migrations/MXXX_*.sql` paths with `sql/MXXX-*.sql` | every migration ref | trivial |

Once those four are decided, Piece 0 implementation can proceed without further halts. The remaining 8 of 11 spec assertions hold. The rest of the streams (A, C, E, most of D) are clean to execute as written.

I have NOT made any code changes. The repo is exactly as it was when I started this investigation.

> "Investigation complete. Halt and report — three material contradictions with the spec require user decisions before implementation can proceed."
