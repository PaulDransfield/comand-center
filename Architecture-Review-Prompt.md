# Architecture Review Prompt

> Read-only critique of `prompts/PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08.md` against codebase reality.
> Output: a markdown report at the repo root titled `ARCHITECTURE-REVIEW-2026-05-08.md`.
> Time budget: 90-120 minutes.

---

## Your job

The architecture document at `prompts/PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08.md` was written from outside the codebase — informed by a prior investigation report but without direct access to the code. Your job is to read it carefully and validate it against actual codebase reality.

You are a critic, not an implementer. Find what's wrong, what's missing, what won't work as described, and what better alternatives exist that the doc author couldn't see.

**Be honest. Don't soften. The architecture is foundational — being wrong now costs months later. Surface every real concern.**

---

## What to do

1. Read the architecture document end to end before touching code. Take notes on claims that are testable against the codebase.
2. For each section, validate against the actual code, schemas, and data.
3. Produce a markdown report at the repo root with the structure specified below.

---

## What NOT to do

- Do NOT implement anything. No code changes, no migrations, no new files.
- Do NOT propose new features that aren't in the architecture doc. The scope is critique, not expansion.
- Do NOT try to be polite. "Looks good!" is useless. If something is wrong, say it's wrong.
- Do NOT re-litigate decisions that are explicitly marked as the user's call in Section 10. Those are theirs to decide.
- Do NOT spend time on cosmetic issues (typos, formatting). Substance only.

---

## Sections to cover in your report

### Section 1 — Schema validation

The doc proposes a parallel `daily_forecast_outcomes` table rather than extending M020's `ai_forecast_outcomes`. Validate:

1. Does the proposed schema actually fit with how M020 is built? Look at the M020 migration, the reconciler cron, and any helpers around it.
2. Are there fields in M020 that the new table should have but doesn't? (Or vice versa — fields the doc adds that M020 has discovered are unnecessary?)
3. Does the proposed `inputs_snapshot` JSONB structure capture every signal the existing forecasters actually use today? Cross-check against `lib/forecast/recency.ts`, `lib/weather/demand.ts`, and the scheduling-AI route.
4. Does the `error_attribution` structure assume any data that isn't actually available at reconciliation time?
5. Are there foreign key, index, or constraint issues with the proposed DDL given how `businesses`, `daily_metrics`, `anomaly_alerts` are actually structured today?

### Section 2 — Code path validation

The doc references specific files and endpoints. For each, confirm it exists and behaves as the doc assumes:

- `app/api/scheduling/ai-suggestion/route.ts`
- `app/api/weather/demand-forecast/route.ts`
- `lib/forecast/recency.ts`
- `lib/weather/demand.ts`
- The existing M020 reconciler cron (whatever it's actually called)
- The master-sync 05:00 UTC cron (whatever it's actually called)
- `daily_metrics` table structure
- `anomaly_alerts` table and its `status = 'confirmed'` filter

For each: does the doc's description match reality? Where it doesn't, document the gap.

### Section 3 — Migration realism

The doc proposes Phase A (shadow mode) → Phase B (switchover) → Phase C (deprecation) for the consolidated forecaster.

1. Can the legacy forecasters actually be instrumented to log to the new audit table without breaking anything? Walk through what would have to change.
2. Is there anywhere downstream that depends on the *exact* shape of `est_revenue` from the scheduling-AI or `predicted_revenue` from weather-demand? If `dailyForecast()` returns a slightly different number, what breaks?
3. Are there UI components, exports, scheduled jobs, or customer-facing surfaces that would need to be updated in Phase B? List them.
4. Is the "log to legacy surfaces for one more month after Phase B" plan actually doable, or does it require keeping the old code running indefinitely?

### Section 4 — Signal feasibility

The doc proposes six new signals. For each, validate:

1. **yoy_same_weekday** — does Vero actually have 12+ months of clean daily_metrics? Are there gaps, schema migrations, or known data-quality issues that would make this lookup unreliable?
2. **klämdag detection** — is the holiday calendar actually present and complete? Does it distinguish holiday types (national, regional, religious)?
3. **school holidays** — confirm there's no existing `school_holidays` table or scraper. If there is, the doc missed it. If there isn't, estimate the realistic effort to build the Skolverket scraper given the per-region complexity.
4. **salary cycle** — straightforward, just date math, but confirm date handling is consistent (timezone, week boundaries) across the codebase.
5. **weather_change_vs_seasonal** — depends on `weather_daily` being fixed. Confirm the migration M015 status: is it applied? Reapplied? Dropped? What does the table actually look like in prod right now?
6. **day_of_month patterns** — any existing per-business calibration infrastructure this should plug into, or is it greenfield?

### Section 5 — Cron timing

The doc proposes 07:30 UTC for the new daily reconciler, after master-sync (05:00) and the M020 reconciler (07:00).

1. Confirm those existing cron schedules — what times do they actually run?
2. Is daily_metrics actually populated by 07:30 for yesterday? POS sync delays and master-sync timing matter here.
3. Are there any cron conflicts, lock contention, or resource issues with adding another job in this window?
4. Is the proposed Sunday 02:00 UTC pattern extraction job realistic given other Sunday workloads?

### Section 6 — Cost projection sanity check

The doc estimates ~$2/business/month at Haiku 4.5 pricing. Validate:

1. Token estimates — is "3,000 input tokens + 400 output tokens per call" realistic given the actual context size required? (Recent reconciliation history alone could be larger than estimated.)
2. Is there an existing Anthropic API spend tracking infrastructure, or is this greenfield?
3. Are there rate limits or quota considerations the doc doesn't account for?
4. The 14-calls-per-business-per-day assumption — is that right? Or do we need predictions on a different cadence?

### Section 7 — Open decisions cross-check

Section 10 of the architecture doc lists 10 open decisions. Read them carefully and answer:

1. Are these the right open decisions, or are there hidden ones the doc treats as settled but shouldn't?
2. For each open decision, is there codebase context that would help the user decide? (E.g. existing privacy policy patterns, existing UX conventions, existing model_version handling.)
3. Are any of the "decided" architectural choices in Sections 1-9 actually decisions that should be flagged as open?

### Section 8 — What's missing

Surface gaps the doc doesn't address. Especially:

1. Error handling and failure modes — what happens when the LLM API is down? When daily_metrics is missing? When the reconciler crashes mid-run?
2. Backfill strategy — the doc assumes audit data accumulates from day 1. What about historical predictions? Is there value in backfilling some kind of "what would have been predicted" baseline for Vero's existing data?
3. Testing strategy — how do we know any of this is working? Unit tests, integration tests, staging environment?
4. Monitoring and alerting — when MAPE drifts, when reconciliation fails, when LLM costs spike — who gets notified and how?
5. Data retention — `daily_forecast_outcomes` will grow. What's the retention policy?
6. Rollback plan — if Phase B switchover causes a regression, what's the procedure to revert?
7. Multi-business isolation — what stops a bug in one business's predictions from affecting another's?

### Section 9 — What's wrong

Explicit contradictions between the architecture and codebase reality. Be specific:

- "Doc says X. Codebase actually has Y. Implication: ..."

This is the most important section. If the doc is wrong about how the existing system works, those errors compound through every downstream piece.

### Section 10 — Recommendations

Given everything above, what should be revised before implementation prompts get written? Order by importance:

1. **Must-fix:** the doc is materially wrong here; implementing as written would break things.
2. **Should-fix:** the doc is missing or ambiguous; clarification would prevent rework.
3. **Nice-to-have:** improvements that aren't blocking but would improve the architecture.

For each, suggest the specific change to the doc.

### Section 11 — What you didn't get to

Be honest. If you ran out of time, didn't have access to certain code, or skipped sections — say so. Don't fake comprehensiveness.

---

## Style guidance

- Plain markdown, no executive-summary fluff.
- Quote the architecture doc directly when refuting it. ("Section 3 claims `lib/forecast/recency.ts` does X. The actual file does Y.")
- Quote codebase paths and line numbers when describing reality.
- Be specific about effort estimates if you give them. "This would take ~2 days" is more useful than "this is hard."
- If you're uncertain about something, say "Uncertain — would need to verify by [...]" rather than guessing.

---

## Time budget

- 15 min: read the architecture doc end to end, take notes
- 30 min: validate Sections 1-3 (schema, code paths, migration)
- 30 min: validate Sections 4-6 (signals, crons, costs)
- 20 min: open decisions, gaps, contradictions
- 15 min: recommendations, write up

If you blow through the budget on a section that's especially fertile, that's fine — finish the analysis there and submit a partial report rather than rushing the rest. A thorough Section 9 ("what's wrong") with skipped Section 7 is more useful than a shallow pass over everything.

---

## Output

A single markdown file at the repo root: `ARCHITECTURE-REVIEW-2026-05-08.md`.

Don't commit it. Just save the file. The user will read it, decide what to revise in the architecture, and tell you what to do next.
