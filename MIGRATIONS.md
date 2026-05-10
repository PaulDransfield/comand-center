# MIGRATIONS.md — CommandCenter Database Change Log
> Last updated: 2026-05-09 | M022–M047 applied · M048 pending · M052–M058 applied · M059 pending (Piece 1)
> Record every SQL change run in Supabase here. Never edit old entries — add new ones.

---

## Pending — apply when ready

### M064 — Extend integrations.status CHECK constraint ⏳ pending application
**File:** `sql/M064-INTEGRATIONS-STATUS-CONSTRAINT.sql`
**Purpose:** same pattern as M061 (paused) and M063 (plan values). The TypeScript union for `integrations.status` includes `disconnected`, `needs_reauth`, `pending` etc. but the DB CHECK constraint only allowed the original handful. The new `/api/integrations/disconnect` endpoint failed on first use with `integrations_status_canonical_chk` violation when setting `status='disconnected'`. Fourth instance of constraint drift in 24h — see `feedback_check_constraint_drift` memory.

### M063 — Extend organisations.plan CHECK constraint ⏳ pending application
**File:** `sql/M063-ORGANISATIONS-PLAN-CONSTRAINT.sql`
**Purpose:** the 2026-04-23 pricing overhaul (`project_pricing_2026_04` memory) added four new plan values — `founding`, `solo`, `group`, `chain` — to `lib/stripe/config.ts`'s PLANS map and to every UI surface, but the DB CHECK constraint still enumerated the old set (trial / starter / pro / enterprise / past_due). Any admin UPDATE setting a new plan value failed with `organisations_plan_check` violation. Drops + re-creates the constraint with all current values. Idempotent.
**Companion code:** none — code already uses the new values; this just unblocks them at the DB level.

### M062 — tracker_data.is_provisional flag ⏳ pending application
**File:** `sql/M062-TRACKER-IS-PROVISIONAL.sql`
**Purpose:** marks tracker_data rows whose books aren't closed yet (current calendar month + prior month before the 15th — the typical Swedish accountant closure window). Without the flag, partial-month data corrupts trend lines and AI prompts: April 2026 showing revenue=85k vs April 2025=625k looks like a 86% revenue collapse when reality is just "books still open."
**Schema:** `is_provisional BOOLEAN NOT NULL DEFAULT FALSE` plus a partial index on `(business_id, period_year, period_month) WHERE is_provisional = TRUE` for cheap inverse-filter queries.
**Backfill at apply time:** the migration UPDATEs any existing rows in the current/prior-month-before-15th period to flag them.
**Companion code:**
- `lib/finance/period-closure.ts` — `isProvisional(year, month, now?)` heuristic. Stockholm-time anchored.
- `app/api/cron/fortnox-backfill-worker/route.ts` — sets the flag on every tracker_data write.
- `lib/sync/aggregate.ts` — filters provisional rows out of the monthly_metrics roll-up so downstream consumers (memo, scheduling AI, dashboards) see only closed P&L.
- `app/api/forecast/route.ts` — same filter on the forecast baseline.
- `app/api/budgets/generate/route.ts` — same filter on YTD trajectory anchor (avoids "this year is collapsing!" hallucinations from the budget AI).
**Not filtered (intentional):** `app/api/tracker/route.ts`, `app/api/budgets/analyse/route.ts`, `app/api/budgets/route.ts` — these surface specific selected periods to the user. If they pick April 2026 explicitly, they want to see what's there.
**Architecture note:** companion to the API-priority strategy (`project_api_priority_strategy` memory). Phase D' — partial-data tagging.

