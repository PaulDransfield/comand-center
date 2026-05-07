# CLAUDE CODE — FORTNOX API BACKFILL · PHASE 1: VERIFICATION
> Generated 2026-05-07
> First phase of a 4-phase build. Read-only investigation + small comparison build.
> Companion documents: `STRATEGY.md`, `ROADMAP.md`, `FORTNOX-DIAGNOSTIC-2026-05-07.md`

---

## What this is and what it isn't

This is **Phase 1 of building API-driven Fortnox onboarding** for new CommandCenter customers. The end goal of the full build (Phases 1-4) is: a new customer signs up, clicks "Connect Fortnox," waits ~15 minutes for backfill, and sees their last 12 months of data without anyone on the CommandCenter side intervening.

**This phase does not ship that flow.** This phase answers two questions so we can scope Phase 2 confidently:

1. What's the current state of the Fortnox API client code — what endpoints are actually called in active sync flows vs defined-but-unused?
2. If we fetch 90 days of vouchers from the API and run them through the existing aggregator, do the resulting metrics match what's already in production (which came from PDF upload)?

Question 1 is read-only investigation. Question 2 is a small focused build — a "shadow mode" comparison that writes to alternate tables so production data stays untouched.

The deliverable is a single markdown report. No customer-facing changes. No production data modifications. No new endpoints exposed externally.

---

## Pre-flight

Read these before starting, in this order:

