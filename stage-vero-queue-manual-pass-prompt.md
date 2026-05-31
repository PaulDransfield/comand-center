# Claude Code — Stage Vero's Queue for a Manual Categorization Pass

## Purpose

Paul is going to do a focused **manual categorization pass** on Vero's `needs_review` queue — which is both the fastest way to learn how hard the real residual is (better than passively watching the queue for a week) and a way to **hand-seed the highest-quality rows of the self-built foodservice catalogue** (since no external feed pre-seeds it — see the Phase 3 sourcing analysis). Every confirmed line becomes a learning example downstream.

But the raw ~2,197-line queue is the wrong thing to hand him: ~30% are un-itemizable account-level totals, and some deposit/Gate-0 noise may not have fully cleared. This task **prepares the queue** so his manual day lands on real, itemizable, worth-seeding lines — not noise and not lines no human can resolve.

**This is a staging task, not an auto-clean.** Verify state (read-only), then *stage* the 7 per-supplier rules for Paul's review — do **not** bulk-apply classification rules to a paying customer's data without his explicit confirmation of each.

## HARD RULES

- **Steps 1-2 are READ-ONLY** (verify state). Step 3 *proposes* rules and shows their exact effect; it does **not** apply them until Paul confirms.
- Print every query. No bulk write without explicit per-rule confirmation.
- Scope: **Vero Italiano**. (Note Chicce equivalents if trivial, but Vero is the target.)
- Do **not** touch the cost path. This is categorization staging only.
- Feature branch for any code; same-commit DB+TS for any new enum/CHECK; RLS holds.
- Deliverable: a staging report + the proposed rules, then **stop for Paul's go/no-go** before applying anything.

## Step 1 — Verify the queue is in the state we think (READ-ONLY)

Before staging anything, confirm the cleanup we already shipped actually settled:

1. **Did the deposit/Gate-0 rematch fully run?** Confirm the Fix 1 (Gate-0 precedence) + Fix 2 (deposit/logistics pattern) changes are live and the rematch worker has processed Vero's lines. Are the known deposit/logistics lines (PANT, EUR-PALL, SRS RETURBACK, Plockavgift, etc.) now at `not_inventory`, or are any still sitting in `needs_review`? If the rematch hasn't fully applied, flag it — that's a prerequisite, run it before staging.
2. **Current queue composition.** Vero `needs_review` total, broken down by: empty-description vs has-description; has-account vs null-account; by `account_source`. We want to see the real shape Paul will face.
3. **Reconcile against the known numbers** — does this match the ~2,197 total / ~656 empty-description / drainable-denominator-~1,541 picture from the empty-descriptions investigation, or has it shifted?

## Step 2 — Identify the three buckets (READ-ONLY)

Split Vero's current `needs_review` into what Paul should and shouldn't spend manual time on:

- **Bucket A — un-itemizable (don't hand to Paul):** the empty-description, account-level food-wholesaler totals (the ~656, concentrated in ~7 suppliers: Robertssons Charkuteri, Snabbgross, IL Molino, Martin & Servera, Spendrups, Svensk Cater, et al.). These can't be itemized by a human — they have no line text. They should be terminal-stated by rule, not eyeballed.
- **Bucket B — residual noise (should already be gone):** any deposit/logistics/rebate lines still in the queue after Step 1. If Step 1 shows the rematch cleared them, this bucket is empty — confirm it.
- **Bucket C — the real work (hand this to Paul):** has-description, itemizable food/drink lines that genuinely need a human to confirm the product link. **This is the seed-worthy set.** Report its size, deduplicated to distinct products (the line-to-distinct ratio matters — 800 lines might be 200 products).

Report each bucket's size and SEK. The headline number: **how many distinct itemizable products is Paul's manual pass actually about** — that's the real scope of his day.

## Step 3 — Stage the 7 per-supplier rules (PROPOSE, don't apply)

For Bucket A, propose the per-supplier `supplier_classifications` rules — but with the right semantics, because this is the trap:

- **These 6 are food/drink wholesalers, NOT non-inventory suppliers.** The rule must NOT be "skip this supplier as non-inventory." It must be the narrower **"account-level total lines with no itemizable description from this supplier are not individually trackable"** — so it terminal-states *only* the empty-description account-total lines, and leaves any genuinely itemized line from the same supplier alone.
- For each of the ~7 suppliers, show: supplier name, how many lines the proposed rule would move, their account distribution, and **explicit confirmation the rule only catches empty-description lines** (zero itemized lines swept up). This is the same both-directions discipline as the deposit-pattern fix: prove no real itemizable line gets terminal-stated by mistake.
- Present as a reviewable list. **Stop here.** Paul confirms each rule (or all) before any apply.

## Deliverable

A staging report + chat summary:
1. Queue-state verification: did the deposit/Gate-0 rematch settle; current composition vs the known numbers.
2. The three-bucket split with sizes + SEK; **the headline distinct-itemizable-product count** that is Paul's actual manual scope.
3. The 7 proposed per-supplier rules, each with its line-count, account distribution, and both-directions proof (only empty-description lines caught) — **staged for confirmation, not applied.**

Then stop. On Paul's go, apply the confirmed rules (idempotent, via the established classification path, atomic correction pattern if any alias-clears result), re-confirm Bucket A is terminal-stated and Bucket C is what remains — and Paul starts his manual pass on a clean, seed-worthy queue.
