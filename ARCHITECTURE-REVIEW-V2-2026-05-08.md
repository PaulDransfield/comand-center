# Architecture Review V2 — Prediction System (2026-05-08)

> Read-only critique of `PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v2.md` against codebase reality.
> Reviewer: Claude (Opus 4.7, 1M context). Time-budgeted ~70 min.
> Compares against v1 review at `ARCHITECTURE-REVIEW-2026-05-08.md`.

**TL;DR:** v2 fixes most of v1's hard failures, but reintroduces one and adds two new ones — a non-existent `metric` column on `anomaly_alerts` (worse than v1's `status` bug, because v2 spent the work to expand Piece 0 around the right table but still fabricated a column on it), an RPC signature drift from M020 (missing `security definer` + `grant`), and a UI claim ("alert pill expansion with confirm/reject buttons") that doesn't fit the actual `DashboardHeader.tsx` component, which is a one-line link with no expansion affordance. The sign-off is **WITH-CONDITIONS** — Piece 0 can ship after a small set of doc edits.

---

## Section 1 — v1 review checklist resolution

### v1 §9 — "What's wrong (most important)"

| # | v1 issue | Status in v2 | Evidence |
|---|---|---|---|
| 9.1 | `anomaly_alerts.status = 'confirmed'` column does not exist | **PARTIAL** | v2 adds proper `confirmation_status` workflow at lines 807-819 — the `status` bug is fixed. But v2 §5 reconciler at line 747 introduces `AND metric = 'revenue'` against a column that **also doesn't exist** (`anomaly_alerts` has `alert_type` and `metric_value`, no `metric`). Net: the original column-name bug is gone, but a new sibling column-name bug is in. See §9.1 below. |
| 9.2 | yoy_same_weekday claim Vero has it (false; Vero starts 2025-11-24) | **RESOLVED** | v2 §4 #1 line 506-519 explicitly says "Vero's first positive-revenue day is 2025-11-24. Available 2026-11-24 onwards." Sequencing reflects this: line 630 lists the code path as Week 8 with `yoy_same_weekday.available: false` until 2026-11. Substitute YoY same-month from `monthly_metrics` (16 months) is now the interim signal. Honest. |
| 9.3 | weather_daily missing in prod | **RESOLVED** | v2 line 596-603 schedules M015 application + 2-3 year Open-Meteo backfill in Piece 0 (Week 1). Existing backfill pattern at `app/api/admin/weather/backfill/route.ts` is suitable to mirror — v2 doesn't reference it explicitly but the implementation prompt can. |
| 9.4 | `inputs_snapshot` schema invented `recent_4_weeks_same_weekday` etc. that don't exist | **RESOLVED** | v2 §2 line 200-313 captures the actual `recency.ts` concept (`recent_28d_samples`, `recency_multiplier_applied: 2.0`). Adds `snapshot_version` to allow legacy/consolidated coexistence (line 297-311). |
| 9.5 | reconciler divides by zero on closed Sundays | **RESOLVED** | v2 §5 line 757-769 explicitly handles `actual.revenue === 0` with `error_pct = NULL` and `resolution_status = 'unresolvable_zero_actual'`. New enum value added at line 122. |
| 9.6 | Monday Memo `computeDemandForecast` direct import not staged | **RESOLVED** | v2 line 472-477 lists 4 consumers and stages each as a separate PR; line 474 explicitly calls out `lib/ai/weekly-manager.ts:17,327`. Phase B switchover order: dashboard → scheduling page → Monday Memo last. |
| 9.7 | `crons/X.ts` paths don't exist (Next.js App Router) | **RESOLVED** | v2 Appendix A line 1503-1525 uses `app/api/cron/<name>/route.ts` consistently. |
| 9.8 | `fetchOwnerFlaggedEvents` references no infra | **RESOLVED** | v2 adds Piece 4.5 at line 1339-1347 and explicitly sequences it BEFORE Piece 4 (line 1379). The LLM prompt at line 947 still calls `fetchOwnerFlaggedEvents` but the table now has a migration entry, an API route, and a UI component listed in Appendix A. |
| 9.9 | `forecast_calibration.dow_factors` left dangling | **RESOLVED** | v2 §3 line 486-488 explicitly deprecates: "the consolidator's per-weekday rolling baselines... replace what `forecast_calibration.dow_factors` was attempting. The buggy cron at `/api/cron/forecast-calibration` is turned off in Piece 0." `vercel.json` cron entry removal is called out at line 1528. |
| 9.10 | $2/biz/month framing as "negligible" | **RESOLVED (partial)** | v2 §6 line 1023-1037 rebuilds at $0.008/call × ~10 calls/biz/day → ~$2.40/biz/month. Acknowledges this is 5× the current Vero AI bill — though the doc doesn't directly say that, the new line 1037 ("Higher than v1 but still tractable") matches v1 review's framing concern. |

### v1 §10 — Must-fix recommendations

| # | v1 must-fix | Status in v2 | Evidence |
|---|---|---|---|
| M1 | Replace `anomaly_alerts.status = 'confirmed'` with real predicate | **PARTIAL** | The column itself is now real (Piece 0 adds it). But the reconciler query at line 747-749 uses `metric = 'revenue'` — column does not exist. See §9.1. |
| M2 | Add `org_id` + RLS + retention RPC matching M020 | **PARTIAL** | `org_id` ✓, RLS read policy ✓, retention RPC name ✓, **but** the RPC body at line 155-167 differs from M020 in three ways: `LANGUAGE plpgsql` (M020 = `language sql`), no `security definer set search_path = public`, and **no `grant execute on function ... to service_role`**. The cron may fail or run with wrong permissions. See §4. |
| M3 | Define unique-constraint idempotency | **RESOLVED** | v2 line 126-127 unique key is `(business_id, forecast_date, surface)`; line 186-197 spells out `ON CONFLICT … DO UPDATE SET`. `first_predicted_at` preserved on insert; `predicted_at` updates per call. Clean. |
| M4 | Correct yoy_same_weekday Vero claim | **RESOLVED** | See 9.2 above. |
| M5 | Specify legacy snapshot subset | **RESOLVED** | v2 §2 line 297-313 defines `legacy_v1` snapshot as strict subset of `consolidated_v1`. `snapshot_version` discriminator added. |
| M6 | Fix path names in Appendix A | **RESOLVED** | All `app/api/cron/<name>/route.ts`. |

