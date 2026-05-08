# Architecture Review Prompt — v2

> Read-only critique of `prompts/PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v2.md` against codebase reality.
> This is the **second pass**. v1 was reviewed and produced `ARCHITECTURE-REVIEW-2026-05-08.md`. v2 incorporates that review's corrections plus three product decisions:
> - **Decision 1:** build proper owner-confirm workflow on `anomaly_alerts` (Piece 0)
> - **Decision 2:** truncate audit log inserts to once per (business, date, surface) per day
> - **Decision 3:** add Piece 4.5 for owner-flagged events
>
> Output: a markdown report at the repo root titled `ARCHITECTURE-REVIEW-V2-2026-05-08.md`.
> Time budget: 60-90 minutes (shorter than v1 because the review surface is smaller — most fundamentals are settled).

---

## Your job

Validate v2 against codebase reality. **Two specific questions to answer:**

1. **Did v2 correctly fix everything in the v1 review?** Walk through `ARCHITECTURE-REVIEW-2026-05-08.md` Section 9 (what's wrong) and Section 10 (recommendations). For each must-fix, confirm it's resolved in v2. For each should-fix, confirm it's resolved or the doc explicitly punts it.

2. **Did v2 introduce new issues?** New material in v2 includes:
   - The anomaly-confirm workflow (`confirmation_status`, API endpoints, UI changes)
   - Piece 4.5 (`owner_flagged_events` table, API, UI)
   - The expanded Piece 0 timeline
   - The change-driven LLM activation logic
   - The Vero backfill code in Section 5
   - The cluster column additions to `businesses`
   - The deprecation of `forecast_calibration.dow_factors` and disabling of its cron

For each new piece: does it work with the actual codebase, or are there issues?

You are still a critic, not an implementer. Find what's wrong. **Be honest. Don't soften.**

---

## What to do

1. Read v2 end to end first. Take notes.
2. Have v1 review (`ARCHITECTURE-REVIEW-2026-05-08.md`) open as a checklist.
3. Validate against actual code, schemas, and data.
4. Produce the v2 review report.

---

## What NOT to do

- Do NOT implement anything.
- Do NOT propose new features outside what v2 introduces.
- Do NOT re-litigate the open decisions in v2 Section 10. Those are the user's call.
- Do NOT re-find issues that are already correctly addressed in v2 — focus on what's still wrong or newly wrong.
- Do NOT compare every paragraph to v1 — focus on substantive changes only.

---

## Sections to cover in your report

### Section 1 — v1 review checklist resolution

Walk through `ARCHITECTURE-REVIEW-2026-05-08.md` Section 9 (the 10 "what's wrong" items) and Section 10 (must-fix and should-fix recommendations). For each, mark: **RESOLVED**, **PARTIAL**, **NOT RESOLVED**, or **PUNTED** (explicitly deferred to a later piece with a reason).

Be specific. "RESOLVED — Section 2 DDL now includes org_id at line X, full RLS block at lines Y-Z, retention RPC matches M020 pattern" is useful. "RESOLVED" alone is not.

### Section 2 — Anomaly-confirm workflow validation

The biggest new piece. Validate:

1. Does `ALTER TABLE anomaly_alerts ADD COLUMN confirmation_status ...` cleanly slot into the existing schema? Any conflicts with `is_dismissed`, `is_read`, or other existing fields?
2. Are there existing rows in `anomaly_alerts` (Vero has some — investigation found 11 most recent alerts including 7 OB-supplement). What status do they get on migration? Default `'pending'` is reasonable, but the dashboard pill UI needs to handle the existing rows gracefully — does the v2 spec address this?
3. The proposed API endpoints (`POST /api/anomalies/:id/confirm`, `/reject`) — does the existing `app/api/alerts/route.ts` follow this pattern, or is the namespace inconsistent (`/anomalies/` vs `/alerts/`)?
4. The dashboard alert pill — what does it currently look like in the codebase? Does adding two buttons fit cleanly with the existing component, or is this a meaningful UI rework?
5. RLS / authorization on the confirm endpoints: who can confirm an anomaly? Org member? Admin only? Does this match the existing alert dismissal pattern?
6. The reconciler query in v2 Section 5 uses `confirmation_status = 'confirmed' AND metric = 'revenue'`. Does `anomaly_alerts` have a `metric` column today, or is this assumed to exist?

### Section 3 — Owner-flagged events (Piece 4.5) validation

1. The proposed `owner_flagged_events` schema (business_id, event_date, event_type, description, expected_impact_direction, expected_impact_magnitude). Does this fit with how the LLM adjustment prompt expects to consume it? Cross-reference Section 6 prompt structure.
2. The dashboard UI proposal (`components/dashboard/OwnerEventFlag.tsx`) — what calendar/date-picker patterns does the codebase already use? Should match.
3. Multi-tenant isolation — same RLS pattern as `daily_forecast_outcomes`?
4. What happens when an event is flagged AFTER a prediction has been made? The change-driven LLM activation logic in Section 6 says "a new owner-flagged event has been added/removed for forecast_date" triggers re-adjustment. Confirm this works mechanically — what watches for the event-add and triggers the re-adjustment?

### Section 4 — Schema delta validation

The v2 DDL for `daily_forecast_outcomes` differs from v1. Validate against M020 parity:

1. `org_id` foreign key, ON DELETE CASCADE — matches M020? ✓ or ✗ with reasons
2. RLS read policy — does the SQL exactly match M020's pattern? Any differences?
3. Retention RPC `prune_daily_forecast_outcomes()` — same 3-year window, same return type, same callable-as-cron behavior?
4. Generated column `prediction_horizon_days` — is `GENERATED ALWAYS AS (forecast_date - first_predicted_at::date) STORED` actually valid in Supabase Postgres? (It is in PG12+, which Supabase runs, but worth confirming.)
5. The new `unresolvable_zero_actual` enum value — does this break any consumer querying `resolution_status`?

### Section 5 — Cost & rate limit projection

v2 rebuilt the cost projection at ~6,000 input tokens. Validate:

1. The "summarized recent_reconciliation" claim — is summarization actually mechanically achievable, or does the LLM need 90 raw rows for context? Without a concrete summarizer spec, the 3,000-token estimate for `recent_reconciliation_summary` is hand-wavy.
2. The change-driven activation cap (~10 calls/business/day average). Realistic given the trigger conditions listed?
3. The rate limit mitigations (stagger across an hour, batch API). Are these specified concretely enough to implement, or are they aspirational?
4. The activation criterion "Anthropic API health check passes" — is there an existing health-check endpoint or pattern, or is this new infra?

### Section 6 — Sequencing realism

v2 goes from 17 to 18-19 weeks. Validate:

1. Is the Week 1-3 Piece 0 timeline realistic for the anomaly-confirm workflow? "2-3 days" for the schema + API + UI feels optimistic for the UI portion.
2. The 2-3 year Open-Meteo backfill — bandwidth-bound, but is there an existing backfill pattern (`fortnox-backfill-worker` exists per investigation) we should mirror?
3. The Vero audit ledger backfill in Week 7-8 (Section 5 code). The `dailyForecast({ asOfDate })` option must exist before this backfill runs. v2 specifies the option but doesn't sequence its implementation. Is `asOfDate` a 1-day add or a non-trivial design problem?
4. Phase B switchover Week 10 — splits dashboard, scheduling page, Monday Memo into separate PRs. Realistic effort estimates per PR?
5. Piece 4.5 (Week 15) before Piece 4 (Weeks 16-17) — the LLM adjustment can read owner-flagged events from day 1 of activation. Sequencing is correct.

### Section 7 — Open decisions cross-check

v2 closed 7 of v1's 10 open decisions. Section 10 of v2 lists 9 remaining (A-I). Are these the right open decisions, or are there hidden ones the doc treats as settled but should flag?

Specific things to look for:
- Pattern auto-promotion details (when an LLM-found pattern auto-promotes from `proposed` to `active`)
- The Vero cluster manual pre-population — does it require admin tooling or is it a one-line SQL update?
- The `forecast_calibration` deprecation — is the table fully unused after disabling the cron, or are there other readers?

### Section 8 — Newly missing

What did v2 still not address that should have been addressed?

Specific candidates:
- Database migration ordering — v2 lists 7 new migrations. What order do they run in? Are there foreign key dependencies?
- Concurrent execution — what happens when the consolidated forecaster, the legacy forecaster, and the LLM adjustment all try to write rows for the same `(business, date, surface)` combination at slightly different times?
- The Skolverket scraper — schedule, error handling, what happens when Skolverket changes their data format?
- Operator-facing copy — when the operator confirms an anomaly, what wording does the UI use? "Yes, this was real" vs "Yes, exclude from predictions" — these have different operator mental models.
- Test data — Vero is the only customer. Do we set up a synthetic second business for testing the cluster machinery before customer #5 lands?

### Section 9 — What's wrong (still)

Like v1's Section 9: **Doc says X. Codebase has Y. Implication.** Focus on:
- Anything in v2 that contradicts codebase reality
- Anything that v1 review fixed but v2 reintroduced
- Anything in the new content (anomaly workflow, Piece 4.5, backfill code) that doesn't actually work

### Section 10 — Recommendations

Same format as v1 review:
- **Must-fix:** materially wrong, would break things
- **Should-fix:** missing or ambiguous, would prevent rework
- **Nice-to-have:** improvements, not blocking

Order by importance.

### Section 11 — Sign-off

A direct yes/no with reasoning:

> **Is v2 ready to base implementation prompts on?** YES / NO / WITH-CONDITIONS

If WITH-CONDITIONS, list the specific must-fix items that gate the first implementation prompt (Piece 0).

If YES, the user can proceed to writing the Piece 0 implementation prompt against this architecture.

If NO, what's the specific blocker that requires a v3?

### Section 12 — What you didn't get to

Same as v1: be honest about scope limitations.

---

## Style guidance

- Quote v2 directly when refuting it.
- Quote codebase paths and line numbers.
- If something is RESOLVED from v1, say so briefly and move on. Don't dwell.
- If something is NOT RESOLVED or new, dig in.
- Be specific about effort estimates if you give them.

---

## Time budget

- 10 min: read v2 end to end, take notes
- 20 min: walk v1 review checklist (Section 1)
- 25 min: validate the new pieces — anomaly workflow + Piece 4.5 + backfill (Sections 2-3)
- 20 min: schema, cost, sequencing, missing items (Sections 4-8)
- 10 min: write up Sections 9-12 + sign-off

If a section runs long, prioritize the sign-off (Section 11) — that's what the user actually needs to make a decision on.

---

## Output

Single markdown file at the repo root: `ARCHITECTURE-REVIEW-V2-2026-05-08.md`.

Don't commit it. Just save the file. The user will read it, decide whether to proceed to Piece 0 implementation prompt, address must-fix items first, or request a v3.
