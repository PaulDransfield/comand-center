# Architecture Review — Prediction System (2026-05-08)

> Read-only critique of `PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08.md` against codebase reality.
> Reviewer: Claude (Opus 4.7, 1M context). Time-budgeted ~120 min.

The document is well-structured and the *direction* is sound (math-first, LLM-on-top, audit ledger as the foundation). It also has a few specific factual errors about the existing codebase that, if implemented as written, will break things or pollute the audit log on day 1. Most damaging: a SQL filter against an `anomaly_alerts.status = 'confirmed'` column that does not exist, and an `inputs_snapshot` schema that ignores the recency-weighted weighting parameters and the bucket-key indexing already used by both legacy forecasters.

---

## Section 1 — Schema validation

### `daily_forecast_outcomes` vs M020's `ai_forecast_outcomes`

The doc's case for a parallel table is reasonable on volume / cadence grounds. But the proposed DDL drops several patterns that M020 standardised and which the rest of the platform relies on:

1. **Missing `org_id`**. M020 has `org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE` (M020-AI-FORECAST-OUTCOMES.sql:16) and the RLS read policy is org-scoped:
   ```sql
   org_id in (select org_id from organisation_members where user_id = auth.uid())
   ```
   The proposed `daily_forecast_outcomes` only carries `business_id`. RLS on a business-only table is doable (join to `businesses.org_id`) but it's slower per-row, and *every other tenant-scoped table in the codebase carries `org_id` at the top level* — `daily_metrics`, `monthly_metrics`, `tracker_data`, `staff_logs`, `revenue_logs`, `anomaly_alerts`, `ai_forecast_outcomes`, `ai_request_log`. Adding `org_id` is essentially free and keeps the cross-tenant containment model uniform.

2. **PK type mismatch.** M020 uses `uuid primary key default gen_random_uuid()`. Proposed table uses `BIGSERIAL`. Not load-bearing, but inconsistent with the rest of the schema; `id uuid pk default gen_random_uuid()` would match the existing convention and allow safer external references in error logs without leaking row counts.

3. **Missing RLS / retention parity.** The doc's DDL has no RLS policy block at all and no retention RPC. M020 has both (RLS read + UPDATE-feedback + 3-year `prune_ai_forecast_outcomes()`). For a multi-tenant SaaS that already passed the privacy audit on M020's pattern, omitting RLS is a regression — it ships with default Postgres semantics where service-role queries work but anon-key reads return rows for all tenants. The migration must include parity policies.

4. **Numeric vs integer revenue.** Proposed `predicted_revenue NUMERIC(12,2)` and `actual_revenue NUMERIC(12,2)` — but `daily_metrics.revenue` is `INTEGER NOT NULL DEFAULT 0` (sql/M008-summary-tables.sql:16). This isn't broken (numeric absorbs integers) but means the reconciler can't `UPDATE … = mm.revenue` and have it round-trip; it must `UPDATE actual_revenue = mm.revenue::numeric(12,2)`. The doc never spells this out and it's the kind of footgun that produces a dimensional mismatch the reconciler silently logs and moves past.

5. **`unique_forecast_per_minute` constraint is incompatible with the consolidator's own idempotency story.** The proposed unique key is `(business_id, forecast_date, surface, predicted_at)`. `predicted_at` defaults to `NOW()` so under load two consumers calling `dailyForecast()` within the same millisecond hit a constraint violation, not the "second write returns the existing row" behaviour the doc promises in §5 ("Different consumers reading the same forecast within the same minute is idempotent"). To get that behaviour you need either truncate-to-minute on `predicted_at`, OR a separate `(business_id, forecast_date, surface)` unique with `ON CONFLICT … DO NOTHING RETURNING *` semantics. As written, no idempotency.