### v1 §10 — Should-fix

| # | v1 should-fix | Status in v2 |
|---|---|---|
| S7 | Backfill strategy for Vero's 145 days | **RESOLVED with caveat** — v2 §5 line 657-700 specifies a backfill walking Vero's 145 days through `dailyForecast({ skipLogging: true, asOfDate })`. The `asOfDate` option is named but not designed (see §6). |
| S8 | Once-per-day truncation | **RESOLVED** — `ON CONFLICT DO UPDATE` semantics; line 645-654 spells it out. |
| S9 | fetchOwnerFlaggedEvents — Piece 4.5 | **RESOLVED** — added as Piece 4.5. |
| S10 | LLM graceful degradation | **RESOLVED** — line 911-912 explicitly says "fall back to consolidated_daily prediction with no `llm_adjusted` row written"; line 1088-1096 expands on it. |
| S11 | dow_factors decision | **RESOLVED** — deprecated. |
| S12 | MAPE-by-horizon column | **RESOLVED** — `prediction_horizon_days INTEGER GENERATED ALWAYS AS (forecast_date - first_predicted_at::date) STORED` at line 102-103. Note `STORED` is required for use in indexes; v2 has it. |
| S13 | Sunday 02:00 conflict | **RESOLVED** — moved to Sunday 01:30 UTC, line 1104. Verified open in `vercel.json`. |
| S14 | master-sync 05:00 vs 06:00 header lie | **NOT RESOLVED** | v2 doesn't address the misleading comment in `app/api/cron/master-sync/route.ts`. Trivial, not blocking. |
| S15 | Cost projection at realistic input size | **RESOLVED** — v2 §6 line 1009-1037 rebuilds at 5,500-6,500 input tokens with summarization, plus rate-limit considerations at line 1040-1046. |
| S16 | Monitoring + alerting + retention | **RESOLVED** — line 862-880 wires stale-pending alerter to existing ops channel. Retention RPC present (with caveats above). |

### v1 §10 — Nice-to-have

| # | v1 nice-to-have | Status in v2 |
|---|---|---|
| N17 | Klämdag + 25th in holiday module | **PUNTED (acceptable)** — separate signal files at `lib/forecast/signals/klamdag.ts` etc. (Appendix A line 1488-1492). Style preference. |
| N18 | Feature flag wrapper around `dailyForecast()` | **NOT RESOLVED** | v2 line 1083 references existing `is-agent-enabled.ts` pattern for the LLM kill switch, but no per-business feature flag specifically for the consolidated forecaster itself. Should add. |
| N19 | Pre-populate Vero cluster | **RESOLVED** — line 1243 explicitly: "Vero gets pre-populated as `('italian', 'city_center', 'medium')` manually." |
| N20 | Snapshot test | **NOT RESOLVED** | No mention. There's no test runner in `package.json` (verified — no `vitest`, no `jest`, no `"test"` script). Setting one up is a multi-day decision the doc doesn't make. |

**Resolution scorecard:** Of v1's must-fix list (6 items), 4 RESOLVED, 2 PARTIAL. Of v1's should-fix (10 items), 9 RESOLVED, 1 NOT RESOLVED. Net: solid progress, but the two PARTIAL must-fixes are real and gate the implementation prompt.

---

## Section 2 — Anomaly-confirm workflow validation

### 2.1 ALTER TABLE clean fit

The migration at v2 line 807-819 adds 4 columns + 1 index to `anomaly_alerts`. Existing schema per `MIGRATIONS.md:331`: `id, org_id, business_id, alert_type, severity, title, description, metric_value, expected_value, deviation_pct, period_date, is_read, is_dismissed`.

**Conflicts:** None. `confirmation_status`, `confirmed_at`, `confirmed_by`, `confirmation_notes` are all new names. `is_dismissed` and `confirmation_status` are orthogonal — dismissal is "I read this," confirmation is "yes that was a real one-time event." v2 is correct that they shouldn't be conflated. Fine.

### 2.2 Existing rows on migration

Vero has 11 unread/non-dismissed alerts including 7 OB-supplement spikes (per investigation). With `DEFAULT 'pending'` they all migrate cleanly. **v2 doesn't address what the dashboard does with them.** Right now the dashboard pill renders the top high/critical alert (`DashboardHeader.tsx:35`); after the migration, all 11 stay `pending` and the pill keeps firing nightly — same behavior as today. No regression, but no progress either until the operator confirms or rejects each one. v2 should call out that for Vero specifically, the operator needs a one-time triage pass after Piece 0 ships, otherwise the contamination filter has nothing to filter on.

### 2.3 API endpoint namespace inconsistency

v2 line 822-823:
> `POST /api/anomalies/:id/confirm`
> `POST /api/anomalies/:id/reject`

But the existing route is `app/api/alerts/route.ts` — see file content. The existing PATCH at lines 36-58 takes `{ id, action }` body and handles `dismiss` and `mark_read` actions, scoped by `org_id`. v2 introduces a new namespace `/api/anomalies/` while the existing namespace is `/api/alerts/`. `app/alerts/page.tsx:35` and `components/ui/SidebarV2.tsx:146` both fetch from `/api/alerts`.

**Implication:** v2 either creates a duplicate endpoint family (`/api/alerts/*` for dismiss, `/api/anomalies/*` for confirm — operator-confusing for whoever writes ops scripts) OR it should extend the existing PATCH `/api/alerts` action set with `confirm` / `reject`. The existing pattern is cleaner. v2 should either justify the namespace split or adopt the existing one.

Recommendation: extend `app/api/alerts/route.ts` PATCH with `confirm` and `reject` actions, write a new POST handler if a body schema with `notes` is needed, but keep namespace `/api/alerts/`.

### 2.4 Dashboard pill needs real rework

v2 line 826-829:
> Dashboard alert pill: when expanded, shows two buttons in addition to dismiss — "Yes, this was real (don't use for predictions)" and "No, the prediction was wrong"