- `CLAUDE.md` — operational rules, Supabase footguns, sign convention discipline
- `FORTNOX-DIAGNOSTIC-2026-05-07.md` — the existing diagnostic, particularly sections 1-3
- `lib/fortnox/` — every file
- `lib/finance/conventions.ts` and `lib/finance/projectRollup.ts` — sign discipline (do not deviate)
- `vendor/fortnox-openapi.json` if present (1.4MB, browse don't memorize)
- Any cron handler in `app/api/cron/*` that calls into Fortnox flows
- Any `M*.sql` migration referencing `tracker_data`, `daily_metrics`, `monthly_metrics`, `revenue_logs`, `vat_breakdown`

Don't read every file in the codebase. Read what's directly relevant to the questions in this phase.

---

## Hard constraints

- **Read-only against production data.** Phase 1 writes only to new tables prefixed `verification_*` (you'll create these). Never UPDATE or DELETE rows in `tracker_data`, `daily_metrics`, `monthly_metrics`, `revenue_logs`, `vat_breakdown`, `dept_metrics`, `financial_logs`, or any other table that today serves customer-facing data.
- **Do not make live Fortnox API calls outside Vero's account.** The only org with valid OAuth tokens is Vero (org_id `e917d4b8-635e-4be6-8af0-afc48c3c7450`). Use that token. No test mode, no other accounts.
- **Respect Fortnox's rate limit: 25 requests per 5 seconds per access token.** Build in proper backoff. A 12-month voucher backfill at maximum rate is around 8-15 minutes; for 90-day verification it's much shorter.
- **Do not modify the existing PDF flow** in any way. The aggregator that processes PDF data continues to work as it does today. Phase 1 builds a parallel path; it does not replace anything.
- **Do not change sign conventions** anywhere in `lib/finance/`. Storage convention stays: revenue positive, costs positive, financial signed.
- **Do not widen `@ts-nocheck`** anywhere. Keep new code typed properly.
- **Do not commit secrets.** Reuse the existing OAuth token storage; don't paste tokens into code or logs.
- **Do not deploy this to production.** All work happens on a feature branch. The verification harness runs locally or in a dev environment only.

---

## The two questions, in detail

### Question 1: Endpoint usage audit

The Fortnox diagnostic claimed "88 of 233 endpoints are used." The schema diagnostic showed only `fortnox_uploads` and `fortnox_supersede_links` exist as Fortnox-named tables. This implies the API client code may *define* many endpoints but may not *actively use* most of them in sync flows.

Investigate and document:

- Every function in `lib/fortnox/` that wraps a Fortnox API call. List the endpoint, HTTP method, and the function name.
- For each function, find every call site in the codebase. List the file and line.
- Categorize each function by call status:
  - **Active in cron**: called from a scheduled job (specify which cron)
  - **Active in apply flow**: called when a customer applies a Fortnox upload or syncs on demand
  - **Active in admin/debug only**: called only from admin endpoints
  - **Defined but never called**: orphaned code
  - **Tested only**: called from test files but not production paths
- For every "active" function, note what it returns and whether the result is persisted, transformed-and-persisted, or used transiently.

The point of this audit is not to clean up dead code — that's a separate task. The point is to know, with precision, which endpoints we already exercise in production and which we'd be calling for the first time during a Phase 2 backfill build.

### Question 2: Aggregation precision comparison

If we re-derive metrics for Vero's last 90 days using API-fetched vouchers instead of PDF-extracted Resultatrapport data, do the resulting numbers match what's currently in `tracker_data` / `monthly_metrics` / `daily_metrics`?

This is the load-bearing question for Phase 2. If the answer is "yes, within tolerable precision," the API path can replace the PDF path for new customers and Phase 2 is real. If the answer is "no, materially different," we've discovered something important before committing to the bigger build — the PDF path is doing reconciliation work the API doesn't replicate, and we need a different architecture (probably hybrid).

Build a comparison harness that:

1. Fetches all vouchers for Vero (`org_id = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'`) for the period 2026-02-07 to 2026-05-06 (90 days back from today) via `GET /3/vouchers?fromdate=...&todate=...`.
2. Runs each voucher through the existing classifier and aggregator logic, producing the same domain model rows that the PDF path produces.
3. Writes the results to new tables: `verification_tracker_data`, `verification_monthly_metrics`, `verification_daily_metrics`, etc. Same schema as the production tables, just prefixed.
4. Computes a comparison report: for each metric (revenue, food cost, staff cost, depreciation, financial, VAT, alcohol cost, by month and by day), what's the absolute difference and percentage difference between API-derived and PDF-derived values?

Specifically the report should call out:

- **Exact matches** (difference < 0.01 SEK) — these are good
- **Tolerable drift** (difference < 1% AND < 100 SEK absolute) — flagged for review but acceptable
- **Material drift** (anything else) — these are the findings that determine whether Phase 2 proceeds as planned

For material drift cases, dig into one or two specific examples. Walk back from "March 2026 food cost differs by 4%" to "the API path includes voucher series X but the PDF path categorizes voucher series X as Y." This kind of root-cause is what's actually useful — a number alone tells you something diverges; the diagnosis tells you whether it's fixable.

---

## What to build

### 1. Database migrations

Add a migration file `M035-VERIFICATION-TABLES.sql` (or whatever the next available migration number is — check `MIGRATIONS.md`). It creates the `verification_*` tables with the same schema as production tables. Include:

```sql
-- Mirror schema from production tables, prefix with verification_
-- These are throwaway analysis tables; safe to TRUNCATE between runs.
CREATE TABLE IF NOT EXISTS verification_tracker_data (LIKE tracker_data INCLUDING ALL);
CREATE TABLE IF NOT EXISTS verification_monthly_metrics (LIKE monthly_metrics INCLUDING ALL);
CREATE TABLE IF NOT EXISTS verification_daily_metrics (LIKE daily_metrics INCLUDING ALL);
CREATE TABLE IF NOT EXISTS verification_dept_metrics (LIKE dept_metrics INCLUDING ALL);
CREATE TABLE IF NOT EXISTS verification_revenue_logs (LIKE revenue_logs INCLUDING ALL);
CREATE TABLE IF NOT EXISTS verification_vat_breakdown (LIKE vat_breakdown INCLUDING ALL);
CREATE TABLE IF NOT EXISTS verification_financial_logs (LIKE financial_logs INCLUDING ALL);
```

`LIKE source INCLUDING ALL` copies columns, defaults, constraints, and indexes. If any source table has triggers that don't make sense in verification, drop them on the verification copy.

Add to `MIGRATIONS.md` under "Pending" with a note: "Verification harness only. Safe to drop after Phase 1 completes."

Paul applies this when ready.

### 2. The voucher fetcher

If a function already exists in `lib/fortnox/` to fetch vouchers via API, use it. Note that you used the existing function in your report.

If no such function exists (likely outcome based on the diagnostic — most active calls are PDF-related), build a minimal one in `lib/fortnox/api/vouchers.ts`:

```ts
// Minimal voucher fetcher for Phase 1 verification.
// Production-quality fetcher with pagination, retry, etc. is built in Phase 2.

interface VoucherFetchOptions {
  orgId: string
  fromDate: string  // YYYY-MM-DD
  toDate: string    // YYYY-MM-DD
}

export async function fetchVouchersForRange(opts: VoucherFetchOptions): Promise<FortnoxVoucher[]> {
  // 1. Get OAuth token from fortnox_tokens for opts.orgId
  // 2. Call GET /3/vouchers?fromdate=...&todate=... with pagination
  // 3. For each voucher in the list response, call GET /3/vouchers/{series}/{number}
  //    to get the full voucher with rows (the list endpoint may return summary only)
  // 4. Respect rate limit: 25 req/5sec, simple sliding-window throttle
  // 5. Return the array of full vouchers
}
```

Keep it minimal. Don't build the full Phase 2 fetcher with state tracking and resume — that comes later. This is a one-off run for verification.

### 3. The aggregation runner

This is the load-bearing piece. It needs to take a list of vouchers and produce the same domain model rows the PDF path produces.

The right approach depends on what you find in Question 1's audit. Two possibilities:

**If the existing aggregator already accepts something close to voucher-shaped input** (most likely if the apply flow has any kind of structured intermediate representation), call it directly with the API-fetched vouchers as input. Document any transformation needed.

**If the existing aggregator is tightly coupled to PDF-extracted shape**, write a translation layer in `lib/fortnox/api/voucher-to-aggregator.ts` that takes API voucher JSON and produces the shape the existing aggregator expects. Don't rewrite the aggregator. Don't create a parallel aggregator. Translate the input.

Either way, route the output to the `verification_*` tables, not the production tables. The simplest way is a flag on the writer: `writeTarget: 'production' | 'verification'`. If the writer is `projectRollup`, that single flag changes the destination tables it writes to.

If you find that the existing writer can't easily be redirected without significant refactoring, fall back to writing a thin parallel writer that copies the production write logic but targets `verification_*` tables. Document why you needed to do this.

### 4. The comparison report generator

Once `verification_*` tables are populated, generate a comparison report. Write it as `verification-report.ts` in `scripts/` or wherever ad-hoc scripts live.

The report should output a markdown file `FORTNOX-VERIFICATION-REPORT-2026-05-07.md` with these sections:

**Executive summary** — three or four sentences: did API-derived numbers match PDF-derived numbers, and at what level of precision?

**Method** — what date range, what voucher count, what tables compared.

**Match summary** — counts of exact match, tolerable drift, material drift. Per-metric breakdown.

**Material drift findings** — for each material drift, what's the root cause (or "root cause unknown, needs investigation"). Concrete numeric examples.

**Implications for Phase 2** — what the report tells us about whether Phase 2 should proceed as planned, scope-up, or pivot to a hybrid approach. Frame as fact-based observation; don't editorialize.

---

## Deliverables

When Phase 1 is complete, the repo should have:

1. `M035-VERIFICATION-TABLES.sql` — the migration creating verification tables
2. `lib/fortnox/api/vouchers.ts` (or equivalent) — the minimal API fetcher, only if not already existing
3. Either a minor change to the existing aggregator (a write-target flag) or `lib/fortnox/api/voucher-to-aggregator.ts` — depending on what you find
4. `scripts/verification-runner.ts` — the script that runs the fetch → aggregate → write pipeline
5. `scripts/verification-report.ts` — the script that generates the comparison report
6. `FORTNOX-VERIFICATION-REPORT-2026-05-07.md` — the report itself, at repo root
7. `FORTNOX-API-AUDIT-2026-05-07.md` — the answer to Question 1 (endpoint usage audit), at repo root

If migration M035 hasn't been applied (Paul applies migrations manually), note that in your final summary so Paul knows to apply it before running the verification scripts.

The `FIXES.md` doesn't get a new section for this work because nothing is being *fixed*. It's pure investigation. Don't add a FIXES entry.

---

## End-of-phase checkpoint

When everything is built and the report is generated, present these to Paul:

1. The endpoint audit (Question 1 answer)
2. The verification report (Question 2 answer)
3. A short paragraph: "Phase 2 readiness assessment" — based on what you found, does the original Phase 2 scope still make sense? Are there material findings that change the build plan?

The third item is the only place where you offer a forward-looking assessment. Everything else is fact-reporting. Even the assessment should be brief and clearly framed as observation: "if precision matched well, Phase 2 proceeds as planned; if material drift was found, the gap is X and Phase 2 needs to address Y."

Then stop. Don't write the Phase 2 prompt. Don't open PRs to the production data flow. Don't propose other improvements you noticed along the way (note them in your summary as "out of scope, observed during this work" but don't act on them).

Paul will read the deliverables, decide with the advisor whether Phase 2 starts as planned or needs scope adjustment, and write the Phase 2 prompt at that point.

---

## Time budget

This is genuinely 4-7 days of focused work. Breakdown:

- Question 1 audit: 0.5-1 day (mostly reading code)
- Migration + verification table setup: 0.25 day
- Voucher fetcher (if needed): 0.5-1 day
- Aggregation routing/translation: 1-2 days (this is the wildcard — depends on what you find)
- Verification runner script: 0.5 day
- Report generator: 0.5-1 day
- Running, debugging, regenerating reports as you find issues: 0.5-1 day

If you're past day 7 still working, surface what's hard and discuss with Paul before continuing. The risk is spending two weeks on this when the right move is "this is harder than expected, escalate."

Don't over-optimize. The verification harness is throwaway code. It needs to be correct enough to trust the output, not production-grade clean. If you find yourself reaching for clever abstractions, stop — write the dumb obvious version.

---

## What success looks like

When this is done:

- We know exactly which Fortnox endpoints are actively used in production today
- We know whether API-derived data can produce the same metrics as PDF-derived data, to what precision, with what exceptions
- The next conversation between Paul and the advisor has the data it needs to scope Phase 2 properly
- Production is untouched — Vero's dashboard shows the same numbers it showed yesterday
- The verification harness exists and can be re-run later if needed, but isn't load-bearing for anything customer-facing

If the verification reveals that API-derived numbers match within tolerable precision, you've de-risked Phase 2. If it reveals material drift, you've saved 4+ weeks of building something that wouldn't have worked as designed.

Either outcome is success. Don't bias the report toward "yes, looks good, proceed." Bias it toward truth.

---

## When done

Tell Paul: "Phase 1 is complete. The two reports are at `FORTNOX-API-AUDIT-2026-05-07.md` and `FORTNOX-VERIFICATION-REPORT-2026-05-07.md`. Migration M035 [is/is not] applied. Vero's production dashboard is unchanged. Ready for review with the advisor."

Then stop. Don't propose Phase 2. Don't suggest code improvements. Don't open follow-up PRs.

The advisor and Paul will decide what comes next based on what the reports say.