6. **`inputs_snapshot` JSONB shape misses real signals already in use** (§3 of this review covers signal feasibility; the schema implication is that the proposed snapshot is an aspirational future shape, not a faithful capture of today's forecasters).

7. **`error_attribution.factor_breakdown` assumes information you may not have.** The reconciler computes `weather_forecast_actual_delta` by calling `fetchWeatherActuals(forecast)` (architecture doc §5). For Vero the actual `weather_daily` table is missing in prod (PGRST205 per the investigation). The reconciler will null-fill that field on every Vero row for the foreseeable future. The doc never describes this graceful degradation, and the JSONB assumes it always succeeds.

8. **`unresolvable_data_quality` references anomaly contamination, but the lookup cannot work.** See §2 below for the column-name error. The CHECK accepts the value, the WRITE will never fire.

### Recommended schema deltas (minimum viable)

- Add `org_id uuid not null references organisations(id) on delete cascade`.
- Add full RLS block matching M020 (read by org member, no client UPDATE except service-role).
- Add `prune_daily_forecast_outcomes()` RPC + retention cron entry (3y matches M020; daily-grain volume could push toward a shorter retention or partitioning — discuss).
- Either drop `predicted_at` from the unique constraint, or DEFAULT it to `date_trunc('minute', now())`. Don't half-promise idempotency.
- `predicted_revenue` and `actual_revenue` both INTEGER (matching `daily_metrics.revenue`). Round at write time. Or commit to numeric throughout.

---

## Section 2 — Code path validation

| Doc claim | Reality | Status |
|---|---|---|
| `app/api/scheduling/ai-suggestion/route.ts` exists, produces `est_revenue` | Yes, file exists, 217-403 lines of pure-math logic. `// @ts-nocheck` at top. No Anthropic import. | OK |
| `app/api/weather/demand-forecast/route.ts` exists, returns `predicted_revenue` | Yes, 56 lines, thin wrapper around `lib/weather/demand.ts::computeDemandForecast`. | OK |
| `lib/forecast/recency.ts` is the place "this consolidates on" | File exists (105 lines, commit `f6029ca` today). Exposes `weightedAvg`, `thisWeekScaler`, `RECENCY` constants. **The doc's `inputs_snapshot.weights_used` (§2) lists `yoy_same_weekday`, `recent_4_weeks`, `recent_8_weeks` — none of these are `recency.ts`'s actual weighting concept** (the actual concept is "recent 28 days × 2.0, older × 1.0"). The doc has invented a weighting scheme that doesn't exist yet, but writes the field as if it's already there. | **MISLEADING** |
| `lib/weather/demand.ts` — "most logic lifted into `dailyForecast()`; this file becomes thin" (Appendix A) | demand.ts is 481 lines. The bucket-correlation logic, holiday gate, this-week scaler logic, `deriveRecommendation`, and `mondayOf`/`sundayOf` helpers all live here. Lifting it into `dailyForecast()` deletes ~70% of demand.ts. The doc undersells this — Appendix A lists demand.ts as "modified", not "lifted". | OK but underestimated |
| Existing M020 reconciler cron at `crons/aiForecastReconciler.ts` | Actual path: `app/api/cron/ai-accuracy-reconciler/route.ts`. The Appendix A name is wrong (no `crons/` directory in this Next.js App Router repo). | **Path wrong** |
| Master-sync 05:00 cron at `crons/dailyMasterSync.ts` | Actual path: `app/api/cron/master-sync/route.ts`. `vercel.json:5` schedule is `0 5 * * *`. The header comment in master-sync/route.ts itself says "Runs at 06:00 UTC daily" which is wrong (the schedule is 05:00). Doc gets the time right but the path is wrong. | **Path wrong** |
| `daily_metrics` exists with `revenue`, `date`, `business_id` | Yes (M008). But `revenue` is `INTEGER`, not numeric. `covers` is INTEGER too — investigation notes 100% of Vero rows have covers=0 because no POS provides covers. | OK with caveats |
| `anomaly_alerts.status = 'confirmed'` filter for "anomaly contamination" | **THIS COLUMN DOES NOT EXIST.** `anomaly_alerts` has `is_dismissed boolean`, `is_read boolean`, `severity text`, `alert_type text`, `period_date date`, `metric_value numeric`, `expected_value numeric`, `deviation_pct numeric` (per detector.ts:9-20 + alerts/route.ts:18-26). There is no `status` column. There is also no `date` column — the date field is `period_date`. Both the doc's `WHERE business_id = $1 AND date = $2 AND status = 'confirmed'` reconciler query (architecture §5) AND the consolidated forecaster's "filter out anomaly-contaminated days" step (architecture §3, step 2) target a schema that does not exist. | **HARD FAILURE** |

### Master-sync timing context

`vercel.json` shows additional crons in the morning window:
- 05:00 UTC — master-sync (`0 5 * * *`)
- 05:30 UTC — anomaly-check (`30 5 * * *`)
- 06:00 UTC — health-check (`0 6 * * *`)
- 06:30 UTC — data-source-disagreements-alert (`30 6 * * *`)
- 06:45 UTC — manual-tracker-audit (`45 6 * * *`)
- 07:00 UTC — ai-accuracy-reconciler **AND** fortnox-backfill-worker (both `0 7 * * *`)
- 06-23 hourly — catchup-sync (`0 6-23 * * *`)

The doc's claim that 07:30 UTC is "after master-sync (05:00) and after the existing AI reconciler (07:00)" is correct, but the doc misses that `fortnox-backfill-worker` also fires at 07:00, AND that catchup-sync runs every hour from 06:00 — so the daily_metrics table can be touched at 07:00, 08:00, 09:00, etc. up to 23:00 UTC for late-arriving data. Reconciliation at 07:30 captures yesterday's revenue but may miss late-day corrections; reconciliation snapshots based on the 07:30 read could later disagree with the data the customer sees at 09:00 if a catchup-sync re-aggregated something. Doc doesn't address this.

---

## Section 3 — Migration realism

### Phase A → B → C feasibility

**Phase A (shadow mode).** Mostly fine. The two legacy forecasters are stateless transformations from `daily_metrics` → response payload — instrumenting them to ALSO insert into `daily_forecast_outcomes` is a few lines per file. Two complications the doc skips:

1. **Caller frequency.** The doc says (§5): "We *want* to log every prediction generation, not just the first of the day." The dashboard re-calls `/api/scheduling/ai-suggestion` and `/api/weather/demand-forecast` on every load with `Cache-Control: no-store, max-age=0, must-revalidate` (`route.ts:48` for demand-forecast). For an active operator hitting the dashboard 20× a day across 7 forecast days that's 140 audit rows per business per day from one caller alone, all with effectively identical inputs, all needing reconciliation. The doc's cost projection assumes 14 calls/business/day. Reality is closer to 14 × refresh-count. Either truncate inserts to once-per-day-per-(business,date,surface), or build the reconciler to deduplicate. The doc does neither.

2. **Predictions in the past.** The investigation notes that `/api/scheduling/ai-suggestion` accepts `from`/`to` query params and produces predictions for arbitrary date ranges including the past (used by the dashboard chart for current-week pull-forward). Logging every call without distinguishing "predicting tomorrow" from "regenerating yesterday's prediction now" pollutes the audit ledger with rows whose `predicted_at > forecast_date` — these aren't real predictions, they're back-tests. The doc never separates `forecast_date` semantics (date being predicted) from `prediction_horizon_days` (days between predicted_at and forecast_date). Without that distinction, MAPE-by-horizon (§1 secondary metric) cannot be computed.

**Phase B (switchover).** Riskier than the doc admits.

3. **Dashboard `OverviewChart` consumes `pred.est_revenue` and `effectiveAiCost(d)` directly** (`components/dashboard/OverviewChart.tsx:202, 218, 237`). The chart's predicted-revenue bars and the labour-prediction line both come from `/api/scheduling/ai-suggestion`. If `dailyForecast()` returns a slightly different number (and it will — different weighting, new signals), every customer who has memorised "Tuesday usually predicts ~28k" gets a discontinuity. No callout in §3's Phase B list.

4. **Monday Memo prompt embeds `computeDemandForecast()` output directly** (`lib/ai/weekly-manager.ts:17,327` per investigation). The memo prompt sees a full DemandForecast block. If `dailyForecast()` replaces this, the memo prompt structure changes, and the memo's tone/recommendations may shift. This is operator-facing — the customer reads it weekly. Phase B should staged switchover for the memo separately from the dashboard.

5. **`scheduling/page.tsx` (full-page scheduling AI panel)** also reads `est_revenue` per `app/scheduling/page.tsx`. Listed in Appendix A as "modified" but the propagation isn't called out.

6. **`computeWeekStats` (`components/scheduling/computeWeekStats.ts`)** reads `est_revenue` to compute weekly aggregates shown in the scheduling sidebar. Switchover changes those numbers.

**Phase C (deprecation).** The doc says "stop logging the legacy surfaces, keep the lib functions in case we want to re-enable for comparison." Realistic. The library functions are called from `lib/ai/weekly-manager.ts:17` directly (not through HTTP), so removing them requires both deleting the route AND updating the memo to call `dailyForecast()` instead. Doc lists this once but doesn't sequence the memo switch separately.

### "Log to legacy surfaces for one more month after Phase B" (architecture §3)

This is in conflict with Phase C. If you switch the dashboard to read from `dailyForecast()` in Phase B but keep both legacy forecasters running for logging (just not for display), you're paying their compute cost for a month with no consumer. For demand.ts that's the bucket-correlation query (~365-day join across `weather_daily × daily_metrics`) on every dashboard load. Acceptable but undersold. You'd want the legacy code to short-circuit to "compute, log, return null" — the doc doesn't spec this.

---

## Section 4 — Signal feasibility

### 1. yoy_same_weekday

**Reality:** Vero has 145 days of positive `daily_metrics.revenue` (first day 2025-11-24 per investigation §11). Today is 2026-05-08. To do same-weekday-last-year for 2026-05-09 (Saturday), you'd want 2025-05-10 (Saturday). Vero has no positive-revenue daily_metrics that far back — the first positive day is 6.5 months later. **YoY same-weekday lookup returns "no data" for every Vero forecast date until 2026-11-24 at the earliest** (when same-weekday-last-year is 2025-11-25, the second positive day).

The doc's text: "Vero has this" (architecture §4 #1) is **wrong** based on the investigation. The investigation explicitly flagged: "Vero only has ~5.5 mo of positive `daily_metrics` so YoY same-day is not yet possible from daily — but YoY same-MONTH IS possible from `monthly_metrics`" (§6). The architecture doc inverted this finding.

**Implication:** the highest-impact new signal in the architecture's plan is unavailable for the only customer for ~6 more months. Should be flagged as "starts contributing 2026-11" in the sequencing.

### 2. klämdag detection

**Reality:** The holiday module exposes `kind ∈ {public, observed}` and `impact ∈ {high, low, null}` (`lib/holidays/sweden.ts:23-24`). `kind` is bank-holiday-ness, not a klämdag flag. Klämdag is computable from the calendar — the doc's pseudocode is correct.

**Caveat:** the doc claims "Klämdag if adjacent to holiday and weekend forms a 4-day stretch" — but that's a 3-day stretch (Thu holiday + Fri klämdag + Sat + Sun = 4 days off, but the *klämdag itself* is 1 day). The pseudocode is right; the prose is slightly wrong. Cosmetic.

**The min-sample claim ("2 prior klämdag observations for this business") is unrealistic.** Sweden has ~3-4 klämdag candidates per year. With 5.5 months of Vero positive data (2025-11-24 → today), Vero has crossed maybe 1-2 klämdag candidates total. The 2-observation threshold may not be met until late 2027. Doc should default to a national/cluster-level prior immediately — or the signal will be `factor=1.0` (i.e. silent) for years.

### 3. School holidays

**Reality:** No `school_holidays` table, no Skolverket scraper, no region column on `businesses`. The investigation §6 already flagged this as "Light external" effort.

**Effort estimate the doc skips:** Skolverket publishes `lov` (school holidays) per municipality (`kommun`), not per `län` (county). Sweden has 290 municipalities. The doc proposes a `region` column with values like `'STHM'` and `'GBG'` — this is the län shorthand, not the kommun shorthand, and it's the wrong granularity for actually scraping Skolverket. Mappings:

- **Sportlov** (winter break): published per kommun in 7 consecutive weeks (vecka 7-13). Most Stockholms län kommuner take vecka 9 but not all. Salem and Nykvarn often differ.
- **Höstlov** (autumn break): nearly uniform vecka 44 nationally; minor exceptions.
- **Påsklov, Sommarlov, Jullov**: ~99% national uniformity.

A correct implementation needs `business → city → kommun → school_break_calendar` resolution. `businesses.city` is a free-text string today (`lib/weather/forecast.ts:86` shows `'stockholm'` as a known coords entry; nothing maps city → kommun). Realistic effort to do this *properly*: ~3-4 days of work, not the "Week 12" slot the doc proposes (which assumes an existing region mapping). With shortcuts (assume vecka 9 sportlov, vecka 44 höstlov), 1 day — but you'd be wrong for 5-15% of cases.

**The doc's "min samples: 1 prior occurrence" is impossible for sportlov** until the customer has been on the platform for >1 year — same trap as YoY same-weekday. For Vero, sportlov 2026 (vecka 9, Feb 23 – Mar 1) was *before* sufficient daily data accumulated. Sportlov 2027 is the first time Vero gets a "prior occurrence." Until then, default value or null.

### 4. Salary cycle (25th)

**Reality:** Date math only. Confirms — `lib/forecast/recency.ts` does ISO date handling using `new Date(dates[i] + 'T12:00:00Z')` consistently. Mid-day-Z is robust to TZ confusion. `lib/weather/demand.ts:424-437` has its own `mondayOf`/`sundayOf` using `setHours(0,0,0,0)` (local), which is *different* from the recency logic. Mixed conventions. This is a real footgun for the consolidated forecaster — `dailyForecast()` needs one date convention, used everywhere.

**Doc's prose:** "Per-business factor learned over time. Min samples: 30 days of business history." Vero has 145 positive-revenue days; this is plausibly available immediately. But **what does "learned" mean operationally?** The doc never specifies the learner. Linear regression? GAM? Per-day-of-month median? Without a concrete learner, `salary_cycle.factor` in the snapshot is just `1.0` forever. This is left as an exercise.

### 5. weather_change_vs_seasonal

**Reality:** Depends on `weather_daily` having multiple years of history. Per investigation, `weather_daily` is currently MISSING from prod (PGRST205 — table not in PostgREST schema cache). MIGRATIONS.md §M015 lists no "applied" date and the master tracker line at the top says "M022-M047 applied · M048 pending" — M015 is not in that range, suggesting it was never applied or was dropped.

**The doc's Phase A timeline assumes M015 gets fixed in Piece 0 (Weeks 1-2) and history accrues from there.** Even if applied today (2026-05-08) and backfilled for Vero, you'd have 1 year of weather data by mid-2027. The "delta vs 30-day rolling seasonal norm for this calendar date over previous years" needs ≥1 prior year of observations to compute — so the signal is silent until ~2027-05.

**The 365-day backfill via Open-Meteo's `archive-api`** would actually work since Open-Meteo serves historical data going back decades for any lat/lon. The doc could instruct the Piece 0 backfill to pull 2-3 years of historical weather for every business at fix time, which collapses the wait to "as soon as the migration applies." The doc doesn't say this. With it, signal is live within Phase A.

### 6. day_of_month patterns

**Reality:** No existing per-business calibration infra except `forecast_calibration` (one row per business, columns `accuracy_pct`, `bias_factor`, `dow_factors`). `dow_factors` has the documented Sunday=0.009 bug for Vero. The doc proposes new infrastructure — fair, but it should be specified as such.

The doc says "Calibrated from accumulated audit data" without specifying *what calibrates it*. The pattern extraction (§7, weekly job) is the closest mechanism but it's a separate piece. Without an explicit definition of the day-of-month learner, this signal also stays at 1.0.

### Cross-cutting signal feasibility issue

The doc's signal-addition strategy ("Don't add all six at once") and per-signal min-samples table together imply a **silent-default cascade**: each new signal multiplies the baseline by 1.0 until enough data accumulates, but the audit log has no way to distinguish "signal contributed nothing because data was insufficient" from "signal contributed 1.0× as the model's best guess." This is exactly what the audit log was meant to surface, and the architecture undersells it.

The `inputs_snapshot.salary_cycle.factor: 1.0` is indistinguishable from "no salary cycle effect for this business" vs "we don't have enough data to compute one." Fix: every multiplier carries a `samples_used` field so error attribution can subtract "signal was at default" from "signal was applied with low confidence."

---

## Section 5 — Cron timing

### Existing schedule check (verified against `vercel.json`)

| Time (UTC) | Cron | Notes |
|---|---|---|
| 05:00 | master-sync | Pulls last 90d for all integrations |
| 05:30 | anomaly-check | Touches monthly_metrics analysis + writes anomaly_alerts |
| 06:00 | health-check | Light |
| 06:00-23:00 hourly | catchup-sync | Re-aggregates daily_metrics for late data |
| 06:30 | data-source-disagreements-alert | Reads daily_metrics |
| 06:45 | manual-tracker-audit | Reads tracker_data |
| 07:00 | ai-accuracy-reconciler | Reads ai_forecast_outcomes + monthly_metrics |
| 07:00 | fortnox-backfill-worker | Writes tracker_data + retriggers monthly_metrics aggregation |
| 08:00 | onboarding-success | Light |
| 08:00 | ai-daily-report | Reads ai_request_log |

**07:30 UTC slot is open.** Conflict-free.

### Daily_metrics freshness at 07:30

**Today's row exists eagerly with revenue=0 from creation; the actual value lands during the 05:00 master-sync** (per investigation §9: "Today's row exists eagerly with `revenue = 0` until the sync writes the actual"). For *yesterday's* data, the master-sync at 05:00 captures it. So at 07:30, yesterday's actual is reliably in `daily_metrics`. **OK.**

**Edge case the doc misses:** master-sync runs syncs concurrently (CONCURRENCY=10) with 60s per-integration timeout. A single slow integration (PK rate-limited, Fortnox 5xx) can leave one customer's yesterday-row unwritten for hours. Catchup-sync at 06:00 patches most of these but not all in one pass. Reconciler at 07:30 will get "no actual yet, try again tomorrow" for affected customers. This is *fine* (the architecture's `if (!actual) continue` handles it), but the doc never spells out that retries-tomorrow is the expected fallback path, leading to confusion when ops sees rows stuck at `pending` for multiple days.