`components/dashboard/DashboardHeader.tsx:31-50` renders the pill as `<a href="/alerts" className="cc-dash-header-pill">…</a>` — a one-line link with no expand affordance. There is no dismiss button on the pill today. The pill is a navigation control, not an interactive widget. Adding two confirmation buttons "when expanded" would require either:

- Converting the `<a>` into a popover/dropdown component with a body that fetches alert details and shows actions (~1 day work), OR
- Adding the buttons to `app/alerts/page.tsx` instead (where they belong — that page already has the dismiss/mark-read buttons at line 125-136), and leaving the dashboard pill as a link.

v2's spec at line 1474 says "Existing dashboard alert pill component (add confirm/reject buttons)". This underestimates the UI work. The buttons are easy in `app/alerts/page.tsx` (matches the existing action-button row pattern); they're a meaningful refactor in the dashboard pill. The 2-3 day Piece 0 estimate needs to either include the popover work or commit to "buttons on `/alerts`, not on the pill."

### 2.5 RLS / authorization on confirm endpoints

Existing PATCH at `app/api/alerts/route.ts:50-54` filters by `.eq('org_id', auth.orgId)` — any org member can dismiss/mark-read. v2 doesn't say who can confirm. By the existing pattern, any org member can. That's probably fine, but the `confirmed_by UUID REFERENCES auth.users(id)` column wants to record the actual actor. Implementation needs `req.user.id` from auth. Not specified in v2.

### 2.6 Reconciler `metric = 'revenue'` is a column-not-found bug

**v2 line 743-749:**
```sql
SELECT 1 FROM anomaly_alerts
WHERE business_id = $1
  AND period_date = $2
  AND metric = 'revenue'
  AND confirmation_status = 'confirmed'
```

**Codebase reality:** `anomaly_alerts` has no `metric` column. Per `MIGRATIONS.md:331` the columns are `id, org_id, business_id, alert_type, severity, title, description, metric_value, expected_value, deviation_pct, period_date, is_read, is_dismissed`. The `inputs_snapshot` example at line 286-292 also references `confirmation_status = 'confirmed'` with no metric filter — but the reconciler query has `metric = 'revenue'`.

The actual revenue-typed alert is `alert_type IN ('revenue_drop', 'revenue_spike')` (per `lib/alerts/detector.ts:303`). Other alert types are `staff_cost_spike`, `food_cost_spike`, `dept_spike`, `ob_spike` (per `archive/notes/claude_code_agents_prompt.md:200`).

**Fix:** v2's reconciler should use `AND alert_type IN ('revenue_drop', 'revenue_spike')` — OR Piece 0 should add a `metric` column normalizing `alert_type` to `'revenue' | 'staff_cost' | 'food_cost' | …`. The doc must pick one.

This is the v1 `status = 'confirmed'` bug rebuilt one column over. Same class of error — fabricating a column name without checking the schema. Surprising given v1 review explicitly walked through `anomaly_alerts` columns at v1 §9.1.

---

## Section 3 — Owner-flagged events (Piece 4.5) validation

### 3.1 Schema fit with LLM prompt

v2 line 1342: `owner_flagged_events (business_id, event_date, event_type, description, expected_impact_direction, expected_impact_magnitude, created_at, created_by)`.

The LLM prompt structure at line 936-983 ingests `upcoming_context.owner_flagged_events` as a free-form JSON block. The schema fits — the LLM can read structured event records and reason about them. `expected_impact_direction` (presumably 'up'|'down'|'neutral') and `expected_impact_magnitude` (presumably 'small'|'medium'|'large' or numeric %) are operator-supplied hints that help the LLM avoid having to infer.

**Gap:** v2 doesn't define the value enum for `expected_impact_direction` or `expected_impact_magnitude` (a CHECK constraint, ENUM, or free text). For a UI-driven form this matters — implementer needs to know which select options to render. Not a blocker but a should-fix.

### 3.2 Calendar/date-picker patterns

I did not find an existing reusable date-picker component in the codebase. `components/dashboard/OwnerEventFlag.tsx` (Appendix A line 1509) would be net-new. Existing date inputs use plain `<input type="date">` (e.g. budget pages). That's fine for v1 of the widget. **Uncertain — would need to verify by inspecting the budget UI** that there's no shared component being missed.

### 3.3 Multi-tenant RLS pattern matches?

v2 doesn't include the DDL for `owner_flagged_events` (only mentions it in §9 and Appendix A). The implementation prompt must specify: org_id NOT NULL + ON DELETE CASCADE, business_id NOT NULL + ON DELETE CASCADE, RLS read+write policies that org members can SELECT/INSERT/UPDATE/DELETE their own org's rows. Should mirror M020 + add an INSERT policy (since this is owner-driven, unlike `daily_forecast_outcomes` which is service-role write only).

### 3.4 Re-adjustment trigger mechanics

v2 line 921: "A new owner-flagged event has been added/removed for forecast_date" triggers re-adjustment.

**Mechanically what watches for this?** Three options the doc doesn't pick between:
1. The owner-event POST endpoint synchronously calls into `dailyForecast()` for affected horizon dates and re-runs LLM adjustment. Latency: ~5-10s for the LLM call.
2. A pg_cron NOTIFY listener, or a queue table that the existing extraction-sweeper-style cron processes every 2 minutes.
3. The next dashboard refresh sees a dirty flag and triggers re-computation.

Option (1) is simplest, has no new infra, but blocks the operator's UI on the LLM call. Option (3) is lazy but means the operator clicks "save event" and doesn't see the prediction update for an unknown duration.

Recommendation for the implementation prompt: option (1) with an async background-task pattern (return 200 immediately, fire LLM call via `waitUntil` or a queue insert). v2 should pick this and spell it out.

---

## Section 4 — Schema delta validation vs M020

