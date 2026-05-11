# ROADMAP.md — CommandCenter
> Version 8.9 | Updated: 2026-05-11 | Session 17 ✅ (Fortnox OAuth chain unblocked + 12-month backfill + overhead drilldown)
> Active focus: Piece 4 LLM-adjust + cold-start clamp re-run, then add-second-business flow. Stripe price IDs still pending. i18n coverage of /scheduling, /notebook, /overheads/* still pending.
> Read alongside CLAUDE.md and FIXES.md

---

## Upcoming — Add-second-business flow

See `ADD-SECOND-BUSINESS-PLAN.md` for full write-up.

Surfaced 2026-05-11 while inspecting how an existing customer (e.g. Vero) would add another location post-onboarding. The bare insert path works (`/settings` → "Add location" → 3-field modal → `/api/businesses/add`) but the surrounding policy + data-capture story doesn't:

- **No plan-limit enforcement.** Solo=1, Group=5, Chain=∞ defined in `lib/stripe/config.ts`, never read by the API or UI. Only the 20/hour anti-abuse rate limit catches a Solo customer adding their second business.
- **Stripped data capture.** Modal collects name/city/type only. Onboarding collects address, validated org-nr, business_stage (M046), opening_days (M046), country, cost targets, optional last-year P&L PDF. Budget AI + scheduling AI + holiday routing all key off the M046 fields — a second business added today runs predictive models on defaults.
- **No integration onboarding.** Owner is dropped back on settings; has to discover `/integrations`, switch sidebar, connect PK + Fortnox per business themselves.

**Proposed flow** (~½ day work):
1. `/api/businesses/add` plan-limit check returning 402 with `{ error, upgrade_to }` (15 min)
2. Settings UI disables button at limit + upgrade CTA (30 min)
3. "Add location" routes into `/onboarding?append=1` reusing the existing wizard (1-2h)
4. Replace bare modal with wizard redirect (15 min)
5. Verify Fortnox/PK steps work in append mode (30 min)

**Open policy questions before shipping:**
- Downgrade behaviour (Group with 4 businesses → Solo limit 1: hide? read-only? block downgrade?)
- Founding tier (limit 3) interaction with 24-month price-lock
- Org-nr collision detection: same org-nr = department of existing business, not a new business?

Worth doing before the second-location customer lands; onboarding the first multi-location group with a half-finished flow burns trust.

---

## Session 18 (in-flight) — 2026-05-11 (Piece 4 + cold-start clamp + Fortnox token-refresh)

**A. Fortnox token refresh** — Vero's dashboard started 401-ing the day after her OAuth onboarding because `recent-invoices` / `drilldown` / `invoice-pdf` were reading `creds.access_token` raw with no expiry check. New shared helper `lib/fortnox/api/auth.ts` (`getFreshFortnoxAccessToken()`) loads the integration, checks `access_token_expires_at`, refreshes via the standard OAuth refresh-token flow if expired, persists new tokens + new expiry, returns a guaranteed-fresh bearer. All three customer-facing Fortnox endpoints now route through it.

**B. Piece 4 LLM-adjust backtest run + two fixes** — Backtest endpoint ran 30 days for Vero (Jan 2026 – early May 2026):

- MAPE delta: −28.5pp (consolidated 143.3% → llm_adjusted 114.8%)
- Bias: +104.2% → +69.6% — over-prediction halved
- 30/30 written, 0 nulls, 0 errors, 0 skipped → soft-fail + clamp + write paths all work end-to-end

But two issues surfaced:

1. **Prompt cache 0/0 hit rate.** `cache_creation.ephemeral_5m_input_tokens=0` across all 30 calls. Root cause: explicit `ttl: '5m'` requires `anthropic-beta: extended-cache-ttl-2025-04-11` header; without it the API silently drops the entire `cache_control`. Fix: removed `ttl: '5m'`, default 5-min TTL is implicit. New memory: `feedback_anthropic_cache_control_ttl.md`.
2. **Cold-start clamp inflation** (memory: `feedback_cold_start_clamp_inflation.md`). Both surfaces 100%+ off in January because the `this_week_scaler` floor of 0.75 forbid dampening below 75% even when raw scaler was 0.29-0.52. Floor exists to protect mature baselines from one weird day; in short-history mode the baseline ITSELF is suspect. Fix: relaxed scaler floor to 0.50 / ceil to 1.50 when `shortHistoryMode=true`. `thisWeekScaler()` signature extended with `opts.shortHistoryMode` (other callers in `lib/weather/demand.ts` + `app/api/scheduling/ai-suggestion/route.ts` unchanged — they default to mature-mode clamps). Snapshot's `clamped_at_min/max` + `scaler_floor/ceil` now reflect the per-call values.

**Re-run 2026-05-11 09:42 — clamp REVERTED, cache fix didn't fire.**

| Run | MAPE cons. | MAPE LLM | Bias cons. | Bias LLM | Cache |
|---|---|---|---|---|---|
| Baseline (orig clamp + ttl:'5m') | 143.3 | 114.8 | +104.2 | +69.6 | 0/0 |
| Relaxed clamp + ttl removed | 151.5 | 122.8 | +100.4 | +65.1 | 0/0 |

Two findings:

1. **Relaxed clamp regressed MAPE +8pp.** Vero's January is bimodal (low Mon-Wed, high Sat-Sun). `this_week_scaler` is flat-across-the-week — early-week weakness dampens the WHOLE week's predictions proportionally. With floor=0.5, Wed-Sun predictions cranked to ~50% of baseline, but Sat-Sun actuals were HIGH (01-23 actual 129k → predicted dropped 53k→44k; 01-28 actual 48k → 10k→7k). Floor relaxation traded over-prediction wins for under-prediction losses, net negative. **Reverted in `lib/forecast/recency.ts` — back to flat [0.75, 1.25] clamp.**

2. **Cache fix didn't fire either.** Removing `ttl: '5m'` from cache_control should have made the default 5-minute TTL fire, but `cache_creation_input_tokens=0` again. System prompt is ~2,700 tokens (above Haiku 4.5's 2048 minimum) and the deploy IS live (LLM reasoning explicitly references the new floor before revert). Either the prefix is borderline-below threshold and my token estimate is wrong, or something else is dropping the cache_control. Cost impact at production volume is negligible (~$0.005/call), so deferred. Open question logged in ROADMAP follow-ups; not blocking.

**Real architectural problem surfaced — cold-start over-prediction is not a clamp problem.** The deterministic forecaster's `weekday_baseline` is anchored on a 4-week unweighted window that includes December peaks when forecasting January. The LLM is correctly identifying this in every single sample reasoning, dampening to 0.78-0.85, and recovering ~28pp of MAPE. But the LLM is enrichment, not load-bearing — the right fix is at the deterministic layer.

**Option C SHIPPED 2026-05-11** — cold-start holiday-period exclusion (`consolidated_v1.3.0`):

- New helper `isInHolidayPeriod(date)` in `lib/forecast/daily.ts` — returns true for Dec 20-31 and Jan 1-6 (the Swedish restaurant Christmas/New Year regime).
- When `shortHistoryMode && !forecastInHolidayPeriod`, the weekday-baseline filter drops same-weekday samples that fall inside the holiday window. December peaks no longer anchor January predictions.
- Safety fallback: if filtering would leave < 2 surviving samples, revert to unfiltered. Surfaced as the `cold_start_holiday_filter_fellback_too_few_samples` flag so the LLM can apply soft dampening in that case.
- Two new dataQualityFlags: `cold_start_holiday_samples_excluded` (filter fired) and `cold_start_holiday_filter_fellback_too_few_samples` (filter wanted to fire but couldn't).
- Snapshot `weekday_baseline` now carries `holiday_samples_excluded` (count) and `holiday_filter_active` (bool).
- LLM prompt updated: Example A is now "filter active → defer to deterministic, factor=1.0"; new Example A2 is "filter fell back → ~15% dampening still warranted". The "HOLIDAY-FILTER GUARDRAIL" rule explicitly stops the LLM from double-counting the correction.
- Filter is only relevant in short-history mode — once the business has ≥180 days history, the 12-week mature window doesn't reach back to the prior December anyway, AND yoy_same_weekday + recency-weighted average handle seasonal transitions correctly. Self-removing scaffolding.

**Backtest 2026-05-11 — Option C result:**

| Run | MAPE cons. | MAPE LLM | Bias cons. | Bias LLM |
|---|---|---|---|---|
| Baseline (orig) | 143.3 | 114.8 | +104.2 | +69.6 |
| Relaxed clamp (reverted) | 151.5 | 122.8 | +100.4 | +65.1 |
| **Option C** | **127.7** | 133.6 | **+87.3** | +96.7 |

- **Consolidated MAPE -15.6pp from baseline**, bias -17pp. Deterministic absorbed most of the LLM's prior corrections — the holiday-filter is doing the job that the LLM was previously approximating.
- LLM MAPE going UP is the **expected and correct outcome** — when deterministic catches up, the LLM correctly returns factor=1.0 (Example A guardrail). Of 27 successful LLM calls, only 3 applied non-1.0 factors (01-03, 01-19, 01-20), all directionally correct.
- 3 null LLM returns on Feb 1-3 — looks like an Anthropic API transient at the tail of the run (skipQuotaGate=true so not quota; 3 consecutive at end suggests rate-limit or service blip). Add a single-shot retry with 1s backoff in `llm-adjust.ts` before next run.
- The ≥3pp cutover criterion FAILED in the LLM's direction — deterministic is now BETTER than LLM-adjusted. Architecturally the right call: surface deterministic to UI by default. LLM enrichment remains as an opt-in / explain-mode surface.

**Cutover wired 2026-05-11 (Session 18 continued):**

- **Backfill refreshed to `consolidated_v1.3.0`** — re-ran `scripts/backfill-vero-consolidated-forecasts.ts`. New numbers across 116 days:
  - MAPE **64.6 %** (was 71.0% on v1.2.0 — Option C delivered 6.4pp improvement on the full window)
  - Bias **+13.9 %** (was +35.5% — 21.6pp bias reduction; system is now essentially unbiased)
  - Legacy `scheduling_ai_revenue`: n=1 only, can't statistically compare. Even on that single day legacy hit 74.9% MAPE; consolidated 64.6% over 116 days is the clear winner.

- **Cutover code wired in `/api/scheduling/ai-suggestion`** — surgical change. When `PREDICTION_V2_DASHBOARD_CHART` flag is on for a business: pre-fetches consolidated forecasts in parallel for future dates in the range, swaps `avgRev` source from the legacy `rawAvgRev * thisWeekScale` to the consolidated `predicted_revenue`. Everything downstream (scheduling math, P75 rev/hour, hour targets, owner UI) consumes the same `avgRev` variable — swap is invisible to other consumers. Legacy `scheduling_ai_revenue` capture is bypassed when flag is on (consolidated capture handles the audit ledger). Soft-fails to legacy math if any `dailyForecast()` call throws.

- **Flag flip script ready** — `scripts/flip-prediction-v2-dashboard-chart-vero.sql`. One-line SQL to activate cutover for Vero. Idempotent. Rollback is `enabled = false`.

**To activate cutover for Vero:** run the SQL in Supabase SQL Editor against production. Then open her dashboard — the revenue prediction line will source from `consolidated_v1.3.0` (with holiday filter, klamdag, salary cycle, school holiday, weather-bucket lift). No other code change needed.

**Flag flipped 2026-05-11 (Vero only):** `PREDICTION_V2_DASHBOARD_CHART = true` via `scripts/flip-vero-v2-flag.mjs`. Visual verification on Vero's dashboard confirmed predictions look much better post-flip.

**DemandOutlook cutover wired 2026-05-11:** `lib/weather/demand.ts::computeDemandForecast()` now follows the same flag-gated pattern. When `PREDICTION_V2_DASHBOARD_CHART` is on, the per-day `predicted_revenue` and `baseline_revenue` come from `dailyForecast()` instead of the legacy `baseline × bucket_lift × weekScale` math. Holiday flag, weather summary, sample-size confidence, and recommendation logic all preserved. The legacy this-week scaler is skipped on the v2 path (consolidated applies its own internally — would double-correct). Legacy `weather_demand` capture bypassed when flag is on. Since Vero's flag is already flipped, DemandOutlook activates automatically on next deploy.

**Coverage map after 2026-05-11:**

| UI surface | Backend | v2 status |
|---|---|---|
| Dashboard revenue chart | `/api/scheduling/ai-suggestion` | ✅ v2 (Vero) |
| Dashboard labour predictive | `/api/scheduling/ai-suggestion` | ✅ v2 indirectly (via avgRev) |
| Scheduling page | `/api/scheduling/ai-suggestion` | ✅ v2 (Vero) |
| DemandOutlook day cards | `lib/weather/demand.ts` | ✅ v2 (Vero) |
| WeatherDemandWidget | Same as DemandOutlook | ✅ v2 (Vero) |
| Monday Memo AI prompt | `lib/ai/weekly-manager.ts` calls `computeDemandForecast()` | ✅ v2 indirectly (cascades from DemandOutlook wire) |
| `/forecast` page (monthly) | `/api/forecast` | ⏳ legacy — different problem space, separate decision |

**Remaining issues observed in samples:**

- **Per-day variance is still wide.** Saturday 01-09 went UP after filter (105k → 140k) because removing Christmas peaks left Vero's *opening-week* Dec 12 / Dec 19 samples — those are also non-representative (launch-week revenue). Filter is binary "Christmas peak vs not"; doesn't see "opening week" as a separate regime. Acceptable for now — once Vero accumulates more post-Christmas history, the 4-week window slides past the launch period naturally.
- **LLM is inconsistent on `cold_start_holiday_filter_fellback_too_few_samples`.** It applied Example A2 correctly on 01-19 (factor 0.9) and 01-20 (0.95) but defaulted to 1.0 on 01-12, 01-13, 01-25 despite the same flag. Could strengthen the prompt rule. Low priority — net contribution from the LLM layer is small now that deterministic is better.
- **~~Cache still 0/0~~ FIXED 2026-05-11.** Diagnostic scripts (`scripts/diag-llm-cache-*.mjs` + `diag-llm-cache-size.ts`) ran controlled tests against the Anthropic API: count_tokens confirmed our prefix was 2,532 tokens (above docs-stated 2,048 minimum), but real calls still showed 0/0. Variant testing on Sonnet 4.6 (1024 min) worked; Haiku 4.5 at the same size didn't. Pushed Haiku 4.5 prompts to ~6,000 tokens — caching fired. **Empirical conclusion: Haiku 4.5's real cacheable minimum is ~4,096 tokens, NOT the 2,048 the docs imply.** Bulked Piece 4 system prompt to 5,048 tokens (added SIGNAL REFERENCE section + Examples E/F/G). Live test now shows `cache_creation=4732` call 1, `cache_read=4732` call 2. Memory: `feedback_anthropic_cache_control_ttl.md` (renamed to "Anthropic prompt caching gotchas").

**Backtest 2026-05-11 — full stack of fixes:**

| Run | MAPE cons. | MAPE LLM | Bias cons. | Bias LLM | Cache |
|---|---|---|---|---|---|
| Baseline | 143.3 | 114.8 | +104.2 | +69.6 | 0/0 |
| Option C only | 127.7 | 133.6 | +87.3 | +96.7 | 0/0 |
| **Option C + cache + prompt bulk** | **127.7** | **124.0** | +87.3 | +83.6 | **WORKS** |

- Cache verified live: `cache_creation=4824`, `cache_read=139896` across 30 calls. Cost ~$0.082 for 30 calls, ~46% lower than pre-cache.
- LLM MAPE recovered 9.6pp with the bulked prompt — the SIGNAL REFERENCE + Examples E/F/G gave the LLM better calibration. 0 null returns (was 3); non-1.0 adjustments correctly target `cold_start_holiday_filter_fellback_too_few_samples` cases.
- **Cutover boundary:** LLM is 3.7pp better than deterministic — meets the ≥3pp threshold but barely on a noisy 30-day sample. Decision: **keep deterministic as default surface, offer LLM-adjusted as opt-in enrichment.** The remaining 127% MAPE is structural to Vero's cold-start (bimodal weeks, opening-week samples); not a one-more-clamp problem.

**Deferred:**
- Option A (weekday-aware scaler) — worth revisiting if Sat-Sun under-prediction persists post-Option-C.
- Option B (structural post-holiday decay term) — country-specific magic; rejected in favor of C's data-driven approach.
- "Opening-week" detection — flag and exclude samples within first 30 days of business launch.
- LLM retry-on-transient in `llm-adjust.ts`.
- Cache investigation (count_tokens probe, or accept caching won't fire on Haiku 4.5 at this prompt size).

**Cache investigation follow-ups:**
- Validate token count of cacheable prefix using Anthropic's count_tokens endpoint
- If genuinely below 2048: bulk up SYSTEM_PROMPT with more worked examples (E, F)
- If above 2048: check whether @anthropic-ai/sdk's outdated TLS / encoding is interfering (we use direct fetch, but headers might still matter)
- Alternative: switch Piece 4 to Sonnet 4.6 just for the surface that needs caching (1024-token minimum). Costs more per call but cache would actually fire. Trade-off needs measuring.

---

## Session 17 — 2026-05-07 shipped (Fortnox OAuth + backfill + drilldown)

Day-long session that took the Fortnox OAuth flow from "code exists but never used" to "real customer can connect, get 12 months of data backfilled, and drill from any cost flag straight to the source supplier invoice." Twelve commits, four migrations applied (M048–M051), seven new endpoints, three new reports.

**A. OAuth chain unblocked end-to-end — 4 chained bugs, fixed in dependency order**

Each bug was hidden behind the previous one, so they only surfaced sequentially as fixes landed:

1. **Empty `business_id` on the URL** — `app/integrations/page.tsx:460` called `connectFortnox()` with no argument; the URL dropped `business_id`; the upsert wrote NULL; nothing usable. Fix in `66ffb5b` — pass `selectedBiz` + `disabled={!selectedBiz}` guard. New i18n key `actions.connectDisabledNoBusiness` in en-GB / sv / nb.
2. **State signature `+`/space corruption** — `signState` / `verifyState` used standard base64; `+` chars in the HMAC sig got URL-mangled to spaces during the Fortnox callback round-trip; signature verification failed (`fortnox_invalid_state`). Fix in `f2913e9` — switch both halves to `Buffer.toString('base64url')` (RFC 4648 §5, JWT-style URL-safe alphabet).
3. **`42P10` upsert mismatch** — every existing unique index on `integrations` is partial (`WHERE department IS NULL`, expression-based `COALESCE`), and PostgREST `onConflict=col1,col2` only matches non-partial indexes by column list. Fix in `1147d9a` — M049 adds `integrations_org_biz_provider_uniq` (non-partial UNIQUE on `(org_id, business_id, provider)`); upsert switched to `onConflict: 'org_id,business_id,provider'`.
4. **Dev account licensing (Fortnox `2001101`)** — Paul's developer Fortnox doesn't have an active Bokföring license, so `/3/vouchers` returns 400 even though the OAuth scope was granted. Not a code bug; resolves Saturday when Vero authorises with their actually-licensed account.

OAuth flow now demonstrably works end-to-end against a real Fortnox account. Vero's `integrations` row landed cleanly at 17:31 UTC.

**B. 12-month backfill on OAuth connect**

- M050 added `backfill_status` (`pending`/`running`/`completed`/`failed`), `backfill_started_at`, `backfill_finished_at`, `backfill_progress JSONB`, `backfill_error` to `integrations` plus a partial index on `(provider, backfill_status)` for cheap claim queries.
- `app/api/cron/fortnox-backfill-worker/route.ts` — atomic claim via `UPDATE WHERE backfill_status='pending'`, fetches 12 months via `lib/fortnox/api/vouchers.ts`, translates via `lib/fortnox/api/voucher-to-aggregator.ts`, writes per-month `tracker_data` rows with `source='fortnox_api'`, `created_via='fortnox_backfill'`. Idempotency check skips months where PDF apply already populated the row. Daily 07:00 UTC cron as backstop; OAuth callback fires worker via authenticated HTTP POST so customer doesn't wait for cron tick.
- Owner-facing button on `/integrations` (commit `a3ee75f`) — context-aware label adapts to `backfill_status`. Disabled when in flight.
- Admin Quick Action on `/admin/v2/customers/[orgId]` (commit `1b067bb`) — uses existing `requireAdmin` + audit pattern, includes ≥10-char reason. New `INTEGRATION_BACKFILL` enum entry. Backfill state visible in CustomerIntegrations table with coloured badge + live progress.
- Bonus fix while editing `/integrations`: pre-existing `load()` ReferenceError on Sync Now / Reconnect / Disconnect buttons fixed (`load()` → `fetchIntegrations()`).

**C. Drill-down from cost flag → supplier invoices**

Owner clicks "Show invoices" on an overhead-review flag card → expands inline to a chronological list of the supplier's invoices for the period, with drift indicator and per-row "View PDF" / "In Fortnox" actions:

- M051 — `overhead_drilldown_cache` table (5-min TTL, keyed on `(business_id, period_year, period_month, category)`). Note: Paul applied via direct SQL editor before the migration file was written; M051 is idempotent for documentation/replay.
- `app/api/integrations/fortnox/drilldown/route.ts` — fetches vouchers + supplier invoices in parallel from Fortnox, joins by `VoucherSeries+VoucherNumber`, filters voucher rows by BAS account range matching the requested category, groups by supplier. Cache-or-fetch.
- `app/api/integrations/fortnox/file/route.ts` — streams the attached supplier-invoice PDF from Fortnox's archive endpoint to the browser with `Content-Disposition: inline` so it renders natively in a new tab. Tries `/3/inbox/{id}` first, falls back to `/3/archive/{id}`.
- New `InvoiceDrilldown` + `InvoiceRow` components inside `app/overheads/review/page.tsx` (kept co-located with `FlagCard` per existing pattern). Drift indicator surfaces "Flagged: X / Live: Y / +N added since flag was generated" when the accountant has added entries since the PDF was applied.
- New `overheads.review.drilldown.*` i18n namespace in en-GB / sv / nb (11 keys + 4 drift sub-keys, parity verified).

**D. AI invoice-awareness**

- `lib/ai/scope.ts` — new `INVOICE-LEVEL DATA` paragraph in `SCOPE_NOTE`. Every AI surface that imports it (every predictive surface per CLAUDE.md) now knows: per-invoice voucher detail is NOT in your context unless explicitly provided; you may mention the drill-down affordance as a next step; you may NOT claim invoice specifics without seeing them.
- `lib/overheads/ai-explanation.ts` — overhead reexplain prompt updated. New bullets: (1) point owner at "Show invoices" when supplier name is generic / spike is ambiguous; (2) cite specifics only when `invoices: ...` block is present in the rule_reason; (3) never fabricate.
- `app/api/overheads/explain/[flagId]/route.ts` — opportunistic cache lookup. If the drilldown cache is warm (≤30 min, looser than UI's 5 min — slightly stale invoice data is fine for AI input), filters to the matched supplier, formats up to 12 invoices into a compact `invoices: MM-DD=NNNkr(account-desc); ...` block, appends to the AI's `reason` context. Cold cache → AI explains at supplier granularity as before. No fresh Fortnox fetch from the explain path (would add 5-10s to a reexplain click).

**E. Reports written**

- `FORTNOX-API-AUDIT-2026-05-07.md` — Phase 1 Question 1: enumeration of every Fortnox API call site, categorised by active-cron / active-apply / admin-only / unused / tested-only. Headline finding: two parallel Fortnox sync paths exist; Path A (`lib/sync/engine.ts`) writes to `financial_logs` which nothing reads.
- `FORTNOX-VERIFICATION-REPORT-2026-05-07.md` — Phase 1 Question 2 stub. Updated to reflect that no Fortnox OAuth integration existed in production until 17:31 UTC (Vero's connection); harness is ready, awaiting real data Saturday.
- `FORTNOX-OAUTH-CONFIG-2026-05-07.md` — for the developer-portal config: redirect URI string, the 10 scopes mapped to Fortnox's permission UI, the explicit UNCHECK list, service-account checkbox guidance, ⚠ flag about query-parameter-in-redirect-URI being potentially rejected by Fortnox.
- `INTEGRATIONS-FLOW-INVESTIGATION-2026-05-07.md` — read-only diagnosis of the page-button bug (#1) before the fix.
- `ROADMAP-REVIEW-BRIEFING.md` — paste-ready briefing for outside Claude.ai roadmap review.
- `FORTNOX-DIAGNOSTIC-2026-05-07.md` — original integration diagnostic before today's work; some open questions now answered.

**Migrations applied this session:** M048 ✅ (verification harness mirror tables), M049 ✅ (non-partial unique index for OAuth upsert), M050 ✅ (backfill state columns), M051 ✅ (overhead_drilldown_cache).

**Saturday 2026-05-09 (planned):** Paul meets Vero owner. Live OAuth onboarding using owner's actual Fortnox session in incognito. Backfill writes 12 months of real data. Drill-down on flagged costs is the demo's strongest closer. Notes for the meeting documented in this session's chat.

**Follow-ups deliberately deferred:**
- Phase 4 of AI awareness (cost-intelligence / supplier-price-creep / weekly-memo learning to use invoice-level data — wait for usage signal first).
- Webhooks for invoices (decided against; on-demand drill-down covers the core use case; revisit if a customer asks for sub-day freshness).
- Cleanup of two parallel Fortnox sync paths (`lib/sync/engine.ts` writes to dead `financial_logs`; cleanup belongs in a separate task).
- Voucher-list endpoint bug in `lib/sync/engine.ts:584` (`v.TransactionInformation` is a free-text field being parseFloat'd as if it were a numeric amount — pre-existing, dormant code, not load-bearing).
- API-priority `tracker_data` overwrite (kept PDF priority per the architectural pushback; revisit only if Paul actively wants it).
- Decision tracking on the drill-down (mark necessary / cuttable / revisit) — defer until after real-customer usage.
- Per-invoice in-app modal (currently "View PDF" opens in a new tab, which delivers the same outcome).

**Out of scope, observed during this work:**
- Local `.env.local`'s `CRON_SECRET` doesn't match production's (manual triggering via curl from local hits 401). Worth syncing via Vercel CLI (when installed) before any future scripted testing.
- The `t('tokenExpiry', { count: daysLeft })` rounding shows "1 day" for any token under 24h via `Math.ceil`. Pre-existing cosmetic issue; non-blocker.
- Verification harness scripts (`scripts/verification-runner.ts`, `scripts/verification-report.ts`) ready to run once Vero has real data — produces Phase 1 Q2 numerical answer that's currently a stub.

---

## Session 16 — 2026-05-03 shipped (data-source guardrails)

Born from two production data-quality incidents:
- **Vero March 2026** — Performance page showed 2,842,948 kr revenue. PK reference: 1,422,650 kr. Exact 2× signature → aggregator double-count from PK aggregate stacking with another POS provider that the dedup didn't handle.
- **Rosali March 2026** — labour ratio 13.6%, net margin 57.5% (impossible). Two compounding bugs: (a) `tracker_data` row with `source='manual'` + no `fortnox_upload_id` (owner says they didn't enter it), (b) PK staff_cost was 33% of Fortnox value because PK was connected mid-April with partial historical backfill.

**A. Aggregator hardening**
- `lib/sync/aggregate.ts` revenue dedup extended to ALL full-business aggregates (`personalkollen > onslip > ancon > swess`). Per-date filter so legitimate aggregates aren't dropped on dates where per-dept rows happen to exist for OTHER dates. Logs `[aggregate] dedup dropped` when active. Commit `7d8491c`.
- Same file's staff_cost decision now gated on TWO signals: (a) oldest PK staff_log predates the period, AND (b) when Fortnox has staff data, PK is within 70–130 % of it. Outside the band → use Fortnox with `cost_source='fortnox_pk_disagrees'`. New cost_source codes: `pk` / `fortnox` / `fortnox_pk_partial` / `fortnox_pk_disagrees` / `pk_partial` / `none`. Commit `afd0b37`.
- Repair scripts: `scripts/fix-vero-march-2026.mjs` and `scripts/fix-rosali-march-2026.mjs` apply the new logic to monthly_metrics for those specific cases.

**B. Source-agnostic admin alerts**
- `lib/admin/disagreements.ts` — single classification source, finds rows with `_disagrees` / `_partial` codes
- `/api/admin/data-disagreements` — on-demand admin endpoint
- `/api/cron/data-source-disagreements-alert` — daily 06:30 UTC, emails ops digest if any new disagreements in last 24h
- Source-agnostic by design: when Caspeco / Onslip / Ancon land with their own dedup paths producing similar `_disagrees` codes, this pipeline picks them up. Commit `4075617`.

**C. Fortnox apply chokepoint (M047)**
- `lib/fortnox/validators.ts` — 10 rule-based checks in one module. Org-nr match (HARD reject), period match (HARD reject), period in reasonable range, doc-type vs claimed period, sign convention, math consistency, scale anomaly (50 % deviation from prior 6-month median), period gap, subset caps, company name fuzzy match.
- `lib/fortnox/ai-auditor.ts` — Haiku second-opinion, ~$0.0005/apply, 20s timeout. Returns `{ confidence, summary, concerns }`. Fail-tolerant — never blocks apply on AI failure.
- `app/api/fortnox/apply/route.ts` — runs both BEFORE any tracker_data write. Returns 422 with `kind='validation_blocked'` + structured findings. New body fields: `acknowledged_warnings: string[]`, `force: boolean`, `skip_validation: boolean`.
- `app/overheads/upload/page.tsx` — review modal renders the structured response as inline checklist with per-warning checkboxes + AI auditor card. Apply button label adapts: `Apply to P&L` / `Apply with override` / `Resolve checklist above` / `Cannot apply (hard error)`. Commit `3f20833`.
- M047 migration:
  - `tracker_data.created_via TEXT` — origin tag for every write (default null for legacy; new code populates explicitly)
  - `fortnox_uploads.pdf_sha256 TEXT` + index — SHA-256 dedup at upload time, `status='duplicate'` on hit
  - CHECK constraints on `tracker_data`: revenue / food_cost / staff_cost / alcohol_cost / other_cost ≥ 0; period_month ∈ [0..12]; period_year ∈ [2000..2099]
- `/api/cron/manual-tracker-audit` — daily 06:45 UTC, emails ops when rows appear with `source='manual' AND fortnox_upload_id IS NULL`. Direct catch for the Rosali class.

**D. Privacy + cleanup**
- Bogus tracker_data row for Rosali 2026-03 deleted (cleanup script). monthly_metrics rebuilt with revenue=0, staff=PK partial.
- Vero March 2026 monthly_metrics correctly shows 1,422,782 kr revenue (matched PK reference) after the dedup fix.

**Migrations applied this session:** M047 ✅ (verified via `tracker_data` CHECK constraint listing).

**Follow-ups deliberately deferred** (added to the running list):
- VAT-inclusion explicit detector (subset-cap covers most cases)
- Multi-system reconciliation cron (quarterly)
- Cross-business sanity sweep
- Bolagsverket cross-check at onboarding
- Owner-side override on /integrations for "PK is canonical for me, ignore the disagreement" (current behaviour: Fortnox wins on disagreement, which is wrong if Fortnox is stale)

---

## Session 15 — 2026-05-02 shipped (onboarding + auth + holidays)

Three threads landed this session, all interlocking:

**A. Onboarding wizard overhauled — single source of business data**
- M046 migration: `businesses.opening_days JSONB`, `businesses.business_stage TEXT` enum (`new` | `established_1y` | `established_3y`).
- Wizard restructured to 3 real steps (Restaurant → Systems → Done; the marketing welcome slide was removed). Restaurant step now collects address + organisationsnummer + business stage + opening days (Mon–Sun toggles) + cost targets. Optional last-year P&L PDF upload on the Systems step (only when stage ≠ 'new'); flows through the existing `/api/fortnox/upload` pipeline.
- Org-nr capture moved out of the signup form. Signup now takes only email + password + name + org name (~30s). Single source-of-truth helper `lib/sweden/applyOrgNumber.ts` handles DB write + Stripe metadata + tax_id sync; both `/api/onboarding/complete` and `/api/settings/company-info` POST through it.
- `OrgNumberGate` + `OrgNumberBanner` components DELETED. Onboarding requires org-nr upfront; the 30-day grace path is dead code. Locale keys (`misc.orgGate`, `settings.orgNumberBanner`) removed from all 3 locale JSONs.

**B. Auth flow + gate chain**
- Email verification ON. `/api/auth/signup` creates auth users with `email_confirm: false` and emails a Supabase-generated confirmation link via Resend with our branded template + locale-aware copy (`lib/email/sendVerifyEmail.ts`). Signup form no longer auto-signs-in; shows "Check your inbox" screen. Verification link routes through `/api/auth/callback?next=/onboarding`.
- `OnboardingGate` component (mirrors `PlanGate` shape) added to `components/AppShell.tsx`. Mounted BEFORE `PlanGate` so unfinished owners get sent to `/onboarding` rather than `/upgrade`. New `/api/me/onboarding` endpoint backs the check (treats org as completed if `onboarding_progress.completed_at` set OR org has ≥1 business — legacy customers don't get surprise-redirected).
- Final canonical flow: signup → email verify → onboarding wizard → plan pick → app.
- Free-trial copy retired across signup form (en-GB / sv / nb). Pricing memory had said free-trial was retired but signup subtitle still advertised "30-day free trial · No credit card required" — now reads "Set up in minutes — pick a plan after onboarding" (and locale equivalents).

**C. Swedish public holidays — first-class data**
- `lib/holidays/sweden.ts` computes 17 SE restaurant-relevant days/year (public + observed). Easter via Anonymous Gregorian algorithm; Midsummer + All Saints' via "first weekday in window". Verified 2025/2026.
- `lib/holidays/index.ts` exposes country router (`getHolidaysForCountry`) + windowed lookup (`getUpcomingHolidays`). Norway / UK plug in as sibling files later — no overlap.
- `/api/holidays/upcoming` endpoint returns locale-named upcoming holidays for the active business's country.
- Dashboard AttentionPanel surfaces the next holiday inside 14 days as the top item, with `high` (peak demand) / `low` (most close) impact tags.
- OverviewChart X-axis day labels render Sat/Sun/holidays in red (#dc2626 + semibold), matching the printed-calendar convention. "Today" highlight (green + bold) wins overlap.
- AI awareness wired in: weekly memo prompt (21-day window) + scheduling-optimization cron (28-day window). Both fail-tolerant — empty placeholder if lookup throws.

**Bug fix — production-down recovery**
- 2026-05-01 incident: every page on production 500'd because `<CookieConsent />` was rendered as a sibling of `<NextIntlClientProvider>` instead of a child. The next-intl runtime wrapper masked the SSR throw as anonymous `Error(void 0)`, so neither build prerender failures nor runtime logs surfaced the real cause. ~1 hour to find. Fix: one-line move (CookieConsent inside provider). Prevention layer: `i18n/request.ts` now wires `onError` + `getMessageFallback` so future failures log a useful `[next-intl] CODE: msg` line. Memory saved at `feedback_next_intl_provider_scope.md`.

**Privacy scrub** — replaced `Vero Italiano` / `Paul Dransfield` / `paul@veroitaliano.se` / `Storgatan 12, 114 51 Stockholm` placeholders across signup + onboarding + settings + admin tools (3 locales). Also fixed the Fortnox extract-worker AI prompt that was leaking "Vero restaurant" to Anthropic on every PDF call (no ZDR yet — `project_company_formation_pending` memory).

**Migrations applied this session:** M046 ✅.

**Follow-ups deliberately deferred:**
- Norway + UK holiday modules (`lib/holidays/norway.ts`, `lib/holidays/uk.ts`) — waiting on country-picker UX decision.
- Inject `business_stage` into the budget AI prompt — when stage = 'new', skip the historical-anchor rule (no last-year actuals exist) so the AI doesn't anchor on zero.
- Per-day holiday name in OverviewChart tooltip (currently the red number tells you it IS a holiday, but not which one — would need a tooltip hover state).

---

## Session 14 — 2026-04-27 shipped (Sprint 1 of external code review)

External code review (`REVIEW.md`) flagged 5 critical/high issues. All landed this session. See `CLAUDE-CODE-HANDOFF.md` for the original tasking.

- **Task 1 — middleware rewritten** (FIXES §0t). Original task was "delete middleware" — pre-flight check found pages are `'use client'` with no server-side redirect, so deletion would have regressed `/dashboard` from "redirect to login" to "broken shell + 401 fetches". Rewrote `middleware.ts` to do cheap structural JWT validation (~88 lines, no `console.log`, no Supabase network call) on an explicit allowlist of 17 protected prefixes. New `lib/auth/session-cookie.ts` handles all three @supabase/ssr cookie shapes including chunked cookies. Cryptographic check stays in `getRequestAuth`.
- **Task 2 — multi-org `.single()` fix** (FIXES §0u). Both `lib/supabase/server.ts` and `lib/auth/get-org.ts` switched to `.maybeSingle()` with `.order('created_at', ascending: true).limit(1)` on `organisation_members`. A user with ≥2 org memberships no longer 401s; they land in their oldest org. Comment block flags the future explicit-org-switcher work.
- **Task 3 — Fortnox supersede chain join table** (FIXES §0v, M032 pending). New `fortnox_supersede_links(child_id, parent_id, period_year, period_month)`. apply() inserts one row per period iteration; reject() walks the table to restore EVERY parent on multi-month uploads. Pre-fix the column-level `supersedes_id` was overwritten on every iteration, leaving multi-month chains with only the last period's parent recorded.
- **Task 4 — atomic AI quota gate** (FIXES §0w, M033 pending). `/api/ask` switched from two-step `checkAiLimit + incrementAiUsage` to atomic `checkAndIncrementAiLimit()` via new `increment_ai_usage_checked` RPC. Closes the TOCTOU window where 100 parallel requests could blow the per-org daily cap by the burst factor. Cron-driven AI agents keep using the legacy two-step (now `@deprecated`) since they run serially under cron locks.
- **Task 5 — kill-switch table-scan removal** (FIXES §0w extension, same migration). New `ai_spend_24h_global_usd()` RPC + `idx_ai_request_log_created_at` (DESC) + `idx_ai_request_log_org_created_at`. Replaces the prior `db.from('ai_request_log').select('total_cost_usd').gte('created_at', since)` table scan that fetched ~2,500 rows per AI call at 50 customers.

**Migrations pending Paul application in Supabase:** M032, M033.

**Sprint 2 (Tasks 6–10, deferred from this sprint):**
- Task 6 — consolidate the two auth helpers (delete `lib/auth/get-org.ts`); requires migrating every API route using `getOrgFromRequest`.
- Task 7 — Stripe webhook `'solo'` plan default → look up plan from `price.id`.
- Task 8 — standardise on `checkCronSecret` in the 3 inline-`!==` cron handlers.
- Task 9 — wrap aggregator fire-and-forget in `waitUntil`.
- Task 10 — move root cruft to `archive/`.

Sprint 2 owner pick is Paul's call — Task 7 is the most user-visible (wrong plan = wrong AI quota), Task 6 is the largest blast radius.

---

## Session 12 — 2026-04-23 shipped

- **New `/financials/performance` page** replacing the dead `/cashflow` page. Unified Revenue / Food / Labour / Overheads / Net-margin view with Week/Month/Quarter/YTD granularity, period picker, compare dropdown, waterfall + donut + trend sparklines + template-driven "What's tunable" attention panel. No new endpoints — reads existing `/api/tracker` + `/api/overheads/line-items` + `/api/metrics/daily`.
- **AI layer upgrade** — `lib/ai/rules.ts` centralises domain rules across 9 surfaces; tool-use replaces regex-JSON on weekly-manager, budgets/generate, budgets/analyse, cost-intelligence; prompt caching on /api/ask (~80% input-token saving); `ai_forecast_outcomes` writes added to budget_coach; new `lib/ai/contextBuilder.ts`.
- **PK hardening** — `include_drafts=1`, timezone-tagged timestamps, sync-cursor plumbing (M024 pending), scheduled-break correctness, COGS + staff_uid + sale_center + staff employments captured.
- **Sync engine status reset** — every successful sync now resets `status='connected'` (fixes the stuck-in-error footgun, M023 applied).
- **Email infra** — comandcenter.se Gmail Workspace fully live, 11 aliases, SPF/DKIM/DMARC all PASS.
- **Admin hardening** — 4 routes locked down (SEC-2026-04-22), customer-list cache-bust, new /admin/diagnose-pk UI.

See CLAUDE.md header + FIXES.md §0g/0h/0i/0j for detail.

---

## Status Key

| Symbol | Meaning |
|--------|---------|
| ✅ | Complete — live in production, tested with real data |
| 🔄 | In progress |
| ⏳ | Blocked — waiting on external dependency |
| 📋 | Planned — session and priority confirmed |
| 💡 | Backlog — will build when relevant |

---

## What Is Live Right Now (Session 5 complete)

### Platform foundation ✅
- Multi-tenant architecture: org → businesses → integrations
- Auth (Supabase email/password), session cookies, route protection
- Sidebar with business switcher — all pages react to switch
- UX design system: `lib/constants/colors.ts`, `deptColor()`, uniform card styles
- GDPR: privacy policy, consent banner, data export API, deletion requests
- Onboarding: 4-step flow, sends setup request email to support
- Admin panel `/admin`: see all customers, connect APIs, trigger syncs
- Daily cron 06:00 UTC: syncs ALL connected integrations automatically

### Analytics pages ✅
- `/dashboard` — KPI cards, revenue chart, department breakdown
- `/staff` — hours, costs, OB supplement, late arrivals (reads from staff_logs DB)
- `/departments` — cost per department, colour-coded
- `/covers` — daily revenue detail (rename to /revenue pending)
- `/tracker` — monthly P&L, manual entry
- `/forecast` — predicted revenue vs actual
- `/budget` — cost targets
- `/invoices` — Fortnox documents
- `/alerts` — AI-detected anomalies
- `/ai` — Claude assistant with business context

### Data integrations ✅
- **Personalkollen adapter**: shifts, costs, OB types, food/drink split, covers
- **Sync engine**: per-integration, auto-detects business_id, upserts to DB
- **Master cron**: all businesses, all orgs, daily, zero config for new customers

### Database schema ✅
- All tables have org_id + business_id for multi-tenant isolation
- RLS policies on all tables
- Encrypted API key storage (AES-256-GCM)
- staff_logs columns: hours_worked, cost_actual, ob_supplement_kr, ob_type, is_late, late_minutes, costgroup_name, staff_name, staff_group, shift_date, real_start, real_stop
- revenue_logs columns: revenue, covers, food_revenue, drink_revenue, tip_revenue, dine_in_revenue, takeaway_revenue

---

## Session 6 — COMPLETED ✅

### Phase 1 — Must do (ALL COMPLETED)
| Item | Status | Notes |
|------|--------|-------|
| 1. Terms of service | ✅ **COMPLETE** | Live at `/terms` — Version 1.0 effective 11 April 2026 |
| 2. Admin password → env var | ✅ **COMPLETE** | Using `ADMIN_SECRET` env var in `.env.local`, checked via `/api/admin/auth` |
| 3. Signup confirmation email | ✅ **COMPLETE** | According to user confirmation |
| 4. Forecast empty state | ✅ **COMPLETE** | Loading state with "Loading forecasts..." message |
| 5. Sync status visible | ✅ **COMPLETE** | "Synced just now" / "Synced Xh ago" in sidebar with green indicator |
| 6. Onboarding completion state | ✅ **COMPLETE** | `setupPending` state in dashboard with "Setting up your data..." banner |
| 7. Wire Stripe billing | ✅ **COMPLETE** | Checkout flow in `/upgrade` page calling `/api/stripe/checkout` |

### Phase 4 — Clean up (ALL COMPLETED)
| Item | Status | Notes |
|------|--------|-------|
| Delete beta, changelog, notebook pages | ✅ **COMPLETE** | All directories removed: `/beta`, `/changelog`, `/notebook` |
| Delete VAT, revenue-split pages | ✅ **COMPLETE** | Directories removed: `/vat`, `/revenue-split` |
| Delete orphaned API routes | ✅ **COMPLETE** | Routes removed: `/documents`, `/pos-connections`, `/supplier-mappings`, `/chat` |
| Fix or disable weekly digest cron | ✅ **COMPLETE** | Updated to use POST method and Bearer token authorization |

### AI cost control (PARTIALLY COMPLETED)
| Item | Status | Notes |
|------|--------|-------|
| 25. Enforce AI query limits at API level | ✅ **COMPLETE** | Implemented in `/api/ask/route.ts` with daily counter and 429 response |
| 26. AI add-on upsell (+299 kr/mo) | ✅ **COMPLETE** (2026-04-17) | `AiLimitReached` card in AskAI panel with trial vs paid branches; `/upgrade?focus=ai` scroll+highlight; Booster card visible to trial users with "upgrade a plan first" state |

---

## Session 7 — COMPLETE ✅

| Item | Description | Status |
|------|-------------|--------|
| 8. Public landing page | Marketing page at comandcenter.se | ✅ **COMPLETE** — live at `/`, logged-in users redirect to `/dashboard` |
| 9. Sentry error monitoring | Know about issues before customers do | ✅ **COMPLETE** |
| 10. Fix sync timeout | Chunked backfill — one month per call | ✅ **COMPLETE** |
| 11. Contextual AI on every page | "Ask AI" button on staff, tracker, dashboard | ✅ **COMPLETE** |
| 12. Rename /covers → /revenue | "Covers" is wrong term for this page | ✅ **COMPLETE** |
| 13. Mobile dashboard, staff, tracker | KPI cards must stack on phones | ✅ **COMPLETE** (2026-04-17) — `.kpi-row` class with 4→2→1 breakpoints applied to dashboard, staff, tracker; landing page nav fixed at <480px; AI FAB repositioned above mobile bottom nav |
| 14. Schema migrations log | MIGRATIONS.md — record every SQL change (file created) | ✅ **COMPLETE** |

### Session 7 — Inzii POS Integration

| Item | Status | Notes |
|------|--------|-------|
| Inzii POS adapter (`lib/pos/inzii.ts`) | ✅ Built | Tries 8 endpoint patterns against api.swess.se |
| Multi-department DB schema (M005) | ✅ Complete | `department` column + partial unique indexes |
| Admin panel — add dept modal | ✅ Built | InziiDeptModal in `/admin` page |
| Sync engine — Inzii provider | ✅ Built | Stores as `inzii_bella`, `inzii_brus` etc. in revenue_logs |
| Admin panel — show depts | ✅ **NOT A BUG** | Diagnose-inzii endpoint confirmed all 6 depts correctly attached to Vero Italiano — see FIXES.md |
| Inzii API endpoint | ⏳ Unknown | api.swess.se responds but correct path not confirmed |

**Resolved 2026-04-17:** The "0 departments" report was a misread — all 6 Inzii depts are correctly attached to Vero Italiano (Rosali Deli is a separate business with only PK). Expanding Vero's card in the admin panel shows all 6 as expected. Built `/api/admin/diagnose-inzii?org_id=…` for future investigations of this kind.

---

## Session 8 — COMPLETE ✅ (2026-04-17 · data integrity + polish)

This session focused on fixing data-source bugs exposed once tracker_data vs monthly_metrics divergence surfaced, plus closing the remaining items from Session 7's pending list.

### Infrastructure / security
| Item | Status | Notes |
|------|--------|-------|
| M003 SQL run in Supabase | ✅ | `forecast_calibration`, `scheduling_recommendations`, `briefings` tables + `integrations.onboarding_email_sent` column |
| Resend domain verified | ✅ | `comandcenter.se` verified; `digest@commandcenter.se` typo → `digest@comandcenter.se` |
| Git history cleanup | ✅ | Removed `.env.vercel` from 14 local commits after GitHub push-protection blocked; ANTHROPIC_API_KEY rotated |
| Vercel CLI installed + project linked | ✅ | `vercel logs`, `vercel env pull`, `vercel ls` now available |

### Data-source audit (tracker_data → monthly_metrics)
Root cause: aggregate reads were hitting `tracker_data` (only holds manual P&L entries), not `monthly_metrics` (auto-aggregated POS + PK sync). For Vero Italiano this meant e.g. April revenue = 115k (manual) shown instead of 485k (real). Fixed across:

| File | Fix |
|------|-----|
| `app/api/forecast/route.ts` | Actuals from monthly_metrics, tracker_data fallback for food_cost |
| `app/api/budgets/route.ts` | Same pattern, plus fixed page shape mismatch (`{year, months}` vs array) |
| `app/forecast/page.tsx` | Normalised `depts` to string[] so drill-down expansion renders dept breakdown |
| `lib/sync/engine.ts → generateForecasts` | History from monthly_metrics so rolling avg is ~1.7M kr/mo not 38k |
| `lib/alerts/detector.ts` | Anomaly baseline no longer fires false positives against empty 2024 manual rows |
| `lib/ai/buildContext.ts` | AI assistant answers with real synced revenue, not partial manual entries |
| `app/api/cron/forecast-calibration/route.ts` | Calibration actuals + DOW factors from monthly/daily_metrics |

### AI agent cleanup
| Item | Status | Notes |
|------|--------|-------|
| Onboarding-success cron bugs | ✅ | `integration_type` → `provider`, `users` table → `auth.admin.getUserById`, `subscription_plan` → `plan`, added 48h safety window so the cron can never mass-email ancient integrations |
| Enhanced Discovery cron | ✅ | Status filter `active` → `connected`, rewrote `fetchSampleData` to do live PK API sample fetch instead of broken `sync_logs` query, skipped integrations get `last_enhanced_discovery_at` stamped so they rotate |
| AI usage tracking unified | ✅ | New `lib/ai/usage.ts` with `checkAiLimit` / `incrementAiUsage` — applied to `/api/ask`, `/api/budgets/generate`, `/api/budgets/analyse`; all AI calls now count against daily plan limit |

### New features
| Feature | Notes |
|---------|-------|
| Budget: "Generate with AI" | `/api/budgets/generate` — reads last year + forecasts + YTD, Claude Haiku returns 12-month budgets with reasoning; review modal with Apply-all |
| Budget: per-month "Analyse" | `/api/budgets/analyse` — conditional prompt only includes metrics with data (no food-cost commentary if food_cost is 0); verdict-tinted modal with color-coded metric cards + recommendations |
| Scheduling redesign | Bar charts removed; labour % hero + 7-day scorecard cards + clickable drill-down modal; W/M navigator replaces date picker; new `/api/scheduling/day-details` endpoint |
| Departments redesign | Bar chart removed; table matches dashboard style with new Profit column; rows sorted by revenue |
| Landing page copy | Value-focused wording (removed Personalkollen/Fortnox specifics from hero + meta); mobile nav fits on 375px |

### Outcome
Everything from the original Session 7 build list is now live. Product is functionally complete. Next phase is UX redesign.

---

## Session 9 — Admin Panel ✅ COMPLETE (2026-04-17 · Phase 1 + 2)

Full operator tooling for customer support + agent management. Replaces the flat org-list view in /admin with a lifecycle-aware pipeline and per-customer god-pages.

### Phase 1 — Customer tooling
| Item | Status |
|------|--------|
| `/admin/customers` pipeline view (New · Setup · Active · At Risk · Churned) | ✅ |
| `/admin/customers/[orgId]` god-page (header · setup request · team · integrations · alerts · agents · timeline · notes) | ✅ |
| Impersonation via Supabase magic-link | ✅ |
| Per-customer agent feature flags (enable/disable) + enforcement in all 6 agents | ✅ |
| Manual "Run now" agent triggers sending real emails | ✅ |
| Internal support notes | ✅ |
| Timeline event feed (signup · setup · integrations · syncs · alerts · admin actions · notes) | ✅ |
| Onboarding metadata capture (M008 — step + metadata columns) | ✅ |

### Phase 2 — System tooling
| Item | Status |
|------|--------|
| `/admin/overview` KPI dashboard (MRR, signups, at-risk, cron strip, critical alerts, recent signups + setup requests) | ✅ |
| `/admin/agents` cross-customer agent runs dashboard | ✅ |
| `/admin/health` cron status + AI spend + sync success rate + integration error feed | ✅ |
| Shared `AdminNav` component across all admin pages | ✅ |

### Phase 3 (future — not urgent)
- Broadcast email to all customers
- Signup funnel analytics
- Plan-change UI (currently Stripe dashboard link-out)

---

## Session 10 — AI differentiation + chart rebuild 🔄 (2026-04-19 → 2026-04-20)

Session pivoted from the original UX-redesign plan (docs/ux-redesign-spec.md) to executing `docs/AI-ROADMAP.md` once Paul decided the product's differentiation story was weaker than its build quality. UX redesign remains queued after this.

### Feature 1 — Weekly AI Manager ✅ SHIPPED
| Item | Status |
|------|--------|
| 12-week context packer (daily_metrics + dept + alerts + budget) | ✅ |
| Strict-constraint memo prompt (≤200 words, 3 SEK-cited actions) | ✅ |
| Template HTML replaced with AI narrative | ✅ |
| Thumbs 👍/👎 feedback loop in emails → `memo_feedback` table (M016) | ✅ (2026-04-20) |
| Two-step feedback UX (confirm → optional comment) to dodge Gmail prefetch | ✅ |
| Admin memo-preview page for QA + demos | ✅ |
| Admin agents card shows 30-day up/down rollup + last comment | ✅ |
| Schedule AI-comparison page (replaces PK write-back idea) | ✅ |

### Feature 4 — Weather-aware intelligence ✅ MOSTLY SHIPPED
| Item | Status |
|------|--------|
| Open-Meteo fetcher, city-coord lookup, WMO→label mapping | ✅ |
| Weather in weekly memo (forecast + historical correlation) | ✅ |
| Historical backfill + `weather_daily` + `/weather` correlation page | ✅ |
| Weather-adjusted scheduling target hours | ✅ |
| Forecast-day horizon bumped 10 → 16 (was cutting off next-week Thu–Sun) | ✅ (2026-04-20) |
| Live `getForecast()` fallback in scheduling (weather_daily forecast rows go stale) | ✅ (2026-04-20) |
| Revenue/weather regression | ⏳ Gating on data volume (3 months) |
| Anomaly-detection false-positive suppression | ⏳ Needs a daily anomaly detector first — current is monthly |

### Scheduling AI — asymmetric cuts-only policy ✅ (2026-04-20)
Liability rule: never recommend adding hours. A cut that's too aggressive still saves money; an add-suggestion that doesn't pay off makes the customer worse off. Enforced in three places:
- `/api/scheduling/ai-suggestion` — `targetHours = min(currentHours, modelTarget)`, delta ≤ 0
- `/scheduling/ai` table — KPI becomes "Saving" (never "extra cost"); note-days show soft language
- Memo prompt — "all actions must be cost-saves / mix shifts / pricing / supplier asks, never staff up"

Also merged `/scheduling/ai` into `/scheduling` (one page, prominent indigo CTA banner + inline AI-suggested schedule card below the pattern grid). Legacy route → redirect.

### Dashboard overview chart rebuilt ✅ (2026-04-20)
Three iterations in one session:
1. Added predictions + weather + margin info on top of the existing stacked bar → "table is broken"
2. Rebuilt as day-card grid → "use a line, not cards; make month work too"
3. Final: `components/dashboard/OverviewChart.tsx` — SVG bars (revenue actuals + indigo-striped predictions, labour bars below zero line, green margin polyline), period dropdown (7 weeks + 7 months), W/M toggle, calendar day-filter (click-to-toggle + shift-click-range), compare toggle (None/Prev/AI) with per-day whiskers, 4 KPI strip recomputing from visible days, floating tooltip with coloured-border sections. URL params sync `view/offset/cmp/days` for shareable links. Click-to-drill scaffolded for future `/dashboard/day/[date]`.

### Session 10 open threads
- `/dashboard/day/[date]` drill-down page (OverviewChart's `onDayClick` is a no-op today)
- Feature 2 — Conversational P&L with receipts (blocked on `pk_products` price history + Fortnox food-cost detail)
- Feature 3 — Cash runway MVP (unblocked — manual bank-balance entry + recurring costs + payroll forecast)
- Anomaly detection: ship a daily detector so weather-suppression can plug in

### Original UX redesign (deferred)
Full spec at `docs/ux-redesign-spec.md`, mockup at `docs/commandcenter-v2.html`. Recon preserved in memory. Do not start until Paul explicitly says so.

---

## Future — Blocked / Scale

### Blocked on external dependency
| Item | Blocker | When |
|------|---------|------|
| Fortnox OAuth | Developer account approval pending | When approved |
| POS adapter | Need to know which POS next customer uses | When known |
| Weekly digest email | ~~Resend domain not verified~~ | ✅ Resolved 2026-04-17 |

### Scale features (20+ customers)
| Item | Description |
|------|-------------|
| Staging environment | Test on preview branch before prod |
| TypeScript properly enabled | One session to remove ts-nocheck debt |
| Health monitoring with alerts | UptimeRobot + cron success logging |
| Subscription pause | Seasonal restaurant closures |
| Annual invoice option | Swedish B2B expects PDF invoice |

---


---

## AI Agents — ALL 6 BUILT ✅

| Agent | Schedule | Plan | Build effort | Status |
|-------|----------|------|-------------|--------|
| Anomaly detection | Nightly 05:30 UTC | All | 3 hrs | ✅ **COMPLETE** — updated thresholds and email alerts |
| Onboarding success | On first sync (inline) + daily 08:00 UTC (cron safety net) | All | 2 hrs | ✅ **COMPLETE** — inline path from sync engine + cron bugs fixed 2026-04-17 (provider col name, auth.admin.getUserById, plan col name, 48h safety window) |
| Monday briefing | Monday 06:00 UTC | Pro+ | 4 hrs | ✅ **COMPLETE** — Resend domain verified 2026-04-17, digest@ typo fixed |
| Forecast calibration | 1st of month 04:00 UTC | Pro+ | 4 hrs | ✅ **COMPLETE** — M003 tables live 2026-04-17, runs 04:00 UTC on 1st of month |
| Supplier price creep | 1st of month 05:00 UTC | Pro+ | 3 hrs | ✅ **SKELETON BUILT** — waiting for Fortnox OAuth |
| Scheduling optimisation | Monday 07:00 UTC | Group | 6 hrs | ✅ **COMPLETE** — M003 tables live 2026-04-17, runs Monday 07:00 UTC, uses Sonnet 4-6 |

**Total cost at 50 customers**: ~$5/month using Haiku 4.5 (was $15 with Sonnet — 67% saving)
**Model used**: All agents use `claude-haiku-4-5-20251001` except scheduling optimisation which uses `claude-sonnet-4-6`
**Rule**: Never hardcode model strings — always import from `lib/ai/models.ts`
**Total build effort**: 22 hours across all 6 agents

### SQL needed before building agents
```sql
-- Run in Supabase before starting agent builds
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

ALTER TABLE integrations ADD COLUMN IF NOT EXISTS onboarding_email_sent BOOLEAN DEFAULT false;
```

## Backlog — Build when there is customer demand

| Feature | Notes |
|---------|-------|
| Language toggle EN/SV | After first 10 paying customers |
| BankID auth | Swedish enterprise requirement |
| Visma integration | Alternative to Fortnox |
| Open Banking / Tink | Real-time bank data |
| Multi-currency | Groups with non-Swedish locations |
| Mobile app (React Native) | Post product-market fit |
| Competitor benchmarking | Anonymised industry avg when 10+ customers |

---

## Pages to Remove (Session 6)

| Page | Why remove |
|------|-----------|
| /beta | Half-built, not linked, will break |
| /changelog | Half-built, not linked, will break |
| /notebook | Replaced by /ai — duplicate confusing |
| /vat | No customer asked for it |
| /revenue-split | No customer asked for it |

## API Routes to Remove (Session 6)

| Route | Why remove |
|-------|-----------|
| /api/documents | No connected frontend |
| /api/pos-connections | No connected frontend |
| /api/supplier-mappings | No connected frontend |
| /api/chat | Duplicate of /api/ai |

---

## Pricing & Commercial Model

### Plans
| Plan | Price | AI queries/day | Businesses |
|------|-------|---------------|------------|
| Starter | 499 kr/mo/business | 20 | 1 |
| Pro | 799 kr/mo/business | 50 | Up to 5 |
| Group | 1,499 kr/mo/business | Unlimited | Unlimited |
| AI add-on | +299 kr/mo | +100 | Any |

### Annual billing (push to every customer)
- 2 months free = 10 months price for 12 months
- Starter annual: 4,990 kr upfront
- Pro annual: 7,990 kr upfront
- Group annual: 14,990 kr upfront

### Break-even
- 2 customers at 499 kr = covers all infrastructure costs
- 52 customers at 799 kr = full-time income equivalent (40,000 kr/mo)
- 50 customers target = ~75,700 kr/mo profit at 95% gross margin

---

## Database Migrations Needed (run these in Supabase before Session 6 builds)

```sql
-- Already run (do not re-run):
-- ALTER TABLE staff_logs ADD COLUMN IF NOT EXISTS ob_type TEXT;
-- ALTER TABLE revenue_logs ADD COLUMN IF NOT EXISTS food_revenue INTEGER DEFAULT 0;
-- ALTER TABLE revenue_logs ADD COLUMN IF NOT EXISTS drink_revenue INTEGER DEFAULT 0;

-- Needed for Session 6:
-- AI query tracking
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  query_count INTEGER DEFAULT 0,
  UNIQUE(org_id, date)
);
ALTER TABLE ai_usage_daily ENABLE ROW LEVEL SECURITY;
```

---

*Last updated: Session 10 — 2026-04-20*
*Next action: `/dashboard/day/[date]` drill-down, then Feature 3 cash-runway MVP, then Feature 2 conversational P&L (blocked on Fortnox)*