### Sunday 02:00 UTC pattern extraction

**Existing Sunday workloads:**
- 02:00 — api-discovery
- 03:00 — api-discovery-enhanced
- 03:00 — ai-log-retention
- 03:00 — industry-benchmarks
- 04:00 — invoice-reconciliation

**The 02:00 slot is occupied** (`vercel.json:40-42`: `api-discovery` runs `0 2 * * 0`). Pattern extraction would conflict if both fired simultaneously and both call Anthropic — Vercel Pro lets concurrent crons run, but both share the per-org rate-limit pool from `org_rate_limits`. Doc should pick a different slot — e.g. 01:30 UTC or move api-discovery.

---

## Section 6 — Cost projection sanity check

### Token estimates

The doc's "3,000 input + 400 output tokens per call, $0.005/call" is in the right ballpark for Haiku 4.5, BUT the input estimate is low for what the prompt actually needs to contain:

- `inputs_snapshot` JSONB of the size shown in §2: ~600 tokens
- `recent_reconciliation` for last 90 days at maybe 90 rows × 100 tokens each: ~9,000 tokens — *not 3,000*
- `upcoming_context` (holidays + weather + recent_anomalies + owner_flagged_events + learned_patterns): variable, easily 500-1500 tokens
- `learned_patterns` (active rows from `forecast_patterns` for this business): could be 0 today, several hundred tokens later.

