# Prediction System Build — Handover README

> Package date: 2026-05-08
> Total project: ~23-24 calendar weeks
> Strategic context: this is CommandCenter's core differentiator — predictions that get measurably more accurate the longer customers use the product

---

## What's in this package

Three documents form the build foundation:

1. **`PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md`** — the authoritative architecture spec. ~8,600 words across 11 sections. Validated through two review passes. Read this first; it's the source of truth for everything downstream.

2. **`PIECE-0-IMPLEMENTATION-PROMPT.md`** — the first implementation prompt. Foundation cleanup work that has to happen before any of the prediction system can be built on top. ~3,000 words covering 6 work streams. Spans 3 calendar weeks per the architecture's sequencing.

3. **This README** — orientation, build flow, working pattern.

Plus, for context, the two architecture reviews are useful reference:
- `ARCHITECTURE-REVIEW-2026-05-08.md` — v1 review that surfaced the original errors
- `ARCHITECTURE-REVIEW-V2-2026-05-08.md` — v2 review that signed off WITH-CONDITIONS

These show the discipline pattern in action and explain why specific decisions in v3 are what they are.

---

## How to use this package

### Step 1 — Read the architecture doc

Read `PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md` end to end before doing anything else. Pay particular attention to:

- **Section 9 (Sequencing)** — the 23-24 week plan
- **Section 11 (Launch strategy)** — build on the side, validate, controlled cutover
- **Appendix A (Code paths)** — every file that gets touched

The architecture is the spec. The implementation prompts are scoped slices of it. If a prompt and the architecture disagree, the architecture wins; the prompt should be updated.

### Step 2 — Run Piece 0

Hand `PIECE-0-IMPLEMENTATION-PROMPT.md` to Claude Code:

> Read `prompts/PIECE-0-IMPLEMENTATION-PROMPT.md` and execute it as specified. The architecture document is at `prompts/PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md`. Investigation first; halt and report rather than guessing if anything in the codebase contradicts the spec.

Expected output:
- Working code merged
- All acceptance gates green
- A `PIECE-0-COMPLETION-REPORT-2026-05-XX.md` at the repo root

The completion report is critical — it's the input to writing the next prompt.

### Step 3 — Review Piece 0 completion before writing Piece 1

After Piece 0 ships, before writing Piece 1's implementation prompt:

1. Read the completion report
2. Note any "I had to do X differently because of Y" items — these are architecture corrections
3. Note any "I found Z which contradicts the architecture" items — these need to be folded into the spec
4. Update the architecture doc if needed (call it v3.1)
5. Then write Piece 1's implementation prompt against the (potentially updated) architecture

Don't write all 9 implementation prompts at once. Write them one at a time, informed by what was learned in the previous piece. The architecture is stable; the implementation details will refine as they make contact with reality.

### Step 4 — Repeat for Pieces 1-5

The architecture doc lists the implementation prompts to write (Appendix A). In order:

1. **Piece 0** — Foundation fixes (this package)
2. **Piece 1** — Audit ledger
3. **Piece 2** — Consolidated forecaster + Vero backfill
4. **Piece 3 batch 1** — YoY signals, klämdag, salary cycle
5. **Phase B preparation** — Flag-gated cutover PRs (no flag flips yet)
6. **Piece 3 batch 2** — School holidays, weather change, day-of-month
7. **Piece 4.5** — Owner-flagged events
8. **Piece 4** — LLM adjustment layer
9. **Piece 5** — Pattern extraction
10. **Validation + cutover runbook** — checklist for the 4-week validation period and flag-flip sequencing

For each: the same disciplined pattern. Investigation prompt first if the implementation domain is unfamiliar; implementation prompt next; completion report; review; then the next piece.

### Step 5 — Validation and cutover

After Piece 5 ships (Week 18 of the build), the system is code-complete but not customer-facing. Section 9 specifies a 4-week validation period (Weeks 19-22) and a controlled cutover (Weeks 23-24).

The validation period is non-negotiable. Don't flip any flags until:
- 30+ days of fresh resolved audit data exists
- `consolidated_daily` MAPE is at parity (within 1pp) of legacy
- LLM-adjusted MAPE is measurably better than baseline (or kill switch fires)

The cutover is staged: 1 flag flip every 1-3 days, with rollback ready.

---

## The working pattern

This package was built using a specific discipline that should continue throughout the project:

### Investigation before implementation

