# Piece 0 Implementation Prompt — Foundation Fixes

> The first implementation piece of the Prediction System architecture (`prompts/PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md`).
> Time budget: 2-3 days of focused work, spread across 3 calendar weeks per the architecture's sequencing.
> Output: working code merged behind feature flags where applicable; nothing customer-facing changes EXCEPT the three documented "silent improvement" exceptions.

---

## Context — read this before doing anything

This is **not greenfield work**. It's foundation cleanup that has to happen before the prediction system architecture can be built on top. The architecture document at `prompts/PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md` is the authoritative spec — read Section 9 (Sequencing) and Section 11 (Launch strategy) before starting implementation.

Three things you need to internalize:

1. **Vero is the only customer.** Don't break their experience. Three changes are explicit "silent improvements" (see Section 11) and customers will see those — that's intentional. Everything else is gated behind feature flags or admin-only.

2. **Investigation comes before implementation.** This prompt asks you to read existing code carefully. The two prior architecture reviews caught column-name bugs that would have crashed the system on first run. Do not assume column names, schemas, function names, or file paths. Verify each one against the codebase. If you find a discrepancy with the architecture doc, **flag it and stop** — don't paper over it.

3. **This is foundation. Don't take shortcuts.** Every shortcut here compounds across 23 weeks. Get the schema right. Get the RLS right. Get the migration ordering right. Test idempotency. Confirm rollback works.

---

## What to do

This piece has six work streams. Some can run in parallel. Investigation-first for each one.

### Stream A — `weather_daily` recovery (Week 1, ~1 day)

#### A.1 Investigation

1. Read `MIGRATIONS.md` and confirm the current state of M015. The architecture review states "M015 is not in the M022-M047 applied range" — verify whether this means it was never applied or was rolled back.
2. Query the prod schema (or check Supabase dashboard) to confirm whether `weather_daily` table exists. If it returns `PGRST205`, it doesn't.
3. Read `app/api/admin/weather/backfill/route.ts` — confirm it exists, understand the current backfill flow (it should pull from `firstRev?.date` per the architecture review).
4. Read `lib/weather/demand.ts:289-340` to confirm the `byBucket` query pattern and how it currently degrades when `weather_daily` is empty.

#### A.2 Implementation

1. **Apply M015** — if the migration file exists in `migrations/` and just hasn't been applied to prod, apply it. If the file is missing, recreate it from the schema referenced in `lib/weather/demand.ts`. Document the path you took in the migration log.
2. **Extend the backfill route** at `app/api/admin/weather/backfill/route.ts` to accept a `start_date` query parameter that overrides the default `firstRev?.date`. The default behavior must remain unchanged for backward compatibility.
3. **Run the backfill for Vero** with `start_date='2023-05-01'` (covers ~3 years of history needed for `weather_change_vs_seasonal` signal). Confirm Open-Meteo's `archive-api` returns data for the full range.
4. **Verify lift logic re-engages**: after backfill, `lib/weather/demand.ts` should produce non-1.0 lift factors for Vero's bucket lookups. Spot-check a few dates.

#### A.3 Acceptance

- `weather_daily` table exists in prod with ≥1000 rows for Vero
- `lib/weather/demand.ts` produces non-default `weather_lift_factor` for at least 50% of forecast dates
- The legacy demand-forecast route's response shape is unchanged (no breaking changes)
- **Document this as a silent improvement in the changelog.** Vero's demand outlook day cards will shift slightly post-deploy.

### Stream B — Disable `forecast-calibration` cron (Week 1, ~1 hour)

#### B.1 Investigation

1. Read `app/api/cron/forecast-calibration/route.ts` to confirm what it writes to `forecast_calibration` table.
2. Confirm via grep: nothing in the codebase reads `forecast_calibration.dow_factors` operationally. The architecture says it's only consumed by `/api/ask` context. Verify.
3. Confirm `accuracy_pct` and `bias_factor` are written by `app/api/cron/ai-accuracy-reconciler/route.ts` (M020 reconciler) — they should keep working after this cron is disabled.

#### B.2 Implementation

1. **Remove the `forecast-calibration` cron entry from `vercel.json`.** Do NOT delete the route file (might want to revive it later).
2. Add a comment at the top of `app/api/cron/forecast-calibration/route.ts`:
   ```
   // DEPRECATED 2026-05: dow_factors had a sample-size bug (Vero Sun=0.009).
   // The consolidated forecaster (lib/forecast/daily.ts, Piece 2) replaces this with
   // per-weekday rolling baselines + sample-size guardrails. Cron is disabled.
   // accuracy_pct and bias_factor are written by ai-accuracy-reconciler instead.
   ```
3. **Do NOT modify `forecast_calibration` table schema.** `accuracy_pct` and `bias_factor` columns stay in use.

#### B.3 Acceptance