### M061 — Add 'paused' to backfill_status CHECK constraint ⏳ pending application
**File:** `sql/M061-BACKFILL-STATUS-PAUSED.sql`
**Purpose:** companion to M060 — the resumable worker uses a new `backfill_status='paused'` value to signal "state saved, ready to resume". The original M050 CHECK constraint enumerated only `idle/pending/running/completed/failed`, so any UPDATE setting `'paused'` failed with `integrations_backfill_status_chk` violation. This migration drops + re-creates the constraint to include `'paused'`.
**Apply order:** AFTER M060 (M060 doesn't actually use the value at table-definition time, but the resume admin endpoint hits the constraint). Idempotent.

### M060 — Fortnox backfill resumability state ⏳ pending application
**File:** `sql/M060-FORTNOX-BACKFILL-STATE.sql`
**Purpose:** new `fortnox_backfill_state` table — persists work-in-progress so the backfill worker can checkpoint before the Vercel function timeout (600-800s) kills it. Without this, any backfill of >~10 minutes (Vero alone has ~17 minutes of work for 12 months) dies mid-flight with the row stuck at `running`.
**Schema:**
- `integration_id UUID PRIMARY KEY` — one state row per integration
- `voucher_queue JSONB` — full list of voucher summaries with fiscal-year context (built once during Phase 1; ~5KB per summary, 3,800 summaries ≈ 19MB JSONB row for Vero — acceptable, will revisit if needed)
- `cursor INTEGER` — index into voucher_queue of next summary to fetch
- `written_periods JSONB` — array of "YYYY-MM" strings already written to tracker_data
- `from_date / to_date` — range bounds for diagnostics
- `started_at / last_progress_at / resume_count` — telemetry
**Lifecycle:** created when worker enters Phase 1 (fresh start); updated after every period flush; deleted on `completed` or `failed`.
**Companion code:**
- `lib/fortnox/api/vouchers.ts` — split into `fetchVoucherSummariesForRange()` (Phase 0+1) + `fetchVoucherDetailsForSummaries()` (Phase 2 with `deadlineMs` for early exit). `fetchVouchersForRange()` retained as orchestrator for diagnose endpoint.
- `app/api/cron/fortnox-backfill-worker/route.ts` — full rewrite for resumability. Claims `pending` OR `paused`. Loads state row on resume; otherwise fetches summaries. Per-period flush after each period's summaries are exhausted. Time-budget gate at `maxDuration - 60s`; on hit, persists state, sets `backfill_status='paused'`, chains next worker via `waitUntil(triggerNext())`. New `backfill_progress.phase` values: `'listing'`, `'paused'`, `'resuming'`. New `backfill_status` value: `'paused'`.
- `app/api/admin/fortnox/kick-backfill/route.ts` — clears state row before flipping to `pending` (admin "kick" is fresh-start intent).
- `app/admin/v2/tools/page.tsx` — polling continues through `paused` state (only `completed`/`failed` are terminal); 60-min poll ceiling for multi-run chains.
**Apply order:** M060 must apply before the worker code deploys, else `fortnox_backfill_state` references throw 42P01.
**Architecture note:** see `project_api_priority_strategy` memory — this is Phase C of the API-priority strategy (Phase A = validators inherited from PDF apply; Phase B = skip-PDF rule inverted; **Phase C = resumability** unblocks multi-year backfills). Phase D = re-extract Vero's existing PDF months. Phase E = onboarding flow without PDF requirement.

### M059 — Daily forecast outcomes audit ledger (Piece 1) ⏳ pending application
**File:** `sql/M059-DAILY-FORECAST-OUTCOMES.sql`
**Purpose:** new `daily_forecast_outcomes` table — the audit ledger for every revenue prediction the two legacy forecasters (`/api/scheduling/ai-suggestion`, `lib/weather/demand.ts`) emit, plus future surfaces (`consolidated_daily`, `llm_adjusted`). Captured row carries `predicted_revenue`, `inputs_snapshot` (the exact signals the model used), `model_version`, `snapshot_version`, `prediction_horizon_days` (generated column = `forecast_date - first_predicted_at::date`). UNIQUE `(business_id, forecast_date, surface)` makes capture idempotent — re-firing the dashboard 5x produces one row per (business, date, surface) with the latest prediction winning. RLS read policy via `organisation_members` matches M020 / M053 / M057 verbatim. Retention RPC `prune_daily_forecast_outcomes()` mirrors the M020 3-year sweep.
**Companion code (in same commit):**
  - `lib/forecast/audit.ts` — `captureForecastOutcome()` / `captureForecastOutcomes()` helpers with backtest write guard (skips `forecast_date < today` unless `backfillMode: true`) and soft-fail on errors so audit logging never breaks the parent forecast response.
  - `app/api/scheduling/ai-suggestion/route.ts` — Phase A "shadow mode" capture; logs every `suggested[]` entry with `surface='scheduling_ai_revenue'`, `snapshot_version='legacy_v1'` carrying weekday + weather_bucket + this_week_scaler + bucket_days_seen.
  - `lib/weather/demand.ts` — same capture pattern in `computeDemandForecast()`; logs every non-holiday `out[]` entry with `surface='weather_demand'`. Confidence enum `'unavailable'` collapses to `null` per the table's CHECK (high|medium|low).
  - `app/api/cron/daily-forecast-reconciler/route.ts` — daily cron at 10:00 UTC. Walks pending rows, pairs against `daily_metrics.revenue`, applies the four resolution paths (defer < 7d / unresolvable_no_actual ≥ 7d / unresolvable_data_quality on confirmed anomaly / unresolvable_zero_actual on closed days / resolved with `error_pct = (predicted - actual) / actual`). Anomaly contamination filter: `alert_type IN ('revenue_drop','revenue_spike') AND confirmation_status = 'confirmed'`. Calls `prune_daily_forecast_outcomes()` at the end.
  - `vercel.json` — adds `/api/cron/daily-forecast-reconciler` at `0 10 * * *`. Slot picked because the post-Piece-0 stagger occupies 04:00-09:30 and `today-data-sentinel` is at 14:00; 10:00 is clean. Architecture v3 §5 originally proposed 07:30 but that's now `onboarding-success`.
**Apply order:** M059 must apply before the code deploys, else the cron fires and sees an undefined table. Idempotent — safe to re-run.
**Phase A intent:** capture only. No behaviour change to either forecaster's response. Pieces 2-5 build on the ledger to ship the consolidated forecaster + new signals + LLM adjustment.

### M058 — Vero OB-supplement step-change auto-resolve backfill ⏳ pending application
**File:** `sql/M058-VERO-OB-AUTO-RESOLVE-BACKFILL.sql`
**Purpose:** one-shot WHERE-IN-(business_id, alert_type) CLEANUP. After M053 + the detector's step-change patch in `lib/alerts/detector.ts` shipped, Vero's existing 14 pending alerts include multiple duplicates of the same OB-supplement step-change pattern. This SQL keeps the EARLIEST alert per (business_id, alert_type) group as `pending` (so the operator can triage one) and flips the rest to `auto_resolved` with an explanatory note. Idempotent — re-running finds no rows to update.
**Pre-requisite:** M053 must already be applied so `confirmation_status` exists.
**Run after:** M053 applied.
**Companion:** Stream D's detector patch ensures future step-change continuations auto-resolve at write time, so this backfill is a one-time clean-up — not a recurring need.

### M052-M057 — Piece 0 of prediction system v3.1 ⏳ pending application
**Files (in apply order — all idempotent):**
1. `sql/M052-TRACKER-CREATED-VIA-BACKFILL.sql` — UPDATE-only; backfills the ~21 NULL `tracker_data.created_via` rows to `'manual_pre_m047'`. Run this first; it has no schema dependencies.
2. `sql/M053-ANOMALY-CONFIRMATION-WORKFLOW.sql` — adds `confirmation_status`, `confirmed_at`, `confirmed_by`, `confirmation_notes` to `anomaly_alerts` + partial index. Defaults all existing rows to `'pending'`.
3. `sql/M054-BUSINESS-CLUSTER-COLUMNS.sql` — adds `cuisine`, `location_segment`, `size_segment`, `kommun` to `businesses`. UPDATEs both Vero rows with manual values: Vero Italiano = (italian, city_center, medium, 0180); Rosali Deli = (deli, city_center, small, 0180).
4. `sql/M055-BUSINESS-CLUSTER-MEMBERSHIP.sql` — new join table for many-to-many cluster mapping. DDL only; no data.
5. `sql/M056-SCHOOL-HOLIDAYS.sql` — new table for kommun-level school holidays. DDL only; Skolverket scraper lands in Piece 3 batch 2.
6. `sql/M057-BUSINESS-FEATURE-FLAGS.sql` — new per-business flag table parallel to existing `feature_flags`. Defaults `enabled=false`. RLS service-role-only writes, member-read.

**Architecture context:** all six are Piece 0 of the prediction-system rebuild. v3.1 decision log at `PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md` Appendix Z. Companion code already merged in the same commit:
- `app/api/admin/weather/backfill/route.ts` — accepts `start_date` query param for ≥3yr historical fetch
- `app/api/cron/ai-accuracy-reconciler/route.ts` — also writes `forecast_calibration.accuracy_pct`/`bias_factor` (replacing the deprecated calibration cron)
- `vercel.json` — `/api/cron/forecast-calibration` removed
- `app/api/cron/forecast-calibration/route.ts` — deprecation header added; route file kept in tree

**Run order:** safe to run all six in sequence in Supabase SQL Editor. Each is idempotent. After applying, hit `POST /api/admin/weather/backfill?secret=...&start_date=2023-05-01` once to populate ~3 years of `weather_daily` for both Vero businesses.

**What still needs Piece 0 (deferred to next session):**
- Stream D — `/api/alerts` PATCH `confirm`/`reject` actions + `/alerts` page UI buttons + OB step-change detector tuning + Vero anomaly triage call
- Stream F.2 — `lib/featureFlags/prediction-v2.ts` wrapper querying `business_feature_flags`
- Stream E — `docs/operations/vero-anomaly-triage-runbook.md`

### M051 — Overhead drilldown cache table ✅ applied 2026-05-07 (direct SQL)
**File:** `sql/M051-OVERHEAD-DRILLDOWN-CACHE.sql`
**Purpose:** five-minute cache for owner-facing drill-down on overhead-review flag cards. The new endpoint `/api/integrations/fortnox/drilldown` writes payloads here keyed by `(business_id, period_year, period_month, category)` so multiple supplier flags in the same category+month share one Fortnox fetch. Client filters to the requested supplier on render.
**Note:** Paul applied the table directly via Supabase SQL editor on 2026-05-07 before the migration file was written; this file is idempotent (`CREATE TABLE IF NOT EXISTS`) so re-running for documentation/audit-trail purposes is safe. Includes RLS policy for service-role-only access.

### M050 — Fortnox API backfill state columns on `integrations` ⏳ pending application
**File:** `sql/M050-FORTNOX-BACKFILL-COLUMNS.sql`
**Purpose:** state machine for the 12-month Fortnox API backfill triggered after OAuth connect. Adds `backfill_status` (NULL / `idle` / `pending` / `running` / `completed` / `failed`), `backfill_started_at`, `backfill_finished_at`, `backfill_progress JSONB`, `backfill_error TEXT` to `integrations`. CHECK constraint guards the enum. Partial index `idx_integrations_backfill_pending` for cheap "find next pending" claim queries.
**Companion code:**
  - `app/api/cron/fortnox-backfill-worker/route.ts` — drains pending Fortnox integrations: claims atomically, fetches 12 months of vouchers via `lib/fortnox/api/vouchers.ts`, translates via `lib/fortnox/api/voucher-to-aggregator.ts`, projects via `projectRollup`, writes `tracker_data` rows with `source='fortnox_api'` and `created_via='fortnox_backfill'`. Idempotency check skips months that PDF apply has already populated (`source IN ('fortnox_pdf', 'fortnox_apply')`).
  - OAuth callback now sets `backfill_status='pending'` as part of the upsert (instead of the old current-month-only `syncFortnoxInBackground`) and fires the worker via fire-and-forget HTTP POST.
  - Daily cron `/api/cron/fortnox-backfill-worker` at 07:00 UTC as a backstop in case the immediate fire-and-forget didn't reach the worker.
**Order of operations:** apply M050 in Supabase before the matching code deploys, otherwise the OAuth callback's upsert will fail with `42703` (column does not exist) on the new `backfill_*` columns.

### M049 — Non-partial unique index for Fortnox OAuth upsert ⏳ pending application
**File:** `sql/M049-INTEGRATIONS-OAUTH-UPSERT-KEY.sql`
**Purpose:** the OAuth callback upsert at `app/api/integrations/fortnox/route.ts` was failing with `42P10` because every existing unique enforcement on `integrations` is via partial indexes (`WHERE department IS NULL`, `WHERE business_id IS NOT NULL`, expression-based `COALESCE(department, '')`), and PostgREST's `?onConflict=col1,col2` only matches non-partial unique constraints/indexes by column list. Adds a non-partial `UNIQUE (org_id, business_id, provider)` so the upsert (with onConflict updated to that key in the matching code commit) can land. The new index is functionally redundant with the existing `integrations_org_biz_provider_dept_unique` partial for the `business_id IS NOT NULL` case — it just exposes the same constraint to PostgREST in a shape it can use.
**Pre-flight:** the migration runs a `DO $$ ... EXCEPTION` block that aborts with a clear error if any duplicate `(org_id, business_id, provider)` rows exist in `integrations`. Production has zero Fortnox rows so a duplicate is unlikely, but the guard is there in case any pre-existing PK / Caspeco / Onslip data violates the new shape.
**Caveat:** still does not dedupe rows where `business_id IS NULL` (Postgres treats NULL as distinct under standard UNIQUE). Those are covered by the existing `integrations_org_null_biz_provider_unique` partial. New OAuth callbacks always carry a non-null business_id thanks to the page-button guard (`disabled={!selectedBiz}`, commit 66ffb5b), so this gap doesn't affect the OAuth path. Admin concierge tokens that omit business_id can still produce NULL — separate follow-up.
**Companion code:** matching commit changes `onConflict: 'business_id,provider'` to `onConflict: 'org_id,business_id,provider'` in `app/api/integrations/fortnox/route.ts`.
**Order of operations:** apply M049 in Supabase BEFORE Vercel deploys the matching code — otherwise the upsert will continue failing with the new column list. (Or apply concurrently — either order works once both are live.)

### M048 — Fortnox API verification harness mirror tables ⏳ pending application
**File:** `sql/M048-VERIFICATION-TABLES.sql`
**Purpose:** Phase 1 of the Fortnox API backfill plan. Creates `verification_*` mirror tables (cloned from `tracker_data`, `tracker_line_items`, `monthly_metrics`, `daily_metrics`, `dept_metrics`, `revenue_logs`, `financial_logs` via `LIKE INCLUDING ALL`) plus `verification_runs` for run metadata. The harness writes API-derived metrics into the mirrors so they can be diff'd against PDF-derived production data without touching production rows.
**Notes:**
  - Verification harness only. Safe to drop after Phase 1 completes — drop script is at the bottom of the SQL file.
  - The Phase 1 prompt named `vat_breakdown` in the mirror list; that table does NOT exist (VAT split lives as columns on `tracker_data` per M029). Skipped.
  - `tracker_line_items` was not in the prompt's list but was added so material-drift root-causing has line-level data to walk back through.
  - No new application code reads these tables. They are visible only to the verification harness and the report generator.
**Scripts that depend on this:** `scripts/verification-runner.ts`, `scripts/verification-report.ts`. Both will refuse to run until the migration is applied.

---

## Recently applied — for reference

### M047 — Fortnox apply guardrails (sha256 + CHECK + created_via) ✅ applied 2026-05-03
**File:** `M047-FORTNOX-GUARDRAILS.sql` (repo root)
**Purpose:** defence-in-depth for the Fortnox PDF apply pipeline. Three additions:
  - `fortnox_uploads.pdf_sha256 TEXT` + index `(business_id, pdf_sha256) WHERE pdf_sha256 IS NOT NULL`. Computed at upload time; the upload route short-circuits with status='duplicate' on a hit so an accidental re-upload of the same PDF doesn't pile up.
  - CHECK constraints on `tracker_data`: revenue / food_cost / staff_cost / alcohol_cost / other_cost ≥ 0; period_month in [0..12]; period_year in [2000..2099]. Even if the application code skips a validator, the DB rejects impossible values.
  - `tracker_data.created_via TEXT` (nullable) — origin tag. New code paths populate explicitly: `'fortnox_apply'` for the Fortnox pipeline. The new daily cron `/api/cron/manual-tracker-audit` uses an index on `(business_id, created_at DESC) WHERE created_via IS NULL AND fortnox_upload_id IS NULL` to find rogue manual writes (the Rosali March 2026 case).
**Companion code:**
  - `lib/fortnox/validators.ts` — single chokepoint, 10 rule-based checks (org-nr match, period match, scale anomaly, sign convention, math consistency, doc-type vs claimed, period gap, subset caps, etc.).
  - `lib/fortnox/ai-auditor.ts` — Haiku second-opinion call returning {confidence, summary, concerns}; fail-tolerant, never blocks apply.
  - `app/api/fortnox/apply/route.ts` — runs validators + auditor before any tracker_data write. Returns 422 with `validation_blocked` when blocking errors or unacknowledged warnings present. UI passes `acknowledged_warnings: string[]` to proceed past warnings, `force: true` for overridable errors.
  - `app/api/fortnox/upload/route.ts` — SHA-256 fingerprint + duplicate check.
  - `app/api/cron/manual-tracker-audit` — daily 06:45 UTC ops email when suspicious manual rows appear.
**Backwards compat:** all ADD COLUMN are nullable / IF NOT EXISTS; CHECK constraints guarded against re-application; index uses `IF NOT EXISTS`. Wrapped in transaction. Verify queries at the bottom dump the new column + constraint list.
**To apply:** open Supabase SQL Editor, paste file contents, run.

### M046 — Onboarding expansion (opening_days + business_stage) ✅ applied 2026-05-02
**File:** `M046-ONBOARDING-EXPANSION.sql` (repo root)
**Purpose:** Onboarding now collects business address, organisationsnummer, business stage, opening days, and an optional last-year P&L PDF upfront — see app/onboarding/page.tsx. The DB needs two new columns on `businesses` to store the structured data the wizard captures.
  - `businesses.opening_days   JSONB DEFAULT '{"mon":..,"sun":true}'` — drives scheduling AI (no labour-cut suggestions on closed days) and the /scheduling weekly grid. Column default keeps legacy rows rendering sensibly until owners update.
  - `businesses.business_stage TEXT` with CHECK in (`new`, `established_1y`, `established_3y`). Drives budget AI: 'new' skips the historical-anchor rule (no last-year actuals exist), 'established_*' enforces it. NULL allowed for backfill safety.
**Companion code:**
  - `app/api/businesses/add/route.ts` — accepts `address`, `opening_days`, `business_stage`, validates the enum + JSON shape at the API edge.
  - `app/api/onboarding/complete/route.ts` — accepts `org_number`, writes to `organisations.org_number` via the new shared helper `lib/sweden/applyOrgNumber.ts` (also handles Stripe metadata + tax_id sync). Same helper now backs `/api/settings/company-info` POST so the two paths can't drift.
  - `components/OrgNumberBanner.tsx` and `components/OrgNumberGate.tsx` DELETED — onboarding now requires org_number upfront, the 30-day grace banner + lockout are dead. `misc.orgGate` and `settings.orgNumberBanner` keys removed from all 3 locale JSONs.
**Backwards compat:** pure additions, defaults sensible, `IF NOT EXISTS` on each column, CHECK constraint guarded by an `information_schema` lookup so re-runs are safe. Wrapped in a transaction.
**To apply:** open Supabase SQL Editor, paste file contents, run. Verify query at the bottom dumps the resulting columns.

### M045 — sync_log indexes (kill the 91% seq-scan rate) ✅ applied 2026-04-30
**File:** `M045-SYNC-LOG-INDEXES.sql` (repo root)
**Purpose:** Supabase performance probe flagged `sync_log` doing 91% sequential scans (162 seq scans reading 60k tuples on a 1106-row table). Hot access patterns are `(org_id, created_at DESC)` (per-customer sync history) and `(status, created_at DESC) WHERE status != 'success'` (failure listings on the admin overview + agents tab). Two new indexes cover both. Partial index on the failure case keeps it small.
**Backwards compat:** indexes are pure additions; no data change. `IF NOT EXISTS` makes re-runs safe.
**Safety:** wrapped in `BEGIN; … COMMIT;`. Verify query at the bottom dumps the resulting index list.
**Footnote — duplicate index spotted on apply:** the verify output showed `sync_log_org_idx` already covered `(org_id, created_at DESC)` from a much earlier migration. My new `idx_sync_log_org_created` is therefore redundant with it. Harmless on a 1k-row table — both indexes get used interchangeably and the storage cost is negligible. Future cleanup: `DROP INDEX idx_sync_log_org_created` (keep the older `sync_log_org_idx` since older callers may reference it by name in EXPLAIN logs). The partial `idx_sync_log_status_created` is genuinely new and serves the failure-listing pattern that had no index before.

### M044 — Per-user locale preference (i18n PR 1)
**File:** `M044-USER-LOCALE.sql` (repo root)
**Purpose:** part of FIXES.md §0be. Adds `organisation_members.locale` (TEXT, default 'en-GB', CHECK in {`en-GB`, `sv`, `nb`}). Authenticated users persist their language pick on the membership row so it survives across devices and sessions. Anonymous visitors are cookie-only until they sign up — at which point the cookie value migrates into this column.
**Backwards compat:** every existing member gets `locale='en-GB'` (the current default behaviour). The selector lets them flip; pre-i18n-rollout the value was unused so no semantic change.
**Safety:** `ADD COLUMN IF NOT EXISTS`, idempotent CHECK. Wrapped in `BEGIN; … COMMIT;`.
**To apply:** open Supabase SQL Editor, paste file contents, run.

### M043 — Member roles + scoping (manager access)
**File:** `M043-MEMBER-ROLES-AND-SCOPING.sql` (repo root)
**Purpose:** part of FIXES.md §0az. Adds the columns + CHECK constraint that back the new manager role for customer staff. Existing rows keep `role='owner'` so no behaviour change for current users.
  - `organisation_members.role` — pre-existing column. Coerced to `'owner'` for any null/legacy values, then CHECK-constrained to `('owner', 'manager', 'viewer')`.
  - `organisation_members.business_ids UUID[]` — null = all businesses in the org (single-restaurant case + unscoped manager); array = limited to those businesses. Server-side filter applies on every business-scoped API.
  - `organisation_members.can_view_finances BOOLEAN DEFAULT FALSE` — escape hatch for finance-trusted managers. False by default; managers don't see /tracker, /budget, /forecast, /overheads unless this is flipped.
  - `organisation_members.invited_by`, `invited_at`, `last_active_at` — provisioning audit trail.
  - Index `(org_id, role)` for fast member-list queries on the admin v2 Users sub-tab.
**Backwards compat:** every pre-M043 user has `role='owner'`, `business_ids=NULL`, `can_view_finances=FALSE`. Owners ignore the flag (full access regardless). Managers don't exist yet so the new columns are inert until provisioned.
**Safety:** all `ADD COLUMN IF NOT EXISTS`. Rogue role values pre-coerced to `'owner'` so the CHECK never fails on existing data. Wrapped in `BEGIN; … COMMIT;`.
**To apply:** open Supabase SQL Editor, paste file contents, run.

### M042 — Swedish organisationsnummer on organisations + businesses
**File:** `M042-COMPANY-ORG-NUMBER.sql` (repo root)
**Purpose:** part of FIXES.md §0ax. Adds `org_number TEXT` to both `organisations` and `businesses` (10-digit format, CHECK-constrained `^[0-9]{10}$`). Required at signup going forward; existing customers get a 30-day grace tracked via `organisations.org_number_grace_started_at` (defaults to now() at migration time). `businesses.org_number` is optional — used when a customer runs multiple restaurants under separate ABs; falls back to the parent organisation's number otherwise. Two indexes for fast org-nr lookup from the command palette.
**Backwards compat:** all existing rows get `org_number = NULL` and a fresh `grace_started_at = now()`. Soft banner on the dashboard nudges them; hard-block fires after 30 days. New signups go through validation in `lib/sweden/orgnr.ts` (Luhn-style checksum) — invalid entries rejected by the API.
**Safety:** `ADD COLUMN IF NOT EXISTS`, idempotent CHECK, `IF NOT EXISTS` indexes. Wrapped in `BEGIN; … COMMIT;`. Verification queries at the end show column metadata + constraint definitions + the count of organisations missing org_number (the audience for the soft banner).
**To apply:** open Supabase SQL Editor, paste file contents, run.

---

## Recently applied — for reference

### M041 — Overhead review: extend to food costs (category column) ✅ applied 2026-04-28
**File:** `M041-OVERHEAD-FOOD-CATEGORY.sql` (repo root)
**Purpose:** part of FIXES.md §0av (food-cost extension of overhead-review). Adds `category TEXT NOT NULL DEFAULT 'other_cost'` to both `overhead_classifications` and `overhead_flags`, with `CHECK (category IN ('other_cost', 'food_cost'))`. Replaces the auto-named UNIQUE constraints with named ones that include category: `overhead_classifications_natural_key` on `(business_id, supplier_name_normalised, category)` and `overhead_flags_idempotency_key` on `(business_id, source_upload_id, supplier_name_normalised, flag_type, category)`. Adds two indexes for fast category filtering.
**Backwards compat:** existing rows default to category='other_cost'. The detection worker still works for callers that don't specify categories — `runOverheadReview()` defaults to scanning both. The decide and backfill endpoints upsert with explicit category. The flags GET surfaces `category` in the response.
**Safety:** `ADD COLUMN IF NOT EXISTS`, defensive constraint drops via DO block, idempotent CHECK adds. Wrapped in `BEGIN; … COMMIT;`. Verification queries dump column metadata + constraint definitions + (post-migration) the new natural keys.
**To apply:** open Supabase SQL Editor, paste file contents, run.

### M040 — Integration state log + canonical status vocabulary ✅ applied 2026-04-28
**File:** `M040-INTEGRATION-STATE-LOG.sql` (repo root)
**Purpose:** part of FIXES.md §0at (sync-state centralization). Two pieces in one migration:
  1. CHECK constraint on `integrations.status` enforcing the canonical vocabulary `('connected', 'needs_reauth', 'error', 'retired')`. Rogue rows are coerced to `'error'` before the constraint is added so the migration never fails on existing data.
  2. New `integration_state_log` table — append-only audit of every state transition with `(prev_status, new_status, prev_last_error, new_last_error, context jsonb)`. Three indexes: per-integration history, per-org cross-table scan, and a partial index on failure transitions for rapid "find every wedge in the last hour" queries.
**Backwards compat:** all existing code paths continue to work — direct UPDATEs are still allowed (the constraint just rejects garbage status values). The new `lib/integrations/state.ts` module is the recommended path for new code; existing callers migrate file-by-file.
**Safety:** wrapped in `BEGIN; … COMMIT;`. Constraint creation is idempotent (drops + re-adds). Pre-coerces invalid statuses before the CHECK adds. Verification queries at the bottom: index list + constraint definition + status distribution.
**To apply:** open Supabase SQL Editor, paste file contents, run.

### M039 — Overhead review system (PR 1: schema only)
**File:** `M039-OVERHEAD-REVIEW.sql` (repo root)
**Purpose:** part of FIXES.md §0an (Overhead Review feature PR 1 of 5). Two related tables:
  1. `overhead_classifications(org_id, business_id, supplier_name, supplier_name_normalised, status, decided_by, decided_at, reason, baseline_avg_sek, baseline_set_at, backfill)` — persistent decisions per supplier per business. status ∈ {`essential`, `dismissed`}. UNIQUE (business_id, supplier_name_normalised). `dismissed` = "I plan to cancel this" (forward-looking). `baseline_avg_sek` is snapshotted at decision time so the price-spike re-flag rule has a stable comparator.
  2. `overhead_flags(org_id, business_id, source_upload_id, line_item_id, supplier_name, supplier_name_normalised, flag_type, reason, amount_sek, prior_avg_sek, period_year, period_month, surfaced_at, resolution_status, resolved_at, resolved_by, defer_until, ai_explanation, ai_confidence)` — append-only history of what the worker flagged. UNIQUE (business_id, source_upload_id, supplier_name_normalised, flag_type) makes the worker idempotent. CASCADE on source_upload_id + line_item_id cleans up automatically when an upload is hard-deleted; supersede (status change, not delete) is handled app-side in /api/fortnox/apply (extending the existing supersede cleanup).
**Indexes:** `(business_id, supplier_name_normalised)` for the hot lookup, `(business_id, status) WHERE status='dismissed'` for projection, `(business_id, surfaced_at DESC) WHERE resolution_status='pending'` for the review queue, `(business_id, period_year, period_month)` for supersede cleanup, `(defer_until) WHERE resolution_status='deferred'` for the defer-snooze sweep.
**RLS:** both tables get the M018 pattern — SELECT policy `org_id = ANY(current_user_org_ids())`. No INSERT/UPDATE policies; the only write paths are the worker (PR 2, service-role) and the decide API (PR 3, service-role with `decided_by` recorded from the session).
**Backwards compat:** /api/overheads/flags + /api/overheads/projection (PR 1) degrade gracefully when M039 isn't applied — return empty + `table_missing: true` + a banner-friendly note rather than 500. Same shape as the migration-pending pattern used in M035/M036/M037/M038.
**Safety:** `CREATE TABLE IF NOT EXISTS`, indexes IF NOT EXISTS, `DROP POLICY IF EXISTS` before `CREATE POLICY`. CHECK constraints on status/flag_type/resolution_status keep bad data out. Wrapped in `BEGIN; … COMMIT;`. Verification queries at the end: relation sizes + index list + policy list.
**To apply:** open Supabase SQL Editor, paste file contents, run.

---

## Applied — Sprint 1 + Admin v2 batch (2026-04-28)

### M038 — Admin v2 PR 10 (saved investigations + customer notes) ✅ applied 2026-04-28
**File:** `M038-ADMIN-NOTES-AND-SAVED-QUERIES.sql` (repo root)
**Purpose:** part of FIXES.md §0ak (Admin Console Rebuild PR 10). Two related tables in one migration:
  1. `admin_notes(id, org_id, parent_id, body, created_by, created_at, updated_at, pinned, deleted_at)` — first-class threaded notes for the customer-detail Notes sub-tab. Notes used to live as `note_add` rows on `admin_audit_log.payload` which made editing/deleting/threading/pinning impossible. Index `(org_id, pinned DESC, created_at DESC) WHERE deleted_at IS NULL` is the hot path for the sub-tab list. Soft-delete keeps the row for compliance.
  2. `admin_saved_queries(id, label, query, notes, org_id, created_by, created_at, last_used_at, run_count)` — saved Tools-tab investigations. Optional `org_id` (FK with ON DELETE SET NULL) ties an investigation to a customer. Index on `(last_used_at DESC NULLS LAST, created_at DESC)` for the Tools sidebar.
**Backwards compat:** /api/admin/v2/customers/[orgId]/notes (GET/POST/edit/delete/pin) and /api/admin/v2/tools/saved degrade gracefully when the tables are missing — surface clear "run M038" banners rather than 500. Old `note_add` audit rows from any pre-M038 manual notes (none exist today; the route was placeholder-only) stay readable in the Audit tab as historical records.
**Safety:** `CREATE TABLE IF NOT EXISTS`, indexes IF NOT EXISTS. Both have RLS enabled with no policy → service-role only. CHECK constraints on body/label/query length so an accidental dump doesn't bloat the table. Wrapped in `BEGIN; … COMMIT;`. Verification queries at the end: relation sizes + index list.
**To apply:** open Supabase SQL Editor, paste file contents, run.

### M037 — Admin v2 Tools support (read-only SQL runner RPC) ✅ applied 2026-04-28
**File:** `M037-ADMIN-SQL-RUNNER.sql` (repo root)
**Purpose:** part of FIXES.md §0aj (Admin Console Rebuild PR 9 — Tools tab). Adds `admin_run_sql(p_query TEXT, p_limit INTEGER) RETURNS JSONB`. Validates that the query starts with `SELECT / WITH / TABLE / VALUES / EXPLAIN`, rejects any embedded semicolon (multi-statement guard), rejects every write/DDL/control keyword as a whole word (INSERT, UPDATE, DELETE, MERGE, DROP, ALTER, CREATE, TRUNCATE, GRANT, COPY, DO, CALL, VACUUM, ANALYZE, LOCK, SET, BEGIN, COMMIT, etc.), then wraps in `SELECT * FROM (user_query LIMIT N) t` so the only valid output is a row-set. `STABLE` is NOT used because plpgsql with `EXECUTE` can't be marked STABLE/IMMUTABLE; `SECURITY DEFINER` + `SET search_path = public, pg_catalog`. Sets `statement_timeout=10s` + `lock_timeout=2s` per call so a runaway query can't wedge a Supabase connection.
**Backwards compat:** /api/admin/v2/tools/sql gracefully degrades when the RPC is missing — surfaces a clear "M037 missing" banner rather than 500. JS-side regex validation is the primary defence; the RPC's checks are belt-and-braces.
**Safety:** `CREATE OR REPLACE FUNCTION`, wrapped in `BEGIN; … COMMIT;`. EXECUTE granted only to `service_role` (REVOKE ALL FROM PUBLIC first). Smoke-test queries at the bottom of the file (paste each individually): two should succeed, two should fail with `forbidden keyword` / `multi-statement` errors.
**To apply:** open Supabase SQL Editor, paste file contents, run.

### M036 — Admin v2 Health support (cron_run_log + RLS-health RPC) ✅ applied 2026-04-28
**File:** `M036-ADMIN-HEALTH-CONFIG.sql` (repo root)
**Purpose:** part of FIXES.md §0ah (Admin Console Rebuild PR 7 — Health tab). Two related pieces in one migration:
  1. `cron_run_log(id, cron_name, started_at, finished_at, status, error, meta)` — table written by the new `lib/cron/log.ts::withCronLog` wrapper. The Admin v2 Health tab reads the most-recent row per `cron_name` to surface "last ran X ago / status / error". Two indexes: `(cron_name, started_at DESC)` for the hot per-cron lookup and `(status, started_at DESC)` for failure listings. RLS enabled; service-role only (no policy).
  2. `admin_health_rls()` RPC — returns one row per public-schema table with `(table_name, rls_enabled, policy_count, is_anomaly)`. Anomaly = RLS on but zero policies (table is fully locked to anon/authenticated). `STABLE`, `SECURITY DEFINER`, `SET search_path = public, pg_catalog`. EXECUTE granted only to `service_role`.
**Backwards compat:** Health endpoint degrades gracefully if either piece is missing — surfaces a clear "run M036" banner rather than 500ing. `withCronLog` is non-fatal on logging failures so an un-applied environment isn't bricked. Existing cron handlers are NOT yet wrapped; they'll show "never logged" in the Health tab until a follow-up PR opts each one in (one-line change per handler).
**Safety:** `CREATE TABLE IF NOT EXISTS`, indexes IF NOT EXISTS, `CREATE OR REPLACE FUNCTION`. Wrapped in `BEGIN; … COMMIT;`. Verification queries at the end list `cron_run_log` size, confirm the function exists, and dump any current RLS anomalies (rows with `rowsecurity=true` and 0 policies).
**To apply:** open Supabase SQL Editor, paste file contents, run.

### M033 — Atomic AI quota gate + 24h global-spend RPC ✅ applied 2026-04-28
**File:** `M033-INCREMENT-AI-USAGE-ATOMIC.sql` (repo root)
**Purpose:** part of FIXES.md §0w (Sprint 1 Tasks 4 + 5). Two related fixes in one migration:
  1. `increment_ai_usage_checked(org_id, date, limit)` — atomic `INSERT … ON CONFLICT DO UPDATE` returning `(new_count, allowed)`. Closes the TOCTOU window where 100 parallel `/api/ask` requests could all pass `checkAiLimit` before any increment landed and blow the per-org daily cap by the burst factor. Caller decrements when `allowed=false` so the rejected attempt doesn't tick the counter.
  2. `ai_spend_24h_global_usd()` — Postgres-side SUM for the global kill-switch denominator. Replaces the prior full table scan + sum-in-JS that pulled every row from the last 24 h on every AI call (~125k rows/day fetched at 50 customers). Single index scan now.
  3. Hot indexes for both rolling-window queries: `idx_ai_request_log_created_at` (DESC) for the global rolling sum, `idx_ai_request_log_org_created_at` for the per-org monthly ceiling check.
  4. Belt-and-braces `ALTER TABLE ai_usage_daily ADD CONSTRAINT … UNIQUE (org_id, date)` if missing — the ON CONFLICT path needs it. M002 should have added it; this is for environments rebuilt from older snapshots.
**Backwards compat:** legacy `checkAiLimit` + `incrementAiUsage` retained and `@deprecated`-tagged in `lib/ai/usage.ts`. Cron-driven AI agents (anomaly explainer, weekly digest, monthly forecast calibration) still use them — they run serially under cron locks so TOCTOU isn't an attack surface. RPC missing → both code paths fail OPEN (kill-switch disabled, fall back to non-atomic gate) so an unmigrated environment isn't bricked.
**Safety:** `CREATE OR REPLACE FUNCTION` + `CREATE INDEX IF NOT EXISTS`. Wrapped in `BEGIN; … COMMIT;`. Verification queries at the bottom list the new functions, indexes, and the unique constraint.
**To apply:** open Supabase SQL Editor, paste file contents, run. Then manual burst test (FIXES §0w end): open 5 incognito tabs at `query_count = limit - 2`, fire `/api/ask` simultaneously, expect 2 succeed + 3 return 429 + counter ends at exactly `limit`.

### M032 — Fortnox supersede chain join table ✅ applied 2026-04-28
**File:** `M032-FORTNOX-SUPERSEDE-CHAIN.sql` (repo root)
**Purpose:** part of FIXES.md §0v (Sprint 1 Task 3). Adds `fortnox_supersede_links(child_id, parent_id, period_year, period_month)` so multi-month upload supersede chains preserve every period's parent. Pre-M032, `applyMonthly` overwrote the column-level `supersedes_id` / `superseded_by_id` on each iteration → only the last period's parent survived. Reject path now walks the join table to restore predecessors per-period; pre-fix it would only restore one predecessor for a multi-month rejected upload, leaving other periods data-less.
**Backwards compat:** column-level `supersedes_id` / `superseded_by_id` on `fortnox_uploads` remain; single-month uploads still write them accurately. Reject route falls back to the column when no link rows exist (older supersede chains pre-M032).
**Safety:** CREATE TABLE IF NOT EXISTS, indexes IF NOT EXISTS. RLS enabled with no SELECT/INSERT policy → service-role only access. Verify queries at the bottom confirm the column shape + index list.
**To apply:** open Supabase SQL Editor, paste file contents, run.

---

## Applied — for reference

### M035 — Agent settings table for kill switch (Admin v2 PR 6) ✅ applied 2026-04-28
**File:** `M035-ADMIN-AGENT-SETTINGS.sql` (repo root)
**Purpose:** part of FIXES.md §0ag. Created `agent_settings(key TEXT PK, is_active BOOLEAN, last_changed_at, last_changed_by, last_change_reason)`. Seeded the 6 known agent keys with `is_active=true`. The Admin v2 Agents tab toggles `is_active` to globally kill an agent.
**Verified 2026-04-28:** all 6 seed rows present (anomaly_detection / forecast_calibration / monday_briefing / onboarding_success / scheduling_optimization / supplier_price_creep), all `is_active=true`.
**Caveat:** cron handlers DO NOT yet check this column. The kill switch is visible + audited via the v2 Agents tab; wiring the crons to honour `is_active=false` is a small follow-up PR.

### M034 — Performance indexes for revenue_logs + staff_logs (Sprint 1.5) ✅ applied 2026-04-27
**File:** `M034-PERF-INDEXES.sql` (repo root)
**Purpose:** part of FIXES.md §0z (Sprint 1.5 Task 1). Both `revenue_logs` and `staff_logs` had ZERO indexes in any tracked migration — they pre-date the M008 summary-tables migration and were never retrofitted. `/api/departments` paginated through full table scans of both on every dashboard load. With <10k rows today the seq scan was invisible; at 50 customers × 2yr history (~200k+ rows) it would become the slowest query in the system.
**Indexes added (verified 2026-04-27):**
  - `idx_revenue_logs_org_biz_date` on `(org_id, business_id, revenue_date)` ✅
  - `idx_revenue_logs_org_provider_date` on `(org_id, provider, revenue_date)` ✅
  - `idx_staff_logs_org_biz_date` on `(org_id, business_id, shift_date)` ✅
  - `idx_staff_logs_org_group_date` on `(org_id, staff_group, shift_date)` ✅
**Pre-existing (not part of M034, no conflict):** `idx_staff_logs_date` on `(shift_date)` alone — slightly redundant with the composite, harmless.
**No code changes** — query plans pick up indexes automatically. New endpoints reading these tables MUST add their own index if they introduce a different shape; don't silently rely on these.

### M031 — POS completeness signal (`pos_days_with_revenue`) ✅ applied 2026-04-26
**File:** `M031-POS-COMPLETENESS.sql` (repo root)
**Purpose:** part of FIXES.md §0r. Adds `monthly_metrics.pos_days_with_revenue INT` so the aggregator can detect partial-month POS coverage and prefer Fortnox tracker_data when POS only synced a fraction of the month. Without this, partial POS revenue (e.g. PK integration added mid-month) would override full Fortnox revenue in `monthly_metrics`, producing absurd margins on the Performance page (Vero Nov 2025 showed −137 % margin from POS-revenue-vs-Fortnox-costs mismatch).
**Backfill:** counts distinct dates with non-zero revenue per (business, year, month) from `daily_metrics` and writes to the new column. Idempotent.
**To apply:** open Supabase SQL Editor, paste file contents, run. Verification query at the end lists 2025 months by coverage % so you can spot the partial-month rows that the aggregator will now route to Fortnox.

### M030 — Re-categorise misclassified line items (one-off cleanup) ✅ applied 2026-04-26
**File:** `M030-RECATEGORIZE-LINE-ITEMS.sql` (repo root)
**Purpose:** companion to the FIXES.md §0o postscript fix in `extract-worker/route.ts::enrichLines`. Pre-fix, when the AI tagged a line as one category (e.g. 'revenue') but the Swedish label clearly meant another (e.g. 'reklam' = marketing → other_cost), the AI category was kept. Surfaced by the M029 verify query as 13 rows of `category='revenue' subcategory='marketing'` (50k kr).
**Mappings (all idempotent):**
  - subcategory ∈ {marketing, rent, utilities, accounting, audit, consulting, insurance, bank_fees, telecom, software, postage, shipping, office_supplies, cleaning, repairs, consumables, entertainment, vehicles, electricity} → category='other_cost'
  - subcategory ∈ {salaries, payroll_tax, pension} → category='staff_cost'
  - subcategory='depreciation' → category='depreciation'
  - subcategory ∈ {interest, interest_income} → category='financial'
**Safety:** UPDATE only flips `category`; subcategory + amount + label stay untouched. Wrapped in `BEGIN; … COMMIT;`. Verify queries at the end show the post-fix distribution and confirm `revenue` bucket is now clean (food/takeaway/alcohol/null only).
**To apply:** open Supabase SQL Editor, paste file contents, run.

### M029 — Revenue VAT-rate split (dine_in / takeaway / alcohol) ✅ applied 2026-04-26
**File:** `M029-REVENUE-VAT-SPLIT.sql` (repo root)
**Purpose:** part of FIXES.md §0o. Promotes the Swedish VAT-rate revenue split (12% = dine-in food, 6% = takeaway / Wolt-Foodora, 25% = alcohol) to first-class columns on `tracker_data`, matching what `revenue_logs` already has from the POS side. Surfaces takeaway revenue as a distinct slice so owners can see platform-delivery share (Wolt/Foodora take ~30% commission, so 100k of takeaway ≠ 100k of margin contribution).
Three concerns in one migration:
  1. Adds `dine_in_revenue`, `takeaway_revenue`, `alcohol_revenue` columns to `tracker_data`. Each is a SUBSET of `revenue` (never additive).
  2. Re-tags existing `tracker_line_items`: rows whose label contains "6% moms" or matches Wolt/Foodora/UberEats get `subcategory='takeaway'` (was 'food' from the legacy classifyByVat). 25%-moms rows that didn't get tagged get `subcategory='alcohol'`. Idempotent.
  3. Backfills the new columns from the re-tagged line items per (business, year, month). Caps each subset at total revenue (defensive against rounding).
**Safety:** all `ADD COLUMN` use `IF NOT EXISTS`. UPDATE statements include `IS DISTINCT FROM` guards so re-runs are no-ops. Backfill only writes when current value is 0. Wrapped in `BEGIN; … COMMIT;`.
**To apply:** open Supabase SQL Editor, paste file contents, run. Verification queries at the bottom show the new columns + a backfilled-row count + the re-tagged subcategory distribution.

### M028 — Fortnox proper fix (depreciation/financial/alcohol_cost + supersede) ✅ applied 2026-04-26
**File:** `M028-FORTNOX-PROPER-FIX.sql` (repo root)
**Purpose:** part of FIXES.md §0n (Tier 2 architectural rebuild of the Fortnox extraction pipeline). Three concerns in one migration:
  1. Adds `depreciation`, `financial`, `alcohol_cost` columns to `tracker_data`. The first two were referenced everywhere but never existed in the schema; the apply route silently dropped them, /api/tracker silently overstated profit by the depreciation amount on every Fortnox month. `alcohol_cost` is promoted to a first-class rollup column so the Performance page reads the food/alcohol split from the rollup instead of summing line items.
  2. Adds `supersedes_id` + `superseded_by_id` columns to `fortnox_uploads` and expands the status check to include `'superseded'`. apply() now detects a prior applied upload for the same (business, year, month) and links them so re-uploads have a traceable chain instead of orphan rows. Also fixes the multi-month reject bug (line items deleted by source_upload_id, no period_month filter).
  3. Backfills (1) for already-applied uploads from `fortnox_uploads.extracted_json` so historical Performance page numbers become correct without forcing re-uploads. Recomputes `tracker_data.net_profit` + `margin_pct` for backfilled rows under the canonical formula (revenue − food − staff − other − depreciation + financial). Manual entries are not touched.
**Safety:** all `ADD COLUMN` operations use `IF NOT EXISTS`. Status check is dropped + recreated by name lookup so the migration is environment-portable. Backfill only writes when current value is 0 (never overwrites manual entries). Wrapped in `BEGIN; … COMMIT;` so a partial failure rolls back cleanly.
**To apply:** open Supabase SQL Editor, paste file contents, run. Verification queries at the bottom show the new columns + a count of backfilled rows.

### M027 — aggregation_lock (per-business serialisation for aggregateMetrics) ✅ applied 2026-04-26
**File:** `M027-AGGREGATION-LOCK.sql` (repo root)
**Purpose:** part of FIXES.md §0m (PK sync recurring failures, four-phase fix). Adds a tiny `aggregation_lock` table so `aggregateMetrics` can take a per-business advisory lock and prevent two concurrent sync paths (per-sync aggregate + post-cron aggregate sweep + on-demand /api/sync/today) from race-overwriting `daily_metrics` rows. Stale rows >60s are stolen. The §0l workaround mitigates the race; this lock cures it.
**Verified:** `aggregation_lock` table present with `business_id uuid PRIMARY KEY`, `locked_at timestamptz`, `locked_by text`.

### M024 — PK sync cursors (incremental fetch optimisation) ✅ applied 2026-04-26
**File:** `M024-PK-SYNC-CURSORS.sql` (repo root)
**Purpose:** add `integrations.pk_sync_cursors jsonb default '{}'::jsonb` column so master-sync can pass PK's `?sync_cursor=<last>` parameter and only fetch rows that changed/appeared since the last run, instead of refetching the full window. Roughly halves both PK API calls and Vercel function time on repeat syncs. Engine has structured-error fallback if the column is missing — now lifted.
**Verified:** `pk_sync_cursors jsonb DEFAULT '{}'::jsonb` present on `integrations`.

### M023 — reset stuck `status = 'error'` integrations (one-off backfill) ✅ applied 2026-04-23
**File:** `M023-RESET-STUCK-ERROR-STATUS.sql` (repo root)
**Purpose:** companion to code fix `d60d193`. Engine was only updating `last_sync_at` + `last_error` on success, never resetting `status` itself — so one-off failures stuck integrations in 'error' forever, excluding them from `/api/resync`, BackgroundSync, and catchup-sync (all filter on status='connected'). The backfill flipped rows where `last_sync_at` was within 48h AND `last_error` was empty back to 'connected'. Code fix prevents recurrence. Verified: 8 connected after run.

### M022 — integration reauth tracking ✅ applied 2026-04-22
**File:** `M022-INTEGRATION-REAUTH.sql` (repo root)
**Purpose:** support for the typed `PersonalkollenAuthError` path added in commit `ada0e7d`. When PK returns 401/403, sync engine flips `integrations.status` to `needs_reauth` and emails the org owner once per event — deduped via `reauth_notified_at` so a daily failed master-sync doesn't spam the inbox. Verified: `reauth_notified_at timestamptz` present, status CHECK widened to include `needs_reauth`.

### M015 — weather_daily
**File:** `sql/M015-weather-daily.sql`
**Purpose:** store observed + forecast weather per business per day. Feeds AI memo, scheduling suggestion, and `/weather` correlation page.
**To apply:** open Supabase SQL Editor, paste file contents, run. Then hit `POST /api/admin/weather/backfill?secret=ADMIN_SECRET` once to populate historical rows. After that, daily sync keeps it current.

### M016 — memo_feedback
**File:** `sql/M016-memo-feedback.sql`
**Purpose:** stores thumbs up / thumbs down + optional comment on each Monday memo. Populated via the public `/api/memo-feedback` endpoint, secured by HMAC-signed tokens (key: `CRON_SECRET`) embedded in the email buttons.
**To apply:** open Supabase SQL Editor, paste file contents, run. No backfill needed — new memos from the next cron tick onward will include the feedback block. Requires M003 `briefings` already applied (FK target).

### M021 — pg_cron replaces fire-and-forget dispatcher
**File:** `M021-PG-CRON-EXTRACTION-SWEEPER.sql` (repo root)
**Purpose:** Claude.ai architecture review item 4 — replace `waitUntil(fetch())` dispatcher + Vercel cron with Supabase pg_cron firing the worker every 20 seconds. Kills the stuck-in-extracting class of failure at the DB layer (no HTTP hop between scheduler and DB). Paired `cc-reset-stale-extraction-jobs` cron runs the M017 reset RPC every minute so crashed workers release their claim automatically.
**Creates:** enables `pg_cron` + `pg_net` extensions; `fire_extraction_worker()` function that reads `cc_worker_url` + `cc_cron_secret` from Supabase Vault and POSTs to the worker endpoint; two scheduled jobs.
**Post-migration manual step:** after running the SQL, go to **Supabase Dashboard → Project Settings → Vault** and add two secrets:
  - `cc_worker_url` = `https://www.comandcenter.se/api/fortnox/extract-worker`
  - `cc_cron_secret` = `<your CRON_SECRET>` (from Vercel env vars)
The `fire_extraction_worker()` function reads these by name.
**To apply:** open Supabase SQL Editor, paste file contents, run. Then add the two Vault secrets. Verification query at bottom of the SQL file confirms both crons are scheduled.

### M020 — ai_forecast_outcomes (AI accuracy feedback loop)
**File:** `M020-AI-FORECAST-OUTCOMES.sql` (repo root)
**Purpose:** captures every AI-suggested budget/forecast prediction + the actual outcome once the period closes, so future AI prompts can include a "PRIOR ACCURACY" block and correct systematic bias. Not ML training — pure in-context feedback via future prompts.
**Creates:** `ai_forecast_outcomes` table (one row per business × period × surface), indexes for dispatch + unresolved lookup, RLS (org read + feedback-only UPDATE), `prune_ai_forecast_outcomes()` RPC for 3-year retention.
**Downstream:** `/api/budgets/generate` writes rows on each AI call; `/api/cron/ai-accuracy-reconciler` (daily 07:00 UTC) fills in actuals from monthly_metrics; budget generator reads last 12 months on next call.
**GDPR:** numeric values only, no PII. Tenant-isolated via RLS. Cascade deletes on org/business removal. 3-year retention enforced.
**To apply:** open Supabase SQL Editor, paste file contents, run. Idempotent.

### M019 — Supabase Realtime publication
**File:** `M019-REALTIME-PUBLICATION.sql` (repo root)
**Purpose:** adds `fortnox_uploads` and `extraction_jobs` to the `supabase_realtime` publication so the `/overheads/upload` page receives push updates instead of polling every 3 seconds. RLS policies still apply to Realtime events.
**To apply:** open Supabase SQL Editor, paste file contents, run. Idempotent.

### M018 — RLS gaps + Stripe dedup + org rate limits
**File:** `M018-RLS-GAPS-MIGRATION.sql` (repo root)
**Purpose:** enables RLS on 5 previously-exposed tables, replaces single-org `current_org_id()` with array-returning `current_user_org_ids()`, adds `stripe_processed_events` for webhook idempotency, adds `org_rate_limits` for persistent per-org rate limiting.
**Applied:** 2026-04-21 ✅

### M017 — extraction_jobs queue
**File:** `FORTNOX-JOBS-MIGRATION.sql` (repo root)
**Purpose:** job queue for async Fortnox PDF extraction. Replaces the request-bound extraction path with dispatcher → worker → sweeper architecture: dispatcher upserts a row, worker atomically claims jobs via `FOR UPDATE SKIP LOCKED`, sweeper cron resets stale 'processing' rows and fires workers for ready 'pending' rows. Retries with exponential backoff (30s / 2m / 10m), dead-letter after 3 attempts.
**Creates:** `extraction_jobs` table (one row per upload_id, UNIQUE), three RPCs (`claim_next_extraction_job`, `reset_stale_extraction_jobs`, `list_ready_extraction_jobs`), indexes for dispatch + stale detection, RLS read policy.
**To apply:** open Supabase SQL Editor, paste file contents, run. Idempotent. After applying, the `/api/cron/extraction-sweeper` endpoint starts serving traffic (cron schedule `*/2 * * * *`).

---

## How to use this file

When you run any SQL in the Supabase SQL Editor:
1. Add an entry below with the date, session, and exact SQL run
2. Mark whether it succeeded
3. Note any follow-up needed

This is the single source of truth for what the current schema looks like.

---

## Schema baseline (as of Session 5)

The following tables exist in production Supabase (llzmixkrysduztsvmfzi):

| Table | Key columns |
|-------|------------|
| organisations | id, name, plan, trial_ends_at, stripe_customer_id |
| organisation_members | org_id, user_id, role |
| businesses | id, org_id, name, city, is_active |
| integrations | id, org_id, business_id, provider, credentials_enc, status, last_sync_at, last_error |
| staff_logs | id, org_id, business_id, shift_date, staff_name, staff_group, staff_email, hours_worked, cost_actual, estimated_salary, ob_supplement_kr, ob_type, is_late, late_minutes, net_hours, breaks_seconds, real_start, real_stop, shift_start, shift_end, costgroup_name, costgroup_url, pk_log_url, pk_staff_url, pk_staff_id, pk_workplace_url, period_year, period_month |
| revenue_logs | id, org_id, business_id, revenue_date, revenue, covers, revenue_per_cover, transactions, tip_revenue, takeaway_revenue, dine_in_revenue, food_revenue, drink_revenue, provider |
| tracker_data | id, org_id, business_id, period_year, period_month, revenue, staff_cost, food_cost, drink_cost, rent, other_costs, net_profit |
| forecasts | id, org_id, business_id, period_year, period_month, revenue_forecast, staff_cost_forecast, margin_forecast |
| budgets | id, org_id, business_id, period_year, staff_budget, food_budget, drink_budget, rent_budget, other_budget |
| covers | id, org_id, business_id, date, total, revenue, revenue_per_cover |
| anomaly_alerts | id, org_id, business_id, alert_type, severity, title, description, metric_value, expected_value, deviation_pct, period_date, is_read, is_dismissed |
| gdpr_consents | id, org_id, user_id, consent_type, version, consented_at, withdrawn_at |
| deletion_requests | id, org_id, user_id, requested_at, status, completed_at, notes |
| onboarding_progress | id, org_id, step, metadata |

---

## Migration log

### M001 — 2026-04-10 — Session 5 — OB type and food/drink split
**Run**: 2026-04-10
**Status**: ✅ Success

```sql
ALTER TABLE staff_logs ADD COLUMN IF NOT EXISTS ob_type TEXT;
ALTER TABLE revenue_logs ADD COLUMN IF NOT EXISTS food_revenue INTEGER DEFAULT 0;
ALTER TABLE revenue_logs ADD COLUMN IF NOT EXISTS drink_revenue INTEGER DEFAULT 0;
```

---

### M002 — 2026-04-11 — Session 6 — AI query tracking
**Run**: 2026-04-11
**Status**: ✅ Success

```sql
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  query_count INTEGER DEFAULT 0,
  UNIQUE(org_id, date)
);
ALTER TABLE ai_usage_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ai_usage_daily_select_own" ON ai_usage_daily
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));
```

---

### M003 — 2026-04-17 — Session 7 — AI Agent Tables
**Run**: 2026-04-17
**Status**: ✅ **SUCCESS** — Verified via Supabase REST probe: all 3 tables + `integrations.onboarding_email_sent` column present

```sql
-- Table for forecast calibration agent (runs 1st of month)
CREATE TABLE IF NOT EXISTS forecast_calibration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  calibrated_at TIMESTAMPTZ DEFAULT now(),
  accuracy_pct NUMERIC,
  bias_factor NUMERIC DEFAULT 1.0,
  dow_factors JSONB,
  UNIQUE(business_id)
);
ALTER TABLE forecast_calibration ENABLE ROW LEVEL SECURITY;
CREATE POLICY "forecast_calibration_select_own" ON forecast_calibration
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Table for scheduling optimization agent (runs weekly)
CREATE TABLE IF NOT EXISTS scheduling_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  generated_at TIMESTAMPTZ DEFAULT now(),
  recommendations TEXT NOT NULL,
  analysis_period TEXT,
  metadata JSONB
);
ALTER TABLE scheduling_recommendations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "scheduling_recommendations_select_own" ON scheduling_recommendations
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Table for Monday briefing agent (needs Resend)
CREATE TABLE IF NOT EXISTS briefings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  content TEXT NOT NULL,
  key_metrics JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(business_id, week_start)
);
ALTER TABLE briefings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "briefings_select_own" ON briefings
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Column for onboarding success agent
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS onboarding_email_sent BOOLEAN DEFAULT false;
```

**Follow-up**: Run this SQL in Supabase SQL Editor before deploying AI agents.

---

### M006 — 2026-04-16 — Session 8 — Departments table
**Run**: ⏳ **PENDING** — Run in Supabase SQL Editor before using /departments page

```sql
-- Department definitions — one row per department per business
-- Maps department name → used as PK staff_group AND Inzii integration key
CREATE TABLE IF NOT EXISTS departments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#6366f1',
  sort_order  INT  NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(business_id, name)
);
CREATE INDEX IF NOT EXISTS idx_departments_org ON departments(org_id);
CREATE INDEX IF NOT EXISTS idx_departments_biz ON departments(business_id);
```

**After running SQL**: Go to Admin panel → expand Vero Italiano → click "Setup departments →" button
This auto-creates department records from the existing Inzii integrations.

---

### M005 — 2026-04-15 — Session 7 — Inzii POS department support
**Run**: 2026-04-15
**Status**: ✅ Complete — both steps confirmed (all 6 Inzii dept rows inserted, constraint fix working)

```sql
-- Step 1: Add department column (run first)
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS department TEXT;

-- Step 2: Replace single unique constraint with two partial indexes
-- Old constraint only allowed one integration per provider per business.
-- New indexes allow multiple Inzii rows (one per department) while keeping
-- the single-row-per-provider rule for all other integrations.
ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_business_id_provider_key;
ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_org_business_provider_unique;

CREATE UNIQUE INDEX IF NOT EXISTS integrations_uniq_with_dept
  ON integrations (business_id, provider, department)
  WHERE department IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS integrations_uniq_no_dept
  ON integrations (business_id, provider)
  WHERE department IS NULL;
```

---

### M004 — 2026-04-15 — Session 6 — AI Agent Support Tables
**Run**: 2026-04-15
**Status**: ⏳ **PENDING** — Optional, for future agents

```sql
-- Table for supplier price creep agent (when Fortnox OAuth approved)
CREATE TABLE IF NOT EXISTS supplier_price_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  detected_at TIMESTAMPTZ DEFAULT now(),
  supplier_name TEXT,
  item_name TEXT,
  old_price NUMERIC,
  new_price NUMERIC,
  increase_pct NUMERIC,
  invoice_date DATE,
  alert_severity TEXT CHECK (alert_severity IN ('low', 'medium', 'high')),
  is_resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT
);
ALTER TABLE supplier_price_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "supplier_price_alerts_select_own" ON supplier_price_alerts
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Table for anomaly detection agent email tracking
ALTER TABLE anomaly_alerts ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;
ALTER TABLE anomaly_alerts ADD COLUMN IF NOT EXISTS email_recipients TEXT[];
```

---

## SQL to Run Now for AI Agents

Copy and paste this into Supabase SQL Editor:

```sql
-- M003: AI Agent Tables
CREATE TABLE IF NOT EXISTS forecast_calibration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  calibrated_at TIMESTAMPTZ DEFAULT now(),
  accuracy_pct NUMERIC,
  bias_factor NUMERIC DEFAULT 1.0,
  dow_factors JSONB,
  UNIQUE(business_id)
);
ALTER TABLE forecast_calibration ENABLE ROW LEVEL SECURITY;
CREATE POLICY "forecast_calibration_select_own" ON forecast_calibration
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

CREATE TABLE IF NOT EXISTS scheduling_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  generated_at TIMESTAMPTZ DEFAULT now(),
  recommendations TEXT NOT NULL,
  analysis_period TEXT,
  metadata JSONB
);
ALTER TABLE scheduling_recommendations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "scheduling_recommendations_select_own" ON scheduling_recommendations
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

ALTER TABLE integrations ADD COLUMN IF NOT EXISTS onboarding_email_sent BOOLEAN DEFAULT false;

-- Mark as executed after running
-- ✅ EXECUTED 2026-04-15
```

---

## Current Schema Summary

### AI Agent Tables (Session 6)
1. **`ai_usage_daily`** — AI query limits per org per day
2. **`forecast_calibration`** — Forecast accuracy and bias factors (monthly)
3. **`scheduling_recommendations`** — Staff scheduling optimizations (weekly)
4. **`briefings`** — Monday briefing content (when Resend verified)
5. **`supplier_price_alerts`** — Supplier price increases (when Fortnox connected)

### Agent Status
- ✅ **Anomaly detection** — Live, uses `anomaly_alerts` table
- ✅ **Forecast calibration** — Ready, needs `forecast_calibration` table
- ✅ **Scheduling optimization** — Ready, needs `scheduling_recommendations` table
- ✅ **Supplier price creep** — Skeleton built, needs `supplier_price_alerts` table
- 🔄 **Onboarding success** — In progress, uses `onboarding_email_sent` column
- 📋 **Monday briefing** — Planned, needs `briefings` table

---

## M006 — 2026-04-15 — Session 7 — API Schema Discovery Agent
**Run**: 2026-04-15 ✅
**Status**: ✅ **SUCCESS** — Migration executed successfully

```sql
-- Table for API Schema Discovery Agent
CREATE TABLE IF NOT EXISTS api_discoveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID REFERENCES integrations(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  discoveries JSONB,
  suggested_mappings JSONB,
  recommendations JSONB,
  discovered_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(integration_id)
);
ALTER TABLE api_discoveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "api_discoveries_select_own" ON api_discoveries
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Add last_discovery_at column to integrations table
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS last_discovery_at TIMESTAMPTZ;
```

**Purpose**: Stores API schema discoveries and suggested mappings for the API Schema Discovery Agent.
**Agent**: `/api/cron/api-discovery` — analyzes API endpoints and suggests mappings to CommandCenter schema.

---

## M007 — 2026-04-16 — Session 7 — Enhanced API Discovery tables
**Run**: ✅ **COMPLETE** — Executed in Supabase SQL Editor during Session 7
**Status**: ✅ COMPLETE

```sql
-- Add missing columns to integrations table
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS last_enhanced_discovery_at TIMESTAMPTZ;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS provider_type TEXT;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS api_endpoints_cache TEXT;

-- Create api_discoveries_enhanced table
CREATE TABLE IF NOT EXISTS api_discoveries_enhanced (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID REFERENCES integrations(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_type TEXT,
  analysis_result JSONB,
  discovered_at TIMESTAMPTZ DEFAULT now(),
  confidence_score INTEGER DEFAULT 0,
  data_type TEXT,
  unused_fields_count INTEGER DEFAULT 0,
  business_insights_count INTEGER DEFAULT 0,
  UNIQUE(integration_id)
);
ALTER TABLE api_discoveries_enhanced ENABLE ROW LEVEL SECURITY;
CREATE POLICY "api_discoveries_enhanced_select_own" ON api_discoveries_enhanced
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Create implementation_plans table
CREATE TABLE IF NOT EXISTS implementation_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID REFERENCES integrations(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  phase1_tasks JSONB,
  phase2_tasks JSONB,
  phase3_tasks JSONB,
  estimated_timeline TEXT,
  generated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(integration_id)
);
ALTER TABLE implementation_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "implementation_plans_select_own" ON implementation_plans
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));
```

---

## M008 — 2026-04-17 — Session 8 — Onboarding step + metadata columns
**Run**: 2026-04-17
**Status**: ✅ **SUCCESS** — verified via REST probe

```sql
ALTER TABLE onboarding_progress ADD COLUMN IF NOT EXISTS step TEXT;
ALTER TABLE onboarding_progress ADD COLUMN IF NOT EXISTS metadata JSONB;
```

**Why**: `/api/onboarding/setup-request` was writing to `step` and `metadata` columns that didn't exist, so every new customer's setup-form data (restaurant name, city, staff system, accounting, POS) was silently dropped. Admin panel's "Setup requests" section was always empty. After this migration, signup metadata persists and admin renders correctly.

---

## M009 — 2026-04-18 — Session 10 — Deletion requests audit table
**Run**: 2026-04-18
**Status**: ✅ **SUCCESS**
**File**: `sql/M009-deletion-requests.sql`

Creates `public.deletion_requests` — tamper-evident audit of every GDPR Art. 17 hard delete. Written before purge, updated after. Retained indefinitely as compliance evidence. RLS enabled, no policies (service-role only).

---

## M010 — 2026-04-18 — Session 10 — Admin audit log
**Run**: 2026-04-18
**Status**: ✅ **SUCCESS**
**File**: `sql/M010-admin-audit-log.sql`

Creates `public.admin_audit_log` — every mutation by an admin gets a row (impersonate, key edits, integration deletes, hard deletes, trial extensions, agent toggles, etc.). Three indexes: per-org, per-action, per-date. Retained 2+ years for GDPR Art. 32 evidence. Paired with new `lib/admin/audit.ts` helper and `/admin/audit` viewer page.

---

## M011 — 2026-04-18 — Session 10 — Unique constraints on upsert targets
**Run**: 2026-04-18
**Status**: ✅ **SUCCESS** — all 7 partial unique indexes verified via `pg_indexes`
**File**: `sql/M011-unique-constraints.sql`

Closes a correctness-bug class: `lib/sync/engine.ts` upserts rely on `onConflict` keys that had no matching unique constraint, meaning duplicates silently accumulated. Each block dedupes (keeps newest by `created_at` DESC / `id` DESC) then adds a partial unique index (`WHERE business_id IS NOT NULL` pattern handles the nullable-column issue where Postgres treats NULLs as distinct).

Indexes created:
- `revenue_logs_org_biz_provider_date_unique` on (org_id, business_id, provider, revenue_date)
- `covers_business_date_unique` on (business_id, date)
- `staff_logs_pk_log_url_unique` on (pk_log_url)
- `integrations_org_biz_provider_dept_unique` on (org_id, business_id, provider, COALESCE(department, ''))
- `integrations_org_null_biz_provider_unique` on (org_id, provider, COALESCE(department, '')) WHERE business_id IS NULL
- `forecasts_org_biz_period_unique` on (org_id, business_id, period_year, period_month)
- `tracker_data_biz_period_unique` on (business_id, period_year, period_month)

Note for future migrations: `revenue_logs` and `forecasts` do not have `updated_at`; `integrations` does not have `connected_at`. Initial M011 file referenced those columns and had to be patched to use `created_at DESC NULLS LAST, id DESC` everywhere.

---

## M012 — 2026-04-18 — Session 10 — Orphan-table authoritative schema
**Run**: 2026-04-18
**Status**: ✅ **SUCCESS** (after sync_log schema drift patch)
**File**: `sql/M012-orphan-tables.sql`

Documents every table the code reads/writes that never had a formal migration. Each `CREATE TABLE IF NOT EXISTS` is a no-op if the table already exists — safe to run repeatedly. Tables codified: `billing_events`, `invoices`, `feature_flags`, `support_notes`, `support_tickets`, `supplier_mappings`, `pk_sale_forecasts`, `financial_logs`, `api_credentials`, `api_probe_results`, `integration_health_checks`, `pos_connections`, `sync_log`, `customer_health_scores`, `ai_usage`, `ai_request_log`, `export_schedules`, `notebook_documents`.

**Patch applied during run**: `sync_log` existed in prod without the `integration_id` column, so the `CREATE INDEX … ON sync_log (integration_id, …)` statement failed with `42703`. Fix: reshaped sync_log section to `CREATE TABLE IF NOT EXISTS` with only the original five columns, then `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for the seven drifted columns (`business_id`, `integration_id`, `records_synced`, `date_from`, `date_to`, `error_msg`, `duration_ms`). Re-run after patch succeeded.

---

## Next Steps

1. **Run M007 SQL** — required for Enhanced API Discovery to work
2. **Run M003 SQL** in Supabase SQL Editor (if not already done)
3. **Deploy AI agents** to Vercel
4. **Test cron jobs** with Bearer token
5. **Monitor logs** for agent execution
6. **Update this file** with execution status

---

*Always update this file before and after running SQL in Supabase.*