| Item | M020 | v2 daily_forecast_outcomes | Match? |
|---|---|---|---|
| `org_id NOT NULL REFERENCES organisations ON DELETE CASCADE` | line 16 | line 83 | ✓ |
| `business_id NOT NULL REFERENCES businesses ON DELETE CASCADE` | line 17 | line 84 | ✓ |
| RLS enable | line 76 | line 142 | ✓ |
| RLS read policy `org_id IN (SELECT org_id FROM organisation_members WHERE user_id = auth.uid())` | line 80-83 | line 144-150 | ✓ (verbatim) |
| Retention RPC `prune_*` returning `int` | line 98-111 | line 155-167 | **partial** — see below |
| `language sql` + `volatile security definer set search_path = public` + `grant execute on function ... to service_role` | line 100-103, 113 | `LANGUAGE plpgsql`, no security definer, no grant | **DRIFT** |
| 3-year retention window | `interval '3 years'` on `created_at` | `INTERVAL '3 years'` on `forecast_date` | semantic difference: M020 prunes by row creation date; v2 prunes by forecast date. For a daily-grain table this is correct (we want to retain by what the row predicts). OK. |

**The retention RPC drift is a real bug for cron callers.** M020's `security definer set search_path = public` is the standard safety pattern — the cron job calls the RPC, but the RPC executes under the function owner's privileges (service-role) regardless of who invoked it, with a fixed search_path so a hostile schema can't shadow `daily_forecast_outcomes`. v2 omits both. Worse, no `grant execute` means service_role might still work (depends on default schema grants) but anon and authenticated will not — and if some future ops dashboard tries to call the RPC it'll fail silently.

Fix: v2's RPC body should be:
```sql
create or replace function prune_daily_forecast_outcomes()
returns int
language sql
volatile
security definer
set search_path = public
as $$
  with deleted as (
    delete from daily_forecast_outcomes
    where forecast_date < current_date - interval '3 years'
    returning 1
  )
  select coalesce(count(*)::int, 0) from deleted;
$$;

grant execute on function prune_daily_forecast_outcomes() to service_role;
```

That's M020's pattern verbatim, adapted for the new column.

### Generated column validity

`prediction_horizon_days INTEGER GENERATED ALWAYS AS (forecast_date - first_predicted_at::date) STORED` — Postgres 12+ supports `STORED` generated columns; Supabase runs PG15. The `forecast_date - timestamp::date` subtraction yields an integer (days). Valid.

### `unresolvable_zero_actual` enum value

The CHECK constraint at line 119-124 explicitly lists `'pending', 'resolved', 'unresolvable_no_actual', 'unresolvable_data_quality', 'unresolvable_zero_actual'`. New table, no consumers — no breakage. ✓

### M020 SELECT policy for service-role writes

v2 line 152: comment "No client-side INSERT/UPDATE/DELETE — service role only." Postgres service_role has BYPASS RLS by default in Supabase, so this works without an explicit policy. M020 added an UPDATE feedback policy for owners (line 88-92) — v2 doesn't need that yet because owners don't write to `daily_forecast_outcomes`. Fine for v1.

**Summary:** The retention RPC drift is the only material divergence. Two-line fix.

---

## Section 5 — Cost & rate-limit projection

### 5.1 "Summarized recent_reconciliation" — mechanically achievable?

v2 line 1016-1019:
> recent_reconciliation_summary (90 rows summarized to top patterns + headline stats): ~3,000 tokens

**The summarization mechanism is not specified.** "Summarize 90 rows" is hand-wavy. Two real options:
- Compute deterministic stats client-side: weekly MAPE, MAPE-by-weekday, MAPE-by-horizon, 5 worst-error-days with attribution. Output is structured JSON, easy to estimate at ~1,500 tokens.
- Pre-summarize via a separate Haiku call that runs nightly and caches the output.

Option 1 is what should be in the implementation prompt. Option 2 doubles the LLM call count without adding much value. v2 should commit to deterministic summarization and reframe the 3,000-token estimate accordingly. As written it's unverifiable.

### 5.2 ~10 calls/business/day cap

v2 line 1027-1028: "with the change-driven activation, average ~10 calls/business/day".

The triggers at line 919-923:
1. Previous llm_adjusted row >24h old
2. Weather forecast changed materially (>2°C or precipitation flip)
3. Owner-flagged event added/removed
4. New active pattern promoted
5. New anomaly confirmed in last 7 days

In practice: trigger (1) fires once per (forecast_date) per day, so 14 horizon dates × 1 = 14 baseline calls if the cron just refreshes everything every 24h. Triggers (2)-(5) add incremental fires. The "10 calls/business/day average" assumes triggers (2)-(5) compress (1). That only works if the 14-day refresh is staggered AND change-aware, not "fire at 07:30 daily for all 14 horizons." v2 doesn't specify the scheduler.

**Realistic worst case:** 14 calls/business/day baseline + 2-3 weather-change triggers + occasional owner events = ~18 calls/biz/day. ~$4.30/biz/month, not $2.40. Still tractable. v2's "~10" is optimistic but defensible if the implementation prompt schedules the 14-day refresh as "1 horizon per day, rotating" rather than "all 14 every day." Should be specified.

### 5.3 Stagger + batch API specs

v2 line 1043-1046:
> Stagger activation: spread the 14-day horizon refresh across an hour. 50 customers × 14 calls / 60 min = ~12 calls/min.
> Use Anthropic's Message Batches API for non-urgent re-adjustments.

These are aspirational. v2 doesn't specify:
- Where the staggering happens (per-business cron offset, in-memory queue, pg_cron staggered fires?)
- How the batch API integrates with `logAiRequest` (batch responses arrive minutes later — does the audit row write at submission or at receipt?)
- Whether the same-day re-adjustments (2-5 above) bypass the batch path

For N=1 (Vero) it doesn't matter. For the implementation prompt at N=1 these are nice-to-haves that get specified later. Note as a "must-design before N≥20" item, not a Piece 0 blocker.

### 5.4 Anthropic API health check

v2 line 911-912:
> Anthropic API health check passes — if Anthropic is unreachable, fall back to consolidated_daily prediction with no llm_adjusted row written

There is no existing health-check infra. The codebase has `lib/ai/usage.ts` for cost tracking and `lib/ai/is-agent-enabled.ts` for kill switches but no liveness probe.

**Realistic implementation:** wrap the LLM call in a try/catch; on timeout (e.g. 10s) or 5xx, log and skip. No separate health check needed — the call IS the health check. v2 over-specifies. Implementation prompt should fold this into the `lib/forecast/llm-adjustment.ts` graceful-degradation block.