- Cron no longer runs (verify in Vercel dashboard after next scheduled time)
- `forecast_calibration.dow_factors` for Vero is no longer being updated
- `accuracy_pct` and `bias_factor` still update via M020 reconciler at 07:00 UTC

### Stream C — `tracker_data.created_via` backfill (Week 1, ~30 min)

#### C.1 Investigation

1. Confirm M047 introduced the `created_via` column on `tracker_data`.
2. Query: how many rows currently have `created_via IS NULL`? The architecture says ~21. Confirm.

#### C.2 Implementation

1. Run a one-time backfill SQL: `UPDATE tracker_data SET created_via = 'manual_pre_m047' WHERE created_via IS NULL;`
2. Verify zero NULL rows remain.

#### C.3 Acceptance

- Zero NULL `created_via` rows
- No other side effects

### Stream D — Anomaly-confirm workflow (Week 2, ~2-3 days)

This is the largest stream. It also has a customer-visible UI component, so it needs care. Per Section 11 of the architecture, this UI gets enabled for Vero at the end of Week 3 (after the triage call) — not at full cutover. So treat it as a feature being built and shipped, but with the activation flag controlled.

#### D.1 Investigation

1. Read the current `anomaly_alerts` schema. The architecture lists columns as: `id, org_id, business_id, alert_type, severity, title, description, metric_value, expected_value, deviation_pct, period_date, is_read, is_dismissed`. **Verify each column exists.** If any is missing or has a different name, stop and flag it.
2. Read `app/api/alerts/route.ts` carefully — understand the existing PATCH handler's body schema (`{ id, action }`), the existing actions (`dismiss`, `mark_read`), and the org-scoping logic.
3. Read `app/alerts/page.tsx` — understand the existing button row pattern (around line 125-136 per the review). Note the action handlers, state management, and styling conventions.
4. Read `lib/alerts/detector.ts` — confirm the `alert_type` values used (`revenue_drop`, `revenue_spike`, `staff_cost_spike`, etc.). Confirm there is **no** `metric` column on `anomaly_alerts` and **no** plans to add one. The reconciler in Piece 1 will use `alert_type IN (...)`.

#### D.2 Migration

Create `migrations/MXXX_anomaly_confirmation_workflow.sql`:

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

Run against prod. Verify all existing rows default to `confirmation_status='pending'`.

#### D.3 API extension

Extend `app/api/alerts/route.ts` PATCH handler:

```typescript
// Existing actions: 'dismiss', 'mark_read'
// New actions: 'confirm', 'reject'
//
// Body: { id, action, notes? }
// notes is only used for 'confirm' and 'reject'

if (action === 'confirm' || action === 'reject') {
  await supabase.from('anomaly_alerts')
    .update({
      confirmation_status: action === 'confirm' ? 'confirmed' : 'rejected',
      confirmed_at: new Date().toISOString(),
      confirmed_by: auth.userId,
      confirmation_notes: body.notes ?? null
    })
    .eq('id', body.id)
    .eq('org_id', auth.orgId);
}
```

Auth scoping: any org member can confirm/reject. Match the existing dismiss/mark_read auth pattern exactly.

#### D.4 UI

In `app/alerts/page.tsx`:

1. Add two buttons to the action row, alongside dismiss/mark_read:
   - **Confirm button** label: `Yes — exclude from baseline predictions`
   - **Reject button** label: `No — this was a normal day`
   - On click: open a small modal/dialog with optional notes textarea, then call PATCH with `action: 'confirm'` or `'reject'` and `notes` if provided
   - Buttons hidden when `confirmation_status` is already `'confirmed'`, `'rejected'`, or `'auto_resolved'`
2. Add a status badge to each alert row showing current `confirmation_status`:
   - 'pending' → no badge
   - 'confirmed' → green badge with checkmark icon, label `Confirmed`
   - 'rejected' → gray badge, label `Rejected as normal`
   - 'auto_resolved' → blue badge, label `Auto-resolved`
3. Add a status filter dropdown above the alerts list: `All | Pending | Confirmed | Rejected | Auto-resolved`
4. Add a tooltip on the confirm button: `Marks this day as a real one-time event so future predictions don't treat it as typical.`

**The UI is gated** behind a feature flag — `PREDICTION_V2_ANOMALY_CONFIRM_UI`. See Stream F below for the flag infrastructure. The flag defaults to OFF, but flips ON for Vero at the end of Week 3.

#### D.5 OB-supplement detector tuning

Separately within this stream, fix the OB-supplement false-alarm pattern:

1. Read `lib/alerts/detector.ts` — find the OB-supplement detection logic. Per the investigation, it compares 7-day vs 28-day baselines and fires daily because the recent week is materially above the older 4 weeks once a step change happens.
2. **Adapt the detector** to recognize step-changes: if the last 14 days are all materially above the older 14 days, treat that as a new normal rather than continuing to flag it as anomalous. Implementation approach: add a "step-change detected" exception that, once detected, auto-resolves the daily alert (`confirmation_status = 'auto_resolved'`) rather than firing a new alert.
3. Backfill: for Vero's 7 existing OB-supplement alerts, mark `confirmation_status = 'auto_resolved'` if they fit the step-change pattern. Otherwise leave as `'pending'` for the operator triage call.

This is a silent improvement (per Section 11). Document in changelog.

#### D.6 Acceptance

- Migration applied; all existing alerts default to `pending`
- PATCH endpoint accepts `confirm` and `reject` actions; org-scoped; updates correctly
- UI buttons appear when flag is ON; hidden when OFF
- Status badge and filter work correctly
- OB-supplement detector no longer fires daily false alarms for Vero's step-change pattern
- Vero anomaly triage runbook is documented (next stream)

### Stream E — Vero anomaly triage runbook (Week 3, ~30 min documentation + 30 min call)

#### E.1 Documentation

Create `docs/operations/vero-anomaly-triage-runbook.md` covering:

1. Background: why we need to triage existing alerts
2. List of Vero's existing 11 alerts (query and paste at time of run)
3. Step-by-step: for each alert, decide confirm or reject; record decision and rationale
4. Post-triage: verify all 11 have `confirmation_status` ≠ `'pending'`

#### E.2 Execution

Schedule a 20-30 minute call with Vero's operator. Walk through each alert. Click confirm or reject in the UI. Record outcomes in the runbook.

This is a deployment step, not just a code task. Don't skip it — without operator triage, the contamination filter has nothing to filter on for the Phase 1 shadow period.

### Stream F — Pre-instrumentation migrations + feature flag wrapper (Week 3, ~1 day)

#### F.1 DDL-only migrations

Create the following migrations. **DDL only — no data inserted yet.** These are pre-laid for later pieces.

```sql
-- migrations/MXXX_business_cluster_columns.sql
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS cuisine TEXT,
  ADD COLUMN IF NOT EXISTS location_segment TEXT,
  ADD COLUMN IF NOT EXISTS size_segment TEXT,
  ADD COLUMN IF NOT EXISTS kommun TEXT;

-- For Vero specifically, populate manually:
UPDATE businesses
SET cuisine = 'italian',
    location_segment = 'city_center',
    size_segment = 'medium',
    kommun = '0180'
WHERE id = '<vero_business_id>';
```

```sql
-- migrations/MXXX_business_cluster_membership.sql
CREATE TABLE business_cluster_membership (
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  cluster_dimension TEXT NOT NULL,
  cluster_value TEXT NOT NULL,
  manually_set BOOLEAN DEFAULT FALSE,
  set_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (business_id, cluster_dimension, cluster_value)
);

CREATE INDEX idx_cluster_lookup ON business_cluster_membership (cluster_dimension, cluster_value);

-- No RLS for v1 — admin-only writes for now. Add RLS when this becomes user-facing.
```

```sql
-- migrations/MXXX_school_holidays.sql
CREATE TABLE school_holidays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kommun TEXT NOT NULL,
  lan TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (kommun, start_date, name)
);

CREATE INDEX idx_school_holidays_lookup ON school_holidays (kommun, start_date, end_date);
```

#### F.2 Feature flag wrapper

Create `lib/featureFlags/prediction-v2.ts`:

```typescript
import { isAgentEnabled } from '../is-agent-enabled';

// All PREDICTION_V2_* flags follow the same per-business config pattern as is-agent-enabled.ts.
// Default OFF for all flags; OFF for new customers.
// Flips happen in admin UI per business.

export const PREDICTION_V2_FLAGS = [
  'PREDICTION_V2_ANOMALY_CONFIRM_UI',
  'PREDICTION_V2_OWNER_EVENTS_UI',
  'PREDICTION_V2_DASHBOARD_CHART',
  'PREDICTION_V2_SCHEDULING_PAGE',
  'PREDICTION_V2_MONDAY_MEMO',
  'PREDICTION_V2_EXPORTS',
  'PREDICTION_V2_LLM_ADJUSTMENT',
  'PREDICTION_V2_ACCURACY_VIEW'
] as const;

export type PredictionV2Flag = typeof PREDICTION_V2_FLAGS[number];

export async function isPredictionV2FlagEnabled(
  businessId: string,
  flag: PredictionV2Flag
): Promise<boolean> {
  // Read from per-business config table; default false
  // Use the same backing storage as is-agent-enabled.ts
  return await getBusinessFlag(businessId, flag, /* default */ false);
}
```

The implementation should follow the existing `is-agent-enabled.ts` pattern exactly. If that file uses an environment variable + per-business override, mirror that. If it uses a database flag table, mirror that.

#### F.3 Acceptance

