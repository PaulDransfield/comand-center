# Claude Code — P2.0 Follow-up: Gate-0 Signal Precedence + Deposit/Logistics Pattern

## Purpose

The elevated-queue dry-run showed ~half of Vero's residual is noise that shouldn't be in `needs_review` at all: deposits/logistics (`PANT ALUMINIUMBURK`, `EUR-PALL`, `PBA RETURLÅDA`, `Plockavgift`, delivery fees) and professional services (Alden, Citriclabs, etc.) booked to 4xxx food accounts. Both come from one root cause — **BAS account is treated as authoritative over the supplier and description signals.** Fix that, so the queue we measure Phase D against is clean.

This must land **before** the 7-day Phase D agreement-rate watch — otherwise ~800 lines of known non-inventory noise distort the Vero lift measurement.

Code change on live data. Investigation-first, dry-run both directions before any write, idempotent, feature branch + preview, **no prod deploy without review.**

## The governing principle (encode it deliberately, don't patch case-by-case)

Account, supplier, and description are **three independent signals.** Each customer's accountant codes BAS differently (Vero books deposits and services to food accounts; the next customer won't). The safe, durable rule:

> **If *any* signal says `not_inventory`, the line is `not_inventory`.** A coarse food-account code must not override a clear "this isn't inventory" from the supplier or the description.

## Fix 1 — Gate-0 precedence (the root cause)

Current `matcher.ts` Gate 0 is effectively `categoryForBasAccount() ?? categoryForSupplier()` — BAS wins, so a known non-inventory supplier (Alden Ventures, Citriclabs, Cake on Cake AB) booked to 4010 never gets vetoed.

- **Change to: run all signals, and prefer `not_inventory` when *any* of them says so.** Don't simply flip the order (that would just move the blind spot to the supplier side). Compute the BAS category, the supplier classification, and the description rule independently; if any returns `not_inventory`, the line is `not_inventory`. Otherwise fall through to the existing positive-category logic.
- Keep the positive path intact: when none says `not_inventory`, BAS food/alcohol context still informs the category as it does today (that's the P2.0 win — don't regress it).
- Preserve provenance: record *which* signal drove a `not_inventory` decision (account / supplier / description) so the dry-run and future audits can see why.

## Fix 2 — Widen the deposit/logistics description rule

The rebate guard is too narrow (only `Avtalsrabatt` + `^pant`). Extend it to the structurally-never-inventory classes the dry-run surfaced, as an independent description signal feeding Fix 1's "any says not_inventory" rule.

Candidate additions (confirm against real descriptions in the dry-run before committing each):
- Deposits/returns: `PANT ALUMINIUMBURK`, `PANT ...BURK`, returns crates (`PBA RETURLÅDA`, `SRS back`, `Retur...`)
- Pallets/logistics: `EUR-PALL`, pallet/`-PALL` charges
- Service/handling fees: `Plockavgift`, `Leveransavgift`, `Distribution`, `Frakt`, freight/handling charges

**Hard discipline — same as the `^pant` lesson:** each new arm must be validated **both directions** in the dry-run before it ships:
- **Direction A (no false positives):** does the arm catch any *real product* whose description merely contains the token? (The `Varav pant per enhet:` annotation on Coca-Cola lines is the cautionary example — a real product, not a deposit.) Anchor or compound-match tightly; mid-string tokens on real products must NOT be caught.
- **Direction B (no legitimate items dropped beyond intent):** confirm the arm only catches the deposit/logistics/fee class and nothing adjacent.

Where a charge is genuinely ambiguous from description alone, prefer leaving it for Fix 1's supplier/account signals rather than over-broadening the regex.

> Note on deposits vs cost: deposits (`pant`) are refundable and logistics fees are real costs — both are correctly `not_inventory` for the *product catalogue*, but flag as an open decision whether logistics/freight should later be treated as a cost-allocation rather than simply excluded. For now: `not_inventory`, don't guess a cost treatment.

## Step 0 — Dry-run (READ-ONLY, both fixes together)

Before any write, simulate both fixes over the current `needs_review` population (Chicce + Vero) and report:
- Lines that would move `needs_review → not_inventory`, **split by which signal fired** (supplier-veto via Fix 1, description-rule via Fix 2, account).
- For Fix 2 specifically: the full **both-directions** check per new arm — products falsely caught (must be zero) and the legitimate catches.
- Expected net queue reduction at Vero (target ~800) and Chicce.
- Any line where Fix 1 and the existing positive path now disagree, so we can eyeball edge cases.
- **Confirm the P2.0 positive matches don't regress** — the +1,126 permanent matches and food/alcohol routing must be unchanged.

**Stop for review at the dry-run.** Apply only after the both-directions list is confirmed clean.

## Step 1 — Apply (after dry-run review)

- Ship the Gate-0 precedence change + widened pattern (constants/rules, not magic strings inline).
- Re-run the rematch so the affected lines settle to `not_inventory`; idempotent (only touches lines not already `not_inventory`; re-run is a no-op).
- Where a line moving to `not_inventory` had a wrong alias link, mirror the established correction path (clear alias + `inventory_review_outcomes` row + `product_aliases_record_correction`) in one transaction, as in P2.0.
- Feature branch; same-commit DB+TS for any new enum/CHECK; model strings from `lib/ai/models.ts`.

## Step 2 — Verify + the empty-descriptions question

- Confirm Vero's queue dropped ~800 and the real food/alcohol residual is now the bulk of what remains (~470 expected).
- Confirm Chicce unaffected beyond its small expected change; cost path byte-identical.
- **Empty descriptions (~500 at Vero):** characterise (don't fix yet) — are these PDF-extraction failures (retry extraction) or genuinely blank source rows (accept as `not_inventory`)? Report the split so we decide next. This may partly overlap with lines the two fixes already catch.

## Deliverable

`docs/investigation/gate0-precedence-deposit-fix.md` + chat summary: net queue reduction per business split by signal, the both-directions pattern proof, confirmation P2.0 positive matches didn't regress, and the empty-description split. Then we start the Phase D watch on a clean queue.
