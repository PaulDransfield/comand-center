# Claude Code — Apply Vero Queue Staging (go on all three, with refinements)

## Decision: GO on all three. Specifics below.

The staging report is approved. The Snabbgross finding (967 itemized lines a blanket rule would have wrongly swept) confirmed the empty-only semantic is essential — good catch. Proceed as follows.

### 1. Scope — broaden to ALL empties (drop the supplier filter)
Key the rule on the *property*, not the supplier list: **empty/blank description + positive BAS food/alcohol account = not_inventory.** That's what actually defines the bucket. Clear all ~685 (top-7 + the 124 long-tail + the 2 deposit stragglers) in one pass. Per-supplier rules for ~5-line long-tail suppliers aren't worth the maintenance.

### 2. Mechanism — BOTH, sequenced
- **(a) one-time SQL now** for the current Vero queue, so the manual pass lands clean.
- **(b) persistent matcher rule** on the same branch — but it does NOT merge until dry-run across BOTH businesses (see refinement below). (a) is what unblocks Paul today; (b) is the durable follow-up.

### 3. Timing — ship (a) NOW. The Phase D watch is dropped.
**Important context change:** we are no longer running the passive 7-day queue-drain watch — Paul is doing a manual categorization pass instead, and that pass *is* the experiment now. So **ignore the earlier "record what moved so the 2026-06-07 read can subtract it" caution** — there's no passive measurement left to protect. Staging the queue serves the manual pass directly. Ship (a) now because it makes the manual day land on real products, not noise.

## Refinements to fold in (these are not optional)

### Refinement 1 — (b) must key on SOURCE-BLANK, not merely empty
The empty-descriptions investigation established Vero's empties are `source='fortnox_row'` blank-at-source (Fortnox books account-level totals with no per-line text) — genuinely un-itemizable, so terminal-stating is correct. But a `source='pdf_extraction'` line with an empty description is a **failed extraction** (description lost but recoverable), NOT the same thing — that's a retry candidate, and (b) must never bury it.

So rule (b)'s condition is: **empty description AND `source='fortnox_row'` (source-blank) AND positive BAS food/alcohol account → not_inventory.** A `pdf_extraction` line with empty description must fall through to its existing path (retry/review), not get terminal-stated. Make the source condition explicit in the code and the comment.

### Refinement 2 — (b) dry-runs across BOTH businesses before merge
Rule (b) inverts current matcher behavior (today empty + positive-category → needs_review; (b) makes source-blank empty + positive-BAS → not_inventory) and that change hits **every business at ingest, not just Vero.** Before merging (b):
- Dry-run it against **Chicce** as well as Vero.
- Confirm Chicce has no class of source-blank-empty lines that are actually reviewable/recoverable and would be wrongly buried.
- Report the both-businesses effect. Only merge (b) once Chicce is confirmed safe.

### Refinement 3 — fold the 2 PBA RETURLÅDA stragglers into (a), AND log why they slipped
- Add the deposit/logistics pattern as an OR in the (a) SQL so the 2 stragglers flip too.
- Separately **log a follow-up** (don't fix now): these 2 were ingested after Fix 2's SQL ran and the matcher's Gate 0b description rule didn't catch them at ingest. That suggests Gate 0b may not be firing on live ingest — a quiet leak worth a 5-minute drill-in later. "2 stragglers" is the visible edge of "is the live deposit rule actually working." Note it; don't block on it.

## Execution

**(a) — one-time SQL, dry-run → review → apply:**
1. Write `sql/p20-vero-empty-account-totals-DRY.sql`:
   - `BEGIN` → the UPDATE (all source-blank empties with positive-BAS account, OR-ing the deposit pattern for the 2 stragglers) → **verification SELECTs** → `ROLLBACK`.
   - Verification must show: count flipped (expect ~685), account distribution, and **explicit confirmation ZERO itemized/has-description lines are touched** (the Snabbgross-class proof — the 1,262 itemized lines stay `needs_review`).
   - Idempotent: only touches `needs_review` + `product_alias_id IS NULL` + source-blank-empty (re-run is a no-op).
2. Paul reviews the DRY verification — the number that gates apply is **zero itemized lines touched.**
3. APPLY twin (`COMMIT`) on his confirmation.
4. Re-verify: Bucket A + A-other terminal-stated, Bucket C unchanged at 1,470 lines / 718 distinct products.

**(b) — persistent matcher rule, staged on same branch:**
5. Add Gate 0b-prime in `matcher.ts` (after 0b, before 0c) with the **source-blank** condition from Refinement 1 and a clear comment explaining the Vero account-total case.
6. Dry-run across **both** businesses (Refinement 2); report effect; merge only once Chicce is confirmed safe.
7. Same-commit DB+TS if any enum/CHECK touched; feature branch; no prod deploy without review.

## Deliverable
Apply report + chat summary: lines flipped by (a) with the zero-itemized-touched proof, confirmation Bucket C is the clean 1,470/718, (b)'s both-businesses dry-run result + merge recommendation, and the logged Gate-0b-straggler follow-up. Then Paul's queue is ready for the manual pass.