Every architecture section was validated against the actual codebase. Two review passes caught real errors (column-name bugs, missing RLS, miscounted Phase B consumers, fabricated infrastructure references). This is not optional — assumption-driven coding compounds errors across pieces.

### Reviews between artifacts

- v1 architecture → review → v2 architecture
- v2 architecture → review → v3 architecture
- Piece 0 implementation → completion report → Piece 1 prompt

Each review is read-only critique. Each surface decision goes through explicit consideration. Don't sprint past this — the moments of "wait, that's not right" are when the project gets saved from compounding errors.

### Halt and report on conflicts

If implementation hits something that contradicts the spec — a missing column, a different file path, an unexpected dependency — the right move is to halt, document, and update the spec. NOT to invent a workaround on the fly.

### Customer-visible changes are gated

Every new feature is behind a per-business feature flag, default OFF. Vero sees zero changes during the build. Three specific bug fixes in Piece 0 are exempted (documented in changelog). Everything else stays gated until validation passes.

---

## What can go wrong and what to do

### "Claude Code says the column exists / doesn't exist differently from the spec"

Halt. Verify against the actual schema (Supabase dashboard or `\d table_name` in psql). Update the architecture doc to match reality. Continue with corrected spec.

### "The migration doesn't apply cleanly"

Halt. Don't force it. Investigate why. Update the migration. Re-run. If the issue is structural (e.g. a foreign key references a table that doesn't exist), this is an architecture-level issue — update v3 and re-review.

### "Vero's data doesn't behave as the architecture predicts"

Likely. Investigation reports surfaced Vero specifics; implementation will surface more. Document what's different. Decide whether the architecture needs to flex (most signals already accommodate "data unavailable" gracefully) or whether the implementation needs a per-customer config.

### "We're in Week 8 and the schedule is slipping"

Don't compress the validation period to catch up. Don't skip pieces. Don't ship customer-visible changes early. The architecture is designed to be forgiving on calendar time and unforgiving on quality. Slip the calendar; preserve the discipline.

### "AB/Stripe pulls focus"

Expected. The two customer-facing sprints (Weeks 5-6 and 11-12) are explicit breathing room. Use them. The audit ledger continues collecting data even if no one is touching the prediction code.

### "Customer #2 lands mid-build"

The flags default OFF for new customers. Customer #2 sees the legacy product. Onboard them on the existing experience; flip flags after Vero's cutover validates the new system works at N=2.

### "MAPE looks worse on the new system after Phase A"

This is what the audit ledger is for. Read the `error_attribution` distribution. Identify the failing signal. Either fix it, cut it, or restart the validation clock. Do not cut over to a worse system just to meet the schedule.

---

## What this package does not include

- Implementation prompts for Pieces 1-5 (write these one at a time, after each prior piece ships)
- A separate testing/validation runbook for cutover (write this at end of Piece 5)
- Customer-facing changelog copy (draft when each "go live" approaches)
- AB/Stripe integration work (parallel track, separate planning)
- Marketing/sales material for the "predictions get more accurate" claim (write this once you have receipts from Vero post-cutover)

---

## Quick reference: file paths

In the codebase after Piece 0:

```
prompts/
  PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md   ← the spec
  PIECE-0-IMPLEMENTATION-PROMPT.md                    ← what's running
  ARCHITECTURE-REVIEW-2026-05-08.md                  ← reference: v1 review
  ARCHITECTURE-REVIEW-V2-2026-05-08.md               ← reference: v2 review
  HANDOVER-README.md                                  ← this file

migrations/
  MXXX_anomaly_confirmation_workflow.sql              (Piece 0)
  MXXX_business_cluster_columns.sql                   (Piece 0)
  MXXX_business_cluster_membership.sql                (Piece 0)
  MXXX_school_holidays.sql                            (Piece 0, DDL only)

lib/featureFlags/
  prediction-v2.ts                                    (Piece 0)

lib/anomalies/
  confirmation.ts                                     (Piece 0)

docs/operations/
  vero-anomaly-triage-runbook.md                      (Piece 0)
```

---

## One last thing

This is foundation work for a system whose value compounds over years. The right pace is "right, not fast." Every shortcut taken in Pieces 0-1 makes Pieces 2-5 harder. Every assumption about the codebase compounds into bugs at week 18.

The discipline pattern that produced this package — investigation, review, halt-and-report — is what the build needs to maintain. The architecture is good; the package is ready; the launch model is sound. Now build it carefully.

Good luck.