---

## Section 6 — Sequencing realism

### 6.1 Piece 0 timeline — 2-3 days for anomaly-confirm UI is optimistic

v2 line 1276-1283 sequences Piece 0's anomaly-confirm work across "Weeks 2-3 (parallel tracks)" in the Week 1-3 Piece 0 window.

Tasks in the workflow:
- Migration (column adds + index): 1 hour
- POST /api/anomalies/:id/confirm + reject (or extend /api/alerts PATCH): 0.5 days
- UI changes:
  - If buttons go on `/alerts` page (recommended): existing button row at `app/alerts/page.tsx:125-136` extends with two more buttons + state. ~0.5 day.
  - If buttons go on the dashboard pill: convert link to popover, fetch alert details, render action row. ~1.5-2 days.
- Existing alerts list: confirmed badge (~30 min), status filter (~1 hour).
- Documentation (operator-facing copy, internal docs): ~0.5 day.

**Realistic total: 2-3 days IF the buttons go on the alerts page only.** 4-5 days if also adding the dashboard pill popover. v2's "~2-3 days" envelope holds for the alerts-page-only approach; the dashboard popover is a stretch.

### 6.2 Open-Meteo backfill mirroring `fortnox-backfill-worker`?

`fortnox-backfill-worker` is a 12-month workers-pattern backfill at `app/api/cron/fortnox-backfill-worker/route.ts`. The existing weather backfill at `app/api/admin/weather/backfill/route.ts` is a one-shot admin-secret-protected POST handler that loops businesses → fetches Open-Meteo historical data → upserts to `weather_daily`.