**Realistic input: 8,000-12,000 tokens after a few months of audit data accumulates.** That puts per-call cost closer to $0.012-0.015 not $0.005, before any cache hits. With prompt caching the system prompt is cheap on subsequent calls, but per-business recent_reconciliation is not cacheable across businesses.

**Recalculation at 50 customers, 14 calls/biz/day:** 50 × 14 × $0.012 = $8.40/day = $252/month. Still tractable, but ~12× the doc's estimate at scale. Worth noting.

The "halve cost by caching when nothing changed" optimization is sensible. Doc doesn't say where the cache lives — `runtime_cache`? Supabase row? Per-business JSON column on `daily_forecast_outcomes` itself?

### Anthropic spend tracking

**Already exists.** `lib/ai/usage.ts` writes `ai_request_log` (table) on every Claude call with `request_type`, `model`, `input_tokens`, `output_tokens`, `duration_ms`. There's also `org_rate_limits` (M018) for persistent per-org rate limiting. The doc's "set up Anthropic API spend monitoring before activation" line implies this is greenfield — it's not. New code just needs to call `logAiRequest(db, { request_type: 'forecast_adjustment', ... })` and the existing dashboards will pick it up.

### Rate limits

Anthropic Tier 2 (~$1k/month spend) gives 1000 req/min and 80k input tokens/min for Haiku 4.5. With 14 calls × 50 customers = 700 calls per generation cycle, you're fine on RPM but if the cycle fires synchronously (e.g. all customers at the 07:30 slot), 700 × 12k tokens = 8.4M tokens in ~30 seconds = 16M TPM — **above the per-minute limit**. Need to space out OR use the batch API. Doc doesn't address this.