- All four migrations applied; tables/columns exist; no data populated except Vero's cluster columns
- `lib/featureFlags/prediction-v2.ts` exists and `isPredictionV2FlagEnabled()` returns `false` for any flag/business combination unless explicitly set
- Admin UI to flip flags per business — if there's an existing admin UI for `is-agent-enabled.ts`, extend it; otherwise this can be deferred to Piece 1 (don't block Piece 0 on it)

---

## What NOT to do

- Do NOT change customer-visible UI except the three documented exceptions (weather lift values, OB false-alarm reduction, anomaly-confirm buttons after Vero triage). These three are bug fixes, not features.
- Do NOT implement `dailyForecast()`, the audit ledger, or any other Piece 1+ work. Stay scoped to foundation.
- Do NOT add new tables beyond what's specified above. School holidays gets DDL only; no scraper, no data.
- Do NOT modify `lib/forecast/recency.ts`. The consolidated forecaster (Piece 2) extends it — Piece 0 doesn't touch it.
- Do NOT modify the legacy weather-demand or scheduling-AI forecasters' core logic. The weather_daily fix re-engages logic that's already there; it's not a logic change.
- Do NOT delete `app/api/cron/forecast-calibration/route.ts`. Just remove from vercel.json + add deprecation comment.
- Do NOT skip the Vero anomaly triage call. Without it, the contamination filter has no data.

---

## What to flag and pause for

If during investigation you find any of the following, **stop and report rather than proceeding:**

1. A column referenced in this prompt or the architecture doc doesn't exist on the table claimed
2. A file path or function name is different from what's referenced
3. M015 was applied but `weather_daily` table is empty for unexpected reasons
4. The legacy demand-forecast route has unexpected dependencies that would break if `weather_daily` data shifts
5. The OB-supplement detector pattern is more complex than the architecture describes
6. The existing alerts page UI is structurally different from "action button row at line 125-136"

For each, write up what you found and what the architecture got wrong. Halt the implementation and wait for direction. Don't try to invent a fix on the fly — the architecture review pattern exists to catch these and updates the spec.

---

## Style guidance

- Match existing codebase conventions for naming, file structure, error handling, logging
- Use existing patterns — `is-agent-enabled.ts` for flags, ops alert channel for alerts, M020 for migration patterns
- Comments should explain WHY, not WHAT. The architecture doc explains what; the code should explain why this implementation was chosen
- Every new file gets a header comment linking back to the architecture section it implements (e.g. `// See PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md Section 5 — Capture and reconciliation`)

---

## Acceptance gates (overall)

Piece 0 is complete when:

- [ ] `weather_daily` is populated with ≥3 years of historical data for Vero
- [ ] Demand outlook day cards on the dashboard show non-default lift factors
- [ ] `forecast-calibration` cron is removed from `vercel.json` and no longer runs
- [ ] All 21 pre-M047 `tracker_data` rows have non-null `created_via`
- [ ] `anomaly_alerts` has `confirmation_status`, `confirmed_at`, `confirmed_by`, `confirmation_notes` columns
- [ ] `/api/alerts` PATCH accepts `confirm` and `reject` actions
- [ ] `/alerts` page shows confirm/reject buttons + status badges + status filter (when flag is ON)
- [ ] Vero's anomaly-confirm UI flag (`PREDICTION_V2_ANOMALY_CONFIRM_UI`) is ON
- [ ] Vero's 11 existing alerts have all been triaged (no `pending` rows for events more than 14 days old)
- [ ] OB-supplement detector no longer fires daily false alerts for Vero
- [ ] `business_cluster_columns`, `business_cluster_membership`, `school_holidays` migrations applied
- [ ] Vero's cluster columns populated as `('italian', 'city_center', 'medium', '0180')`
- [ ] `lib/featureFlags/prediction-v2.ts` exists and works
- [ ] All other `PREDICTION_V2_*` flags are OFF for Vero
- [ ] Changelog entry documents the three silent improvements

---

## Testing approach

The codebase has no test runner configured (per the v2 review). For Piece 0:

- Manual verification of each acceptance gate
- Live integration testing in staging if a staging environment exists; in dev otherwise
- Smoke test of the existing dashboard, alerts page, scheduling page after each change to confirm no regressions
- Document each test step in a runbook so it's repeatable

Setting up vitest can be a follow-up task; don't block Piece 0 on it.

---

## Output

A working Piece 0 implementation merged to the appropriate branch with:

1. All migrations applied to prod
2. All code merged
3. Feature flags configured per acceptance gate
4. Changelog entry
5. Vero anomaly triage runbook documented
6. A short markdown report at the repo root: `PIECE-0-COMPLETION-REPORT-2026-05-XX.md` summarizing what was done, what wasn't (and why), and any open questions surfaced during implementation

The completion report is the input to writing the Piece 1 implementation prompt. Don't skip it.