For 2-3 years of weather data per business, the existing weather backfill works — just call it with a longer date range (it already pulls from `firstRev?.date` which would be 2025-11-24 for Vero; for backfill we'd want to pre-date that to 2023). The implementation prompt should extend `app/api/admin/weather/backfill/route.ts` to accept a `start_date` query param overriding `firstRev.date`. ~1 hour change. v2 over-allocates "Week 1" for this. Realistic: 30 minutes of code + however long Open-Meteo takes to serve (rate-limited, but bandwidth-bound, not algorithmically hard).

### 6.3 `dailyForecast({ asOfDate })` sequencing

v2 line 700:
> dailyForecast() needs an asOfDate option for backfill — it must compute predictions using only the data that was available at that point in time.

**This is non-trivial.** Every input source has to be filterable by "data as of date":
- `daily_metrics` — needs `WHERE date <= asOfDate` on the rolling window queries
- `monthly_metrics` — same
- `weather_daily` — needs `WHERE fetched_at <= asOfDate` if we want to honor that we didn't have today's forecast 30 days ago. Currently `weather_daily` has `created_at`/`updated_at` but no `fetched_at` semantics for forecast-vs-observed delineation.
- `anomaly_alerts` — needs `WHERE created_at <= asOfDate`. Has `created_at` ✓.
- `forecast_calibration` — pre-deprecation only — needs `updated_at <= asOfDate`. Has `updated_at` ✓.
- `holiday calendar` — pure compute, time-invariant. ✓
- `school_holidays` — time-invariant for dates in the past.

The hard one is `weather_daily`. Currently the table has one row per `(business_id, date)` UNIQUE constraint with `is_forecast` boolean. Backfill of historical data via Open-Meteo writes `is_forecast=false` for all of it. So the backfill **cannot honestly answer "what would the forecast have been on 2026-04-14 for 2026-04-15?" — we never stored the forecast as it was 24h ahead**. We only have actual weather post-hoc. This is a data-leakage problem v2 doesn't address.

**Two ways out:**
1. Accept limited-honesty backfill: use observed weather for `weather_lift` even in `asOfDate` mode. Document that the backfilled audit data has slightly better-than-real-life weather forecast accuracy. MAPE comparisons across backfilled vs live data are not strictly comparable.
2. Skip weather backfill: backfill audit rows without weather signal. MAPE-by-weather-bucket is then unmeasurable for the backfilled period.

v2 implies (1) without saying so. The implementation prompt for Piece 2 needs to spell this out — otherwise the consolidator's MAPE on backfilled days will look too good and we'll over-trust the audit ledger.

This is a **design question, not a 1-day implementation.** Should be explicitly listed as an open decision in §10 if it isn't already. v2 §10 doesn't include it.

### 6.4 Phase B switchover — 4 PRs in Week 10 is tight

v2 line 1318-1323 puts batch 1 of new signals + Phase B switchover in Weeks 9-10. The Phase B switchover alone is 4 separate PRs:
1. `/api/scheduling/ai-suggestion` route
2. `/api/weather/demand-forecast` route
3. Monday Memo (`lib/ai/weekly-manager.ts:17,327`)
4. Export/report templates

Each needs feature flag, A/B comparison, rollback plan. Doing 4 in one week alongside three new signals (YoY same-month, YoY same-weekday, klämdag, salary cycle) is unrealistic. The line at 1329 hedges: "Phase B Monday Memo switchover lands here if not done in Week 10" — that's fine, but the doc should commit to a slip rather than treating it as conditional. **Recommendation:** split Phase B switchover off from signal additions; allocate 1.5 weeks for the four PRs. Total then 19-20 weeks not 18-19.

### 6.5 Piece 4.5 (Week 15) before Piece 4 (Weeks 16-17)

v2 line 1377-1379 confirms the order. Correct — LLM prompt at line 947 references `fetchOwnerFlaggedEvents`, so Piece 4.5 must precede Piece 4. ✓

---

## Section 7 — Open decisions cross-check

v2 §10 lists 9 open decisions (A-I). Cross-check against what v1 had:

**v1 → v2 closed:** 7 items (parallel schema, UI loudness, customer-facing claim, sequencing interleave, anomaly predicate, logging frequency, owner-flagged events).

**Hidden decisions v2 treats as settled but should flag:**

1. **`anomaly_alerts.metric` column add or `alert_type` filter.** v2's reconciler uses `metric = 'revenue'` (line 747) but the column doesn't exist. Adding a `metric` column is its own decision (DB migration, new field for the detector to populate, semantic mapping `'revenue_drop' → 'revenue'`). Or you accept `alert_type IN (...)`. v2 picks one without saying so. Should be explicit.

2. **Backfill weather data leakage.** As above (§6.3) — v2 backfills audit rows using observed weather as if it were forecast weather. This is a methodological choice with MAPE consequences. Should be in §10.

3. **Owner-flagged events trigger mechanism.** Sync POST or async queue (§3.4). Affects Piece 4.5 implementation effort.

4. **`/api/anomalies/*` vs `/api/alerts/*` namespace.** v2 picks `/anomalies/` without justification. Existing pattern is `/alerts/`. Either namespace is defensible; the choice should be explicit, not silent.

5. **`expected_impact_direction` / `expected_impact_magnitude` value enums.** Free text vs CHECK constraint vs ENUM. UI form depends on the answer.

6. **Vero one-time anomaly triage.** After Piece 0 ships, the 11 existing alerts are `pending`. Operator must triage them before the contamination filter has anything to work with. Not in §10 but should be documented as a deployment runbook step.

**Pattern auto-promotion** is in v2 §10 as Decision I. ✓

**Vero cluster pre-population:** v2 line 1243 commits to a manual SQL update — fine, documented.

**`forecast_calibration` deprecation:** `accuracy_pct` and `bias_factor` are kept (written by M020 reconciler at `app/api/cron/ai-accuracy-reconciler/route.ts`); only `dow_factors` is dead. Implication: the M020 reconciler still updates the table, but nothing reads `dow_factors`. Verified from `app/api/cron/forecast-calibration/route.ts` — the cron itself is being disabled, but `accuracy_pct`/`bias_factor` are written elsewhere by `ai-accuracy-reconciler`. Should be safe.

---

## Section 8 — Newly missing items

### 8.1 Migration ordering

v2 lists 7 new migrations in Appendix A (line 1478-1484) but doesn't sequence them. Foreign key dependencies:

1. `MXXX_anomaly_confirmation_workflow.sql` — alters existing table, no FK dep
2. `MXXX_business_cluster_columns.sql` — alters existing table
3. `MXXX_business_cluster_membership.sql` — depends on `businesses` (existing) and possibly clusters table
4. `MXXX_daily_forecast_outcomes.sql` — depends on `organisations` + `businesses` (existing)
5. `MXXX_school_holidays.sql` — independent
6. `MXXX_owner_flagged_events.sql` — depends on `businesses`, `organisations`, `auth.users` (all existing)
7. `MXXX_forecast_patterns.sql` — depends on `organisations` + `businesses`

No cross-migration FK deps within the new set. Order doesn't strictly matter, but for the implementation prompt: run anomaly_confirmation FIRST (Piece 0), then daily_forecast_outcomes (Piece 1), then the others as their pieces are built. Should be documented in v2 §9.

### 8.2 Concurrent execution

What happens when `consolidated_daily`, legacy `scheduling_ai_revenue`, AND `llm_adjusted` all try to insert rows for the same `(business, forecast_date)` from concurrent callers in Phase A?

`UNIQUE (business_id, forecast_date, surface)` means three different `surface` values produce three different rows — no conflict. ✓

Within a surface, two concurrent calls for the same `(business, date, surface)` hit the unique constraint and the second falls through to the `ON CONFLICT DO UPDATE` path. ✓

Race: caller A reads `inputs_snapshot`, caller B writes a newer row, caller A's write overwrites with stale data. In practice the dashboard refreshes are sub-second apart and the snapshot is computed each call from current data, so "stale" here just means "0.2 seconds older." Not a real risk.

### 8.3 Skolverket scraper

v2 line 1497 lists `lib/skolverket/scraper.ts` but the doc body never specifies:
- Schedule (`schedule: '0 4 1 * *'` — monthly, per Appendix A line 1523-1525)
- Source URL or API
- Error handling when Skolverket changes format
- What happens when scrape fails — fallback to last-known data?

Skolverket publishes school holiday data per municipality. There's no stable API; the scraper is HTML-based. Format changes break it silently. v2's monthly cadence is fine for stability (monthly check, fail-fast email), but "scrape Skolverket" is not a one-day task. Realistic: 2-3 days for a scraper that handles 290 kommuner across 5 holiday types. Or use a stable third-party data source (likely none).

### 8.4 Operator-facing copy for anomaly confirm

v2 line 827:
> "Yes, this was real (don't use for predictions)" and "No, the prediction was wrong"

These are mental-model crossed. "Yes this was real" = the OWNER confirms the spike was a real event. The system should THEN exclude it from baseline (because real one-time events shouldn't drag the rolling average). "No, the prediction was wrong" = the system flagged it as anomaly but it wasn't — so it SHOULD be in the baseline (normal day, miscalibration).

The button labels:
- "Yes, this was real" → confirmation_status='confirmed' → exclude from baseline. Label is right.
- "No, the prediction was wrong" → confirmation_status='rejected' → include in baseline. Label is wrong — "the prediction was wrong" is what the OPERATOR thinks; the system would call this "false alarm." Better label: "No, this was a normal day" or "Reject — not a real event."

Operator copy needs translation work (Swedish + English). Implementation prompt should include the actual button text. v2 hand-waves.

### 8.5 Synthetic second business for testing

Vero is the only customer. The cluster machinery (cuisine, location_segment, size_segment, `business_cluster_membership`) is locked in but inactive at N=1. There's no integration test for cluster joins. When customer #5 lands (potentially mid-2027 at current pace), the cluster code will be hit for the first time in production.

**Recommendation:** create a `seed/synthetic_business.sql` that inserts a fake business into a separate test org, with synthetic `daily_metrics` rows, for use in dev/staging. ~1 day work. Lets you verify cluster machinery works before customer #5. Not a Piece 0 blocker — note as a future TODO.

---

## Section 9 — What's wrong (still)

### 9.1 anomaly_alerts.metric — column does not exist

**v2 line 743-749:**
```sql
SELECT 1 FROM anomaly_alerts
WHERE business_id = $1
  AND period_date = $2
  AND metric = 'revenue'
  AND confirmation_status = 'confirmed'
```

**Codebase:** `anomaly_alerts` columns per `MIGRATIONS.md:331`: `id, org_id, business_id, alert_type, severity, title, description, metric_value, expected_value, deviation_pct, period_date, is_read, is_dismissed`. Plus the v2 Piece 0 additions (`confirmation_status`, `confirmed_at`, `confirmed_by`, `confirmation_notes`). No `metric`.

**Implication:** Same class of error as v1's `status = 'confirmed'` bug — the reconciler crashes with `42703 column does not exist` on first run for any `pending` row whose forecast_date had any anomaly_alert at all. Anomaly contamination filtering does not work.

**Fix options:**
- A: Use `alert_type IN ('revenue_drop', 'revenue_spike')` instead. No migration. Mirrors `lib/alerts/detector.ts:303`.
- B: Add a `metric TEXT` column in Piece 0 alongside `confirmation_status`, populated by trigger or detector update mapping `alert_type → metric`. Requires updating `lib/alerts/detector.ts` to populate the new column AND a backfill SQL.

(A) is faster and adequate. (B) is cleaner but doubles the Piece 0 scope. Pick (A) for v1.

### 9.2 prune_daily_forecast_outcomes RPC drift

**v2 line 155-167:**
```sql
CREATE OR REPLACE FUNCTION prune_daily_forecast_outcomes()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$ ... $$;
```

**M020 line 98-113:**
```sql
create or replace function prune_ai_forecast_outcomes()
returns int
language sql
volatile
security definer
set search_path = public
as $$ ... $$;
grant execute on function prune_ai_forecast_outcomes() to service_role;
```

**Implication:** Cron job invoking the RPC may fail with permission errors (if grant is missing) or run with caller's privileges instead of definer's. The pattern was deliberately chosen for M020 to work with Supabase's anon-key + service-role split.

**Fix:** Adopt M020's pattern verbatim. Two-line change.

### 9.3 Dashboard pill UI underspecified

**v2 line 826-829:** "Dashboard alert pill: when expanded, shows two buttons in addition to dismiss…"

**Codebase:** `components/dashboard/DashboardHeader.tsx:31-50` — pill is a one-line `<a href="/alerts">` link. No expansion. No dismiss button.

**Implication:** "When expanded" doesn't describe a state that exists. Implementation must either (a) build a popover (~1.5 days extra), or (b) move the buttons to `app/alerts/page.tsx` (~0.5 day, fits existing pattern), or (c) leave the dashboard pill as-is and surface a notification ("Confirm 11 pending anomalies →") that links to the alerts page. v2 should pick one.

### 9.4 LLM prompt asks for `fetchUpcomingHolidays` that may not exist

**v2 line 943:**
```typescript
const upcomingContext = {
  holidays_next_14d: await fetchUpcomingHolidays(14),
  ...
}
```

`lib/holidays/sweden.ts` exposes `getHolidaysForCountry(country, year)` and `getUpcomingHolidays(country, fromDate, daysAhead)` per CLAUDE.md session 15 invariants. So the function exists at `lib/holidays/index.ts::getUpcomingHolidays`, but v2 names it `fetchUpcomingHolidays`. Cosmetic — implementation prompt should use the right name. Not a blocker.

### 9.5 Audit rows for "predicting yesterday now" not separated

v1 review §3 raised this. v2 accepts the truncate-to-once-per-day model, which mostly resolves it: a single row per `(business, forecast_date, surface)` per day. But a dashboard call that requests `from=2026-04-15&to=2026-04-15` (back-test of yesterday's prediction with today's data) will still write `predicted_at = NOW()` and `forecast_date = 2026-04-15`, making `prediction_horizon_days = forecast_date - first_predicted_at::date`. If this is the FIRST call for that (business, 2026-04-15, surface), `first_predicted_at = NOW()` and `prediction_horizon_days = -23` (negative). The MAPE-by-horizon index would now contain negative values. The reconciler would still run, but MAPE-by-horizon includes back-tests as if they were predictions.

**Implication:** v2 needs a guard at write time: if `forecast_date < CURRENT_DATE`, skip the audit insert (it's a backtest, not a prediction). Or write but with a flag. Not a blocker but the implementation prompt should include the guard.

### 9.6 `daily_metrics.revenue` integer precision

v2 line 96-97:
```sql
predicted_revenue INTEGER NOT NULL,
baseline_revenue INTEGER,
```

This now matches `daily_metrics.revenue INTEGER` (M008 line 16). ✓ Fixes v1's precision footgun.

But: error_pct at line 116 is `NUMERIC(8,4)` — fine. Implementation must round predicted to integer at write time. v2 §3 line 419 explicitly says "Round to integer" in step 6 of the computation logic. ✓

---

## Section 10 — Recommendations

### Must-fix (block Piece 0 implementation prompt)

1. **Replace `metric = 'revenue'` in v2 §5 reconciler with `alert_type IN ('revenue_drop', 'revenue_spike')`.** Edit lines 743-749. Same column-name class of bug as v1's `status = 'confirmed'`. Without this fix the contamination filter throws `42703` on first run.

2. **Adopt M020's retention RPC pattern verbatim for `prune_daily_forecast_outcomes`.** Edit lines 155-167 to use `language sql` + `volatile security definer set search_path = public` + add `grant execute on function ... to service_role`. Two-line change.

3. **Resolve the dashboard pill UI spec.** Either commit to "buttons land on `/alerts` page only, dashboard pill stays a link" (recommended — fits existing component, matches the action-row pattern at `app/alerts/page.tsx:125-136`), or commit to building a popover (~1.5 days extra in Piece 0). Edit lines 826-829 to be explicit.

### Should-fix (clarify before writing the implementation prompt)

4. **Pick API namespace.** Either extend `app/api/alerts/route.ts` PATCH with `confirm`/`reject` actions (recommended, matches existing dispatch pattern), or commit to the `/api/anomalies/*` namespace and explain why. Edit Appendix A path list at line 1499-1500.

5. **Specify the `asOfDate` data-leakage decision for backfill.** Either backfill audit rows using observed weather as forecast (with a documented MAPE caveat), or skip weather signal in backfill rows. v2 §10 should add this as Decision J.

6. **Specify owner-event re-adjustment trigger mechanism.** Sync POST + waitUntil background fire (recommended), or queue insert + 2-min cron sweep. Affects Piece 4.5 effort estimate.

7. **Add operator-facing button copy in spec.** Replace "No, the prediction was wrong" with "No, this was a normal day" or similar — current text confuses the operator's mental model.

8. **Document the Vero one-time anomaly triage as a Piece 0 deployment step.** 11 existing alerts default to `pending`; operator must triage them or contamination filter has nothing to filter on.

9. **Pin Phase B switchover to its own ~1.5 week window.** Total project length goes from 18-19 to 19-20 weeks. Realistic.

10. **Specify deterministic `recent_reconciliation_summary` (client-side stats, not LLM-summarized).** Edit §6 line 1016-1019 to commit to weekly MAPE + MAPE-by-weekday + MAPE-by-horizon + 5-worst-days as a structured JSON block computed in TS, not an LLM call.

11. **Spell out `expected_impact_direction` / `expected_impact_magnitude` value enums for `owner_flagged_events`.** Implementation prompt and UI form depend on it.

12. **Update master-sync header comment.** Trivial, but `app/api/cron/master-sync/route.ts` says "Runs at 06:00 UTC daily" while `vercel.json:5` schedules `0 5 * * *`. Fix the comment.

### Nice-to-have

13. **Add a synthetic second business for cluster testing.** Seed file + dev runbook. ~1 day work.

14. **Per-business feature flag for `dailyForecast()` itself.** Not just LLM kill switch — full consolidator A/B per business.

15. **Snapshot test for `inputs_snapshot` JSONB.** Conditional on adding a test runner (vitest preferred). ~2 days for runner + first test.

16. **Specify migration ordering in Appendix A.** Current list is unordered.

17. **Add Skolverket scraper effort estimate.** 2-3 days realistic; current Week 13 sequencing assumes a 1-day task.

---

## Section 11 — Sign-off

> **Is v2 ready to base implementation prompts on?** **WITH-CONDITIONS**

The architecture is sound. v2 fixes 9 of v1's 10 hard-failure items, schema parity with M020 is 80% there, the sequencing is realistic, the cost projection is grounded, and the new pieces (anomaly-confirm workflow, owner-flagged events, deprecating dow_factors) are mechanically right. Direction is correct; ship it.

**Gating items before writing the Piece 0 implementation prompt:**

1. **Edit v2 §5 reconciler query** (line 747): replace `AND metric = 'revenue'` with `AND alert_type IN ('revenue_drop', 'revenue_spike')`. Five characters; one-paragraph diff. Without this Piece 0 ships a broken reconciler the day Piece 1 lands.

2. **Edit v2 §2 retention RPC** (line 155-167): adopt M020's `language sql + volatile security definer set search_path = public` body and add `grant execute on function prune_daily_forecast_outcomes() to service_role`. Verbatim from M020 with the table name changed.

3. **Edit v2 §5 dashboard UI spec** (line 826-829): commit to "confirm/reject buttons land on `/alerts` page; dashboard pill remains a link" — this is the right call for fit with existing `DashboardHeader.tsx`. (Or, if you want the popover, allocate +1.5 days to Piece 0 estimate.)

These three edits are <30 minutes of doc work. Once made, Piece 0 implementation prompt can be written against v2 directly. The remaining should-fix items (4-12 above) can be resolved during implementation prompt drafting — they're clarifications, not contradictions.

If the three edits aren't made, **do not write the Piece 0 prompt yet.** Implementing `metric = 'revenue'` against a table with no `metric` column wastes 4-6 hours of debug time the next time someone runs the migration end-to-end.

---

## Section 12 — What I didn't get to

- Did not deep-dive the `lib/weather/demand.ts:289-308` bucket-correlation math to confirm `weather_lift_factor` semantics line up between v2 §2 inputs_snapshot (`{ factor: 1.08, samples_used: 14, min_samples_met: true }`) and the actual `byBucket` map. **Uncertain — would need to read demand.ts:289-340 carefully** to confirm the field names map.

- Did not verify that the existing `app/api/admin/weather/backfill/route.ts` accepts a `start_date` override; if not, extending it is part of Piece 0 effort. **Uncertain — would need to verify by reading the full backfill route.**

- Did not validate that the `business_cluster_membership` schema referenced in v1 (and inherited into v2) is consistent with the new `cuisine`/`location_segment`/`size_segment` columns added directly to `businesses`. v2 §8 line 1241-1244 mentions both. There may be a duplicate-storage problem (cluster fields on `businesses` AND in a membership table). Not investigated.

- Did not check the Anthropic Tier 2 RPM/TPM numbers cited at v2 line 1041. Documented as "1000 RPM and ~80k input tokens/min for Haiku 4.5" — plausible at current pricing but I did not confirm against Anthropic's published rate-limit table.

- Did not verify that v2's `/api/cron/daily-forecast-reconciler/route.ts` 07:30 UTC slot stays open after the existing 07:00 cron (`ai-accuracy-reconciler` + `fortnox-backfill-worker`) finishes. Both are bounded to 60s default; reconciler scope is small. Should be fine, but I didn't time the existing crons to confirm.

- Did not assess privacy-policy implications of adding owner-flagged events as a new owner-supplied data field. Probably benign (no PII), but `LEGAL-OBLIGATIONS.md` should be reviewed before Piece 4.5 ships.

- Did not investigate whether `lib/forecast/recency.ts` use of mid-day UTC (`+ 'T12:00:00Z'`) vs `lib/weather/demand.ts:424-437` use of local-time `setHours(0,0,0,0)` causes drift in current production for any specific date or weekday. v2 line 588-590 calls this out and picks ISO mid-day UTC for the consolidator, which is the right call. I didn't measure existing damage.

- Did not enumerate every `est_revenue` consumer beyond what's already in v2 line 472-477 (4 named). There may be 1-2 export templates or admin views that bind to the legacy shape.

---

> Review complete. No code changed. No commits. Single file at `C:\Users\Chicce\Desktop\comand-center\ARCHITECTURE-REVIEW-V2-2026-05-08.md`.