### 14-calls-per-business-per-day assumption

Doc text: "we generate predictions for the next 14 days. If we adjust each day each morning: 14 calls/business/day". This assumes one LLM call per (business, target_date) per day — i.e. re-adjust every horizon every day. That's wasteful: tomorrow's prediction barely changes vs. yesterday's tomorrow-prediction, except when weather forecast or owner-flag changes. Sensible activation cadence is "adjust on change", not "adjust 14× daily". Doc's own "cost optimization" footnote acknowledges this but doesn't carry through to the activation criteria in §6.

---

## Section 7 — Open decisions cross-check

The 10 open decisions are well-chosen. Hidden decisions the doc treats as settled but should flag:

1. **`predicted_at` semantics under refresh-driven calling.** Each dashboard load triggers a new `predicted_at`. This is implicit but never stated as a decision; per §3 above, this has cost + audit-pollution consequences.

2. **Whether to gate logging on caller identity.** Same call from a cron vs. from a dashboard load is semantically different — the cron is "the daily prediction," the dashboard call is "this user is looking now." Doc treats them as identical.

3. **What `model_version` ties to.** §10 #2 partially addresses this for *consolidated_daily*, but not for `'scheduling_ai_revenue'` and `'weather_demand'` legacy surfaces. They will keep changing under audit. Lock semver on each surface or accept that legacy MAPE comparisons are noisy.

4. **Anomaly-contamination concept.** §3 step 2 uses the term but `anomaly_alerts` doesn't have a `confirmed`/`status` concept. What does "anomaly-contaminated" mean operationally? The owner clicked "yes that was real"? The owner dismissed it? Currently the only owner action is dismiss/mark-read. This is a real product decision the doc skips entirely.

5. **Whether the legacy `forecasts` table (M008) is in or out of scope.** Investigation §11 lists it as pathway #11, with `confidence = 0.75` hardcoded, never reconciled. The architecture doc doesn't mention it. Either it's deprecated by the consolidator or it's left to drift — should be explicit.

### "Decided" things that are actually open

The doc's §3 says weights start at `w_yoy=0.25, w_4wk=0.45, w_8wk=0.30`. These are eyeballed without justification. For Vero specifically, with `recency.ts` already weighting recent 4 weeks 2× older 8 weeks (effective ~57/43 split), the existing model already implicitly sets `w_yoy=0, w_4wk≈0.57, w_8wk≈0.43`. Switching to the new weights changes Vero's prediction **before any new signal lands** — a confounder for the Phase A vs Phase B comparison. Calling out: "weights inherit from `recency.ts`'s current effective ratios and tune over time" would be safer.

Recommendation: bring weight-tuning explicitly into §10's open decisions.

---

## Section 8 — What's missing

### Error handling / failure modes
- **LLM API down:** §6 doesn't say. Implementation must short-circuit to `consolidated_daily` (already a row). Doc should specify graceful degradation.
- **`daily_metrics` row missing for forecast_date at reconciliation:** doc handles this with `unresolvable_no_actual` after 7 days, but the gap between "missing today" and "still missing day 7" is silent — should there be a daily Slack/email when N rows are stuck pending? Not specified.
- **Reconciler crash mid-run:** the doc shows a per-row try/catch implicitly, but the for-loop has no transaction boundary. A crash on row 50/500 leaves rows 0-49 marked `resolved` and 50-499 still `pending`. Idempotent re-run is fine because the WHERE clause filters by `pending` — but the doc never spells this idempotency out.
- **Concurrent calls writing the same row:** the unique constraint will fail (see §1 issue 5). What does the caller do? The doc shows `INSERT INTO daily_forecast_outcomes` but no `ON CONFLICT` clause. Production-grade SQL needs `ON CONFLICT (business_id, forecast_date, surface, predicted_at) DO NOTHING RETURNING id` and behaviour for the "row already exists" case.

### Backfill strategy
- Doc says "the audit ledger must be working from day 1 of every customer's tenure" (§1). No path for backfilling Vero's 145 days of existing positive-revenue history. There IS value in producing "what would consolidated_daily have predicted for 2026-04-15 given data as of 2026-04-14, vs the actual 2026-04-15 revenue" for 90+ days — that's instant Phase A audit data instead of 14 days of waiting. Architecture doesn't propose this. **Should propose a one-time backfill that walks 90 days of history with `dailyForecast({ skipLogging: true })` followed by an inline `INSERT`.**

### Testing strategy
Completely absent. `dailyForecast()` is going to be the most important pure function in the codebase. It needs:
- Unit tests for each multiplier (vitest? jest?) — codebase doesn't have a test runner setup based on the file list. (Uncertain — would need to verify by inspecting `package.json` for test scripts.)
- Snapshot tests for the JSONB shape of `inputs_snapshot`.
- Integration test against a fixture business with known history.

The doc's "After each addition, wait 7-14 days, then check the audit log" is testing in production. Fine for later, terrible for foundational signal additions.

### Monitoring and alerting
- MAPE drift alarm: not specified. After 90 days of `consolidated_daily`, MAPE shouldn't suddenly increase — but the doc has no detector for that.
- Reconciler-failure alarm: doc shows `log.info` patterns matching the existing cron style, but no email/Slack on failure. Existing pattern (see `data-source-disagreements-alert`) emails ops on detected issues — should mirror.
- LLM cost spike alarm: `ai_request_log` exists but no daily-spend threshold. Easy to wire into existing `ai-daily-report` cron.

### Data retention
Doc says nothing. M020 retention is 3 years. With 14 audit rows × 365 days × 50 customers = ~250k rows/year just at 50 customers — manageable but should match M020's policy. **Add `prune_daily_forecast_outcomes()` RPC + cron entry.** Daily-grain volume could justify partitioning by `forecast_date` quarter — not necessary at current scale but worth noting if going to 500+ customers.

