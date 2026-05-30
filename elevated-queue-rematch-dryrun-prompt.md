# Claude Code — Dry-Run Rematch: How Much of the Elevated Queue Is Real Work?

## Purpose

P2.0's back-fill correctly elevated ~1,572 previously-hidden lines into `needs_review` (plus the pre-existing queue). The open question before anyone triages: **how many of these are genuinely distinct new products, vs repeat purchases that auto-resolve against aliases that already exist?** The queue is line-count; the work is *distinct-new-product* count. Measure the gap.

This is **READ-ONLY**. Run the matcher in dry-run / simulation mode — resolve each line as far as the ladder goes, but **write nothing**: no alias inserts, no `match_status` changes, no product creation. Report what *would* happen.

## HARD RULES

- **No writes.** Dry-run only — simulate the matcher ladder, do not persist matches, do not create products, do not change `match_status`. If the matcher code can't run without writing, wrap it so the write step is a no-op that records the intended outcome instead.
- SELECT-only against the DB for the surrounding analysis; print queries.
- Scope to the two live businesses: **Chicce** and **Vero Italiano**. Skip Rosali (no Fortnox).
- Deliverable: `docs/investigation/elevated-queue-rematch-dryrun.md` + a short chat summary. **No build, no triage.**

## Define the population precisely

The lines we care about are the ones P2.0 elevated — i.e. currently `match_status='needs_review'` that received a `voucher_backfill` account. Distinguish three groups so the numbers aren't blurred:

- **(P0) Pre-existing review queue** — lines that were already `needs_review` before P2.0. (Context, not the new work.)
- **(P1) Elevated by back-fill** — lines moved out of `not_inventory` into `needs_review` because the BAS account gave them a food/alcohol signal. (The ~1,572 — the surprise.)
- Report P0 and P1 counts separately, per business.

## The core measurement — run the ladder in dry-run over P1 (and P0)

For each line, simulate the existing matcher ladder (`lib/inventory/matcher.ts` Steps 1–4, `is_active=true` aliases only) and bucket the outcome **without writing it**:

1. **Would auto-resolve to an existing alias** (exact code, exact normalised description, or confident trigram) — *zero owner effort*. Count these; they're the lines that simply need a rematch pass to disappear from the queue.
2. **Collapses onto a distinct existing product but below auto-confidence** — a one-tap confirm, not new setup.
3. **Genuinely new distinct product** — no plausible existing match; this is the real residual work.

Then collapse to the number that actually matters:

- **Distinct new products** behind group 3, per business — i.e. if you deduplicate the "genuinely new" lines by normalised description / article code, how many *unique items* are there? This is the real size of the task. 1,572 lines might be 250 distinct products bought repeatedly.
- Show the **line-to-distinct-product ratio** so we can see how much is repeat-purchase volume vs genuine breadth.

## Also report (cheap, decision-shaping)

- **Top distinct new products by line-count and by SEK value** — if the residual is dominated by a handful of high-frequency items, clearing those few clears most of the queue. List the top ~30.
- **Auto-resolve rate** — of all P1 lines, what % fall in bucket 1 (vanish on a rematch with no owner input)? This is the single most reassuring/alarming number.
- **Cross-business overlap** — how many of the distinct-new products at Vero also appear at Chicce (same normalised description)? Overlap is a preview of how much a shared catalogue (Phase 3) would pre-seed.
- **Confirm no billing/financial impact** — restate that these lines' presence in `needs_review` does not affect revenue/cost/P&L totals (categorisation queue only), so this is throughput, not urgency.

## Deliverable — the verdict

`docs/investigation/elevated-queue-rematch-dryrun.md`:

- P0 vs P1 line counts, per business.
- The three-bucket dry-run split, per business.
- **The headline: distinct-new-product count** (group 3, deduplicated) per business, and the auto-resolve rate.
- Top ~30 distinct new products by frequency and by value.
- Cross-business overlap figure.
- Every query / how the dry-run was simulated. **No writes, no triage.**

Chat summary, three lines: (1) of the ~1,572 elevated lines, what % auto-resolve on a rematch with zero owner input; (2) how many *distinct new products* actually remain to confirm, per business; (3) whether a handful of high-frequency items dominate that residual (i.e. is this an afternoon or a non-event).