### Rollback plan
"If `consolidated_daily` MAPE is worse: investigate why before switching." Not a rollback plan. A rollback plan answers: after Phase B, if customer reports the dashboard numbers look weird and we trace it to a bug in `dailyForecast()`, what's the procedure to revert in <1 hour? Specify: feature flag at the route level, fallback to legacy lib functions which stay in the codebase. Doc gestures at this but doesn't prescribe.

### Multi-tenant isolation
Schema is missing `org_id` (§1 above). Beyond schema: nothing in the architecture says reconciler must scope queries by `org_id` even within service-role calls. Best practice: every query in the reconciler explicitly filters by both `business_id` AND `org_id` — defence-in-depth. Per CLAUDE.md's "Multi-tenant isolation" line, this is a project standard.

---

## Section 9 — What's wrong (most important)

> Format: Doc says X. Codebase has Y. Implication.

### 9.1 anomaly_alerts.status

**Doc says (§3 step 2 + §5 reconciler):** `anomaly_alerts.status = 'confirmed'` filters out anomaly-contaminated days from baseline calculations and from successful reconciliation.

**Codebase has:** `anomaly_alerts` with columns `is_dismissed boolean`, `is_read boolean`, `severity`, `alert_type`, `period_date`, `metric_value`, `expected_value`, `deviation_pct` (per `lib/alerts/detector.ts:9-20`, `app/api/alerts/route.ts:18-26`). No `status` column. Date column is `period_date`, not `date`.

**Implication:** Both queries (baseline filter in §3, reconciler in §5) crash with `42703 column does not exist` on first run. The "anomaly contamination" feature does not work. To make it work, you need to: (a) decide what "confirmed" means operationally — anomaly_alerts has no owner-confirm action today, only dismiss/mark-read; (b) either add a `status` column with explicit owner workflow, or treat `is_dismissed = false AND severity IN ('high','critical')` as the contamination predicate; (c) rename `date` → `period_date` in every query. This is a real product decision the architecture skips.

### 9.2 yoy_same_weekday is unavailable for Vero

**Doc says (§4 #1):** "Vero has this" referring to 12+ months of `daily_metrics` history.

**Codebase has:** Vero's first positive-revenue day in `daily_metrics` is 2025-11-24 (per investigation §11). For 2026-05-09 the same-weekday-last-year is 2025-05-10 — six months before any positive data exists.

**Implication:** The signal advertised as "highest expected impact, no new data needed" (§4 signal-addition strategy, week 8) returns null for Vero until 2026-11-24. The investigation already noted this; the architecture inverted the finding. Sequencing should reflect that yoy_same_weekday delivers value for Vero starting late-2026, not Week 8.

### 9.3 weather_daily is missing in prod

**Doc says (§4 #5, Piece 0):** "Apply or reapply migration M015 (`weather_daily` table). Confirm forecasters degrade gracefully if it's still missing."

**Codebase reality:** Per investigation §5, `PGRST205` from PostgREST means the table is not in the schema cache. `MIGRATIONS.md:1` says "M022-M047 applied · M048 pending" — M015 is not in that range. M015's entry in MIGRATIONS.md has no "applied" date. The migration probably ran on a previous Supabase project and was lost during the move, or was rolled back.

**Implication:** Piece 0 is an estimated 1-2 weeks but the actual blocker is "go run the SQL." That's 5 minutes, not 2 weeks. The 2-week window in Piece 0 should be on (a) running M015 + (b) backfilling 365+ days of historical Open-Meteo data for Vero, not on the migration itself. Doc's Piece 0 budget is fine but the breakdown of where the time goes is unclear.

**Secondary implication:** while M015 is missing, `lib/weather/demand.ts:294-308` runs queries against `weather_daily` that return empty data, leading to `byBucket = empty Map`, leading to `lift = undefined` for every date, leading to `predicted = baseline` (line 202-206). This is "graceful degradation" but means the demand widget has been silently showing **just the per-weekday baseline** for Vero — no weather-bucket lifts at all. The Piece 0 fix changes the widget's actual numbers materially. The doc's Phase A starts logging legacy outputs, which are about-to-change. **Phase A baseline-MAPE measurements before vs. after Piece 0 are not comparable.** The doc's §9 sequencing constraint is right ("Piece 0 must come first") but the dependency chain isn't fully wired.

### 9.4 inputs_snapshot doesn't capture today's actual signals

**Doc says (§2 inputs_snapshot):** lists `yoy_same_weekday`, `recent_4_weeks_same_weekday`, `recent_8_weeks_same_weekday`, `weather_lift_factor`, `weather_change_vs_seasonal`, `holiday`, `klamdag`, `school_holiday`, `salary_cycle`, `this_week_scaler`, `weights_used`.

**Codebase reality (lib/forecast/recency.ts + lib/weather/demand.ts):** today's actual signals are:
- `RECENCY` constants (`RECENT_WINDOW_DAYS=28`, `RECENCY_MULTIPLIER=2.0`, `SCALER_FLOOR=0.75`, `SCALER_CEIL=1.25`)
- `weatherBucket` enum (`clear|mild|cold_dry|wet|snow|freezing|hot|thunder`)
- bucket sample size + recency-weighted bucket factor
- baseline-by-weekday recency-weighted average
- this-week scaler median + samples + raw (pre-clamp) value
- holiday name + holiday flag
- (in scheduling/ai-suggestion) per-(weekday × bucket) revenue-per-hour distributions, P75 rev-per-hour target, current-schedule hours/cost

**Implication:** The proposed `inputs_snapshot` is the *target future* schema, not what would actually be captured if you logged today's `/api/scheduling/ai-suggestion` output verbatim. Phase A "log legacy forecasters" requires the doc to specify a reduced inputs_snapshot for legacy surfaces (or accept that legacy rows have null for fields the legacy code never computed). The doc never differentiates legacy-snapshot vs. consolidated-snapshot. Easy fix: add a `snapshot_version` field, define legacy schema as a strict subset.

### 9.5 The doc's reconciler queries `daily_metrics.revenue` as numeric

**Doc says (§5):** `SELECT revenue FROM daily_metrics WHERE business_id = $1 AND date = $2` and computes `errorPct = (predicted_revenue - actual.revenue) / actual.revenue`.

**Codebase has:** `daily_metrics.revenue INTEGER NOT NULL DEFAULT 0` (`sql/M008-summary-tables.sql:16`).

**Implication:** Works fine in PG (integer divides cleanly). But: rows where `actual_revenue = 0` (closed days, partial sync) cause `division by zero`. The doc never excludes zero-revenue days from MAPE. Vero is closed Sundays — 7/52 of days have rev=0. Doc must either filter `WHERE revenue > 0` or define `errorPct = null` for zero-actual cases. This is a 1-line fix but it's load-bearing because zero-revenue days are common (Vero closed Sundays + holidays).

### 9.6 Monday Memo prompt embeds `computeDemandForecast()` directly

**Doc says (Appendix A):** `lib/weather/demand.ts` is "modified" — listed alongside ai-suggestion as a route to be modified.

**Codebase reality:** `lib/ai/weekly-manager.ts:17` imports `computeDemandForecast` directly and `lib/ai/weekly-manager.ts:327` invokes it inline. The Monday Memo's prompt receives the full `DemandForecast` JSON block. Switching the memo source to `dailyForecast()` is a separate touch from the dashboard switch and changes the memo's prose by changing the inputs the LLM sees.

**Implication:** Phase B has 3+ migration points (dashboard, scheduling page, Monday memo, possibly more), not 2. The doc lists 2.

### 9.7 Path names in Appendix A don't exist

**Doc says (Appendix A):** `crons/dailyMasterSync.ts`, `crons/aiForecastReconciler.ts`, `crons/dailyForecastReconciler.ts`, `crons/weeklyPatternExtraction.ts`.

**Codebase reality:** Next.js App Router project. All crons live under `app/api/cron/<name>/route.ts`. There is no `crons/` directory.

**Implication:** Cosmetic but a sign the doc was written without verifying paths. New cron routes should be `app/api/cron/daily-forecast-reconciler/route.ts` and `app/api/cron/weekly-pattern-extraction/route.ts` to match house style. Easy fix.

### 9.8 fetchOwnerFlaggedEvents references non-existent infrastructure

**Doc says (§6 LLM adjustment, prompt structure):** `owner_flagged_events: await fetchOwnerFlaggedEvents(forecast.business_id, forecast.date)`.

**Codebase reality:** No table, no API, no UI for owner-flagged events. Grep confirms: only the architecture doc itself mentions this concept.

**Implication:** Either the LLM prompt drops this field entirely (and the LLM has even less context than promised) or the architecture must spec a new table + UI for owners to flag "private event Saturday" / "kitchen closed Friday." That's an additional Piece — call it Piece 4.5. Doc treats it as already wired.

### 9.9 forecast_calibration.dow_factors is not feeding the consolidator

**Doc says (§3 computation logic, step 3):** baseline weights are `w_yoy/w_4wk/w_8wk`, no mention of `dow_factors`.

**Codebase reality:** `forecast_calibration.dow_factors` is computed monthly by `/api/cron/forecast-calibration` but currently has the Vero Sun=0.009 bug. Investigation §6 explicitly flagged "the dow_factors=0.009 trap." Doc claims the consolidator's sample-size guardrails "prevent this trap" (§3 sample-size guardrails) but never connects: is `dow_factors` deprecated by the consolidator's per-weekday rolling baselines, or kept as a separate adjustment? If deprecated, who turns off the cron? If kept, the trap returns.

**Recommendation:** explicitly deprecate the dow_factors output in the architecture doc as part of Piece 0. Or wire it as a 7th signal with sample-size gating. Don't leave it dangling.

### 9.10 Sequencing claim that 14 calls/biz/day = $2/biz/month

**Doc says (§6 cost projection):** "1 customer (Vero): ~$2/month."

**Codebase reality:** Investigation §10 measured Vero's actual 30-day Anthropic spend at ~$0.40 across all current AI surfaces (anomaly_explain, cost_intelligence, ask, tracker_narrative, budget_coach, fortnox_extract, etc.). Adding $2/month for the new prediction-adjustment LLM is a **5× increase in Vero's AI bill** for one feature. It's not large in absolute terms but it's not "negligible vs subscription revenue at any scale." It also makes the prediction layer the single most expensive AI surface per customer, which matters for the kill-switch criteria — if the LLM is provably not adding MAPE value, killing it saves 80% of per-customer LLM spend.

This isn't wrong, but the framing "negligible" is misleading at single-customer N.

---

## Section 10 — Recommendations

### Must-fix (the doc is materially wrong here; implementing as written would break things)

1. **Replace `anomaly_alerts.status = 'confirmed'` with a real predicate.** Either (a) add a `status` column to `anomaly_alerts` with explicit owner workflow as a Piece 0 task, or (b) define "anomaly-contaminated" as `severity IN ('high','critical') AND is_dismissed = false` against `period_date`. Update both the consolidator's baseline-filter step and the reconciler's contamination check accordingly. Document it explicitly. **Doc §3 step 2 + §5 reconciler need rewriting.**

2. **Add `org_id uuid not null references organisations(id) on delete cascade` + RLS policies + retention RPC to `daily_forecast_outcomes`.** Match M020's pattern verbatim. Without this, the table is a privacy hole on day 1. **Doc §2 DDL needs a full rewrite of the policy block.**

3. **Define how the unique constraint enforces idempotency.** Either truncate `predicted_at` to minute (and update DEFAULT), or change the unique key to `(business_id, forecast_date, surface)` + `ON CONFLICT DO UPDATE` semantics. Pick one; specify caller behaviour on conflict. **Doc §2 + §5 need an `ON CONFLICT` clause spelled out.**

4. **Correct yoy_same_weekday claim for Vero.** Update §4 #1 to say "available from 2026-11-24 onward; null until then; does not contribute to MAPE for Vero's first 6 months on the new system." Update §9 sequencing to reflect that this signal's contribution to Vero's MAPE arrives in late 2026, not Week 8.

5. **Specify `inputs_snapshot` schema for legacy surfaces.** Phase A logs `'scheduling_ai_revenue'` and `'weather_demand'` rows — define what their snapshot looks like (it cannot include klämdag/yoy/salary because the legacy code doesn't compute them). Add `snapshot_version` field. Define the consolidated_daily snapshot as a strict superset. **Doc §2 inputs_snapshot needs a "legacy snapshot subset" subsection.**

6. **Fix path names in Appendix A.** All `crons/*.ts` references should be `app/api/cron/<name>/route.ts`. The `crons/` directory does not exist.

### Should-fix (the doc is missing or ambiguous; clarification prevents rework)

7. **Specify backfill strategy in Piece 0 or Piece 1.** Walk Vero's 90 days of positive history through `dailyForecast({ skipLogging: false })` once weather_daily backfill is complete. Yields 90 days of audit data on day 1, not "after 14 days of shadow."

8. **Clarify call-frequency semantics.** Add to §5: "An audit row is logged AT MOST ONCE per (business_id, forecast_date, surface) per UTC day, regardless of how many requests fire." Or commit explicitly to logging every call and accept the 14× cost multiplier.

9. **Address fetchOwnerFlaggedEvents.** Either remove it from the LLM prompt structure OR add a Piece 4.5 for owner-flag table + UI. Currently shipped as imaginary infra.

10. **Specify graceful degradation for the LLM layer when Anthropic is unreachable.** Add to §6 activation criteria: "If LLM call fails, fall back to consolidated_daily prediction with `surface='consolidated_daily'` only — no llm_adjusted row written. Reconciler treats this case as 'baseline only' for MAPE comparison."

11. **Specify how `forecast_calibration.dow_factors` interacts with the consolidator.** Explicitly deprecate or explicitly retain with sample-size gating. Don't leave the existing buggy behaviour in production while building a parallel path.

12. **Define MAPE-by-horizon semantics.** Add a `prediction_horizon_days int` column derived as `forecast_date - predicted_at::date`. Required for the secondary metric in §1.

13. **Address the Sunday 02:00 UTC conflict** with `api-discovery`. Pick another slot or migrate api-discovery.

14. **Update master-sync header comment + doc to consistently say 05:00 UTC.** The route file's header lies — it says "Runs at 06:00 UTC daily" but vercel.json schedules `0 5 * * *`. Trivia, but the architecture's "after master-sync (05:00)" claim is correct.

15. **Cost projection rebuild at realistic context size (~10k input tokens).** Document the per-call cost at the realistic upper bound and at the cached-system-prompt happy path. Note the rate-limit consideration when 50+ customers fire concurrently.

16. **Specify monitoring + alerting + retention.** Match the existing pattern (`data-source-disagreements-alert` daily email, `prune_*` RPC, `ai-daily-report` cost rollup). One paragraph addresses this.

### Nice-to-have

17. **Pull klämdag and 25th-of-month patterns into the holiday module.** They're calendar-derivable, no DB needed; same pattern as `lib/holidays/sweden.ts`. Cleaner separation than scattering across signal files.

18. **Add a feature-flag wrapper around `dailyForecast()` itself.** Per-business toggle in admin (already established pattern in `is-agent-enabled.ts`). Lets you A/B-test the consolidated forecaster against a single customer.

19. **Pre-populate `business_cluster_membership` for Vero on day 1.** `(cuisine='italian', location_segment='city_center', size_segment='medium')`. Cheap, lets you verify the cluster join queries work before N≥5.

20. **Snapshot test for `inputs_snapshot` JSONB.** A single fixture business + frozen-clock test ensures the schema doesn't drift silently. Setup is small if vitest is already in the repo (uncertain — would need to verify by inspecting `package.json`).

---

## Section 11 — What I didn't get to

- I did not enumerate all 11 prediction pathways from the investigation against the architecture's coverage. The architecture explicitly scopes to pathways #1, #2, and the LLM surfaces; pathways #3, #4 (anomaly-detection baselines) and #11 (legacy `forecasts` table + `pk_sale_forecasts`) get one-line mentions or none. A fuller review would map each of the 11 to the architecture's piece structure.

- I did not validate the cross-customer cluster definition (§8 cuisine/location_segment/size_segment). For Vero specifically, the doc invents the cluster values without checking what columns `businesses` actually has — `lib/weather/forecast.ts:86` treats `city` as a free-text string, and there's no `cuisine` column today. **Uncertain — would need to verify by querying the `businesses` table schema** for what dimensions exist. Best guess: doc would need to add `cuisine`, `location_segment`, `size_segment` columns or a cluster-membership table independent of `businesses`.

- I did not deep-dive the pattern extraction prompt structure (§7) for prompt-engineering correctness. The output schema is reasonable; the question of whether Haiku 4.5 reliably emits JSON of that shape under load is empirical.

- I did not test `vercel.json` cron concurrency at the platform level — Vercel Pro allows multiple crons to fire simultaneously, but I assumed without verifying that two crons at exactly `0 7 * * *` (`ai-accuracy-reconciler` and `fortnox-backfill-worker`) actually run concurrently rather than queue. **Uncertain — would need to verify by checking Vercel's cron documentation or the actual run logs.**

- I did not assess whether the existing 4-week vs 8-week weighting in `recency.ts` is in fact superior to a yoy-anchored model in the limited Vero data. That's an empirical measurement, not a code review.

- I did not check the `package.json` for a test runner (vitest, jest, none). Recommendations referencing tests are conditional on whether the repo has any unit-testing infrastructure today. **Uncertain — would need to verify by inspecting `package.json`.**

- I did not catalog every file that imports from `lib/weather/demand.ts` or reads `est_revenue` to estimate the full Phase B switchover blast radius. I named the obvious ones (OverviewChart, scheduling page, weekly memo, computeWeekStats); there may be exports/reports/email templates that also bind to these shapes.

- I did not verify the existing Anthropic spend tracking infra works for cron-context calls. The investigation describes `ai_request_log` writes from `lib/ai/usage.ts`. Whether `logAiRequest` is reliably called from every existing surface (and would be from a new prediction-adjustment cron) is a code-audit question I deferred.

- I did not assess privacy-policy implications of the audit ledger as a "regulated artifact" (Appendix B #4). LEGAL-OBLIGATIONS.md is the source of truth and I didn't open it.

- I did not estimate the calendar effort to unblock Piece 0 if M015 truly was never applied. Best estimate: 2 hours including the Open-Meteo backfill, not 2 weeks. The 2-week budget the doc allocates may be over-generous.

---

> Review complete. No code changed. No commits. Single file at `C:\Users\Chicce\Desktop\comand-center\ARCHITECTURE-REVIEW-2026-05-08.md`.
