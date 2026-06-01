# Claude Code — Fix the Rebill Rule Over-Firing on Passthrough Invoices

## Purpose

The multi-page investigation found the cause: the SYSTEM_PROMPT's MULTI-INVOICE REBILLS rule (`pdf-extractor.ts` ~682-706) tells the model to ignore attached receipts when the page-1 line references another supplier. On **passthrough invoices** (Laweka "Levererat från Marini/Rima", Eventcenter) the page-1 line is a *summary* and the real ~45 items live on page 2 — so the rule fires correctly per its wording but **discards the actual invoice content**, capturing only the summary line. Confirmed: 5 cases (2 Laweka + 3 Eventcenter), ~225 hidden items, ~487k SEK, all Chicce. Counter-example Laweka 3518 (no "Levererat från" wrapper) extracts 40 lines fine — isolating the trigger to the page-1 wording.

**The rule is not wrong to exist** — it prevents genuine double-counting of thin rebills. The fix must distinguish a *thin rebill* (ignore the attachment, correct today) from a *passthrough* (the later pages ARE the invoice; extract them, drop the summary) — **without reintroducing the double-counting the rule was built to prevent.**

Prompt-refinement to the extraction core — this affects EVERY invoice, so: investigation-first, find-what-we-must-not-break first, dry-run BOTH directions before any prod change, feature branch + preview, no prod deploy without review. Model strings from `lib/ai/models.ts`.

## The discriminator (the structural insight — build the rule on this, not on keywords)

A **passthrough**: page-1 summary line ≈ the SUM of the later-page itemized lines (the summary *is* their total — e.g. Laweka 104,320.24 = sum of 45 page-2 items). Extracting both double-counts; extracting **only the items** gives full detail at the correct total. → **Extract the items, drop the summary.**

A **thin rebill** the rule rightly ignores: the attached receipt does NOT reconcile to the page-1 line as a summary-of relationship — it's additional/informational, and extracting it WOULD double-count or distort. → **Keep ignoring the attachment.**

So the test is **reconciliation, not supplier-reference wording**: *do the later-page items sum (within tolerance) to the page-1 summary line?* Yes → passthrough, extract items. No → rebill, keep current behavior. Note: today the validator "passes" the broken case precisely because summary == header total — that same reconciliation fact is what proves it's a passthrough. The signal currently making it look correct should flip the decision.

## Step 0 — Find the genuine rebills the rule protects (READ-ONLY) — DO THIS FIRST

Before touching the rule, establish what it's correctly protecting, so the rewrite can be validated against both classes:
1. Find invoices where the rebill rule currently fires (page-1 references another supplier / attached-receipt indicators). Across Vero + Chicce.
2. For each, classify by the reconciliation test: do later-page items sum to the page-1 line?
   - **Reconciles → passthrough** (currently mis-handled — these are the ~5 we want to fix).
   - **Doesn't reconcile → genuine thin rebill** (currently correct — these we must NOT break).
3. Report both lists. If there are genuine thin rebills, capture 2-3 concrete examples — these become the regression cases the fix must still handle correctly. **If we can't point to the rebills the rule protects, we can't prove the fix is safe** — so this step gates the rewrite.

Report a findings block. Confirm the passthrough set is the expected 5 (2 Laweka + 3 Eventcenter) and surface any genuine rebills.

## Step 1 — Rewrite the rule (prompt refinement)

Rewrite the MULTI-INVOICE REBILLS section of the SYSTEM_PROMPT so the model:
- Recognizes when later-page items **sum to** a page-1 summary line → treats it as a **passthrough**: extract the itemized lines, **omit the page-1 summary** (so the total isn't double-counted).
- Keeps ignoring attachments that do **not** reconcile to the page-1 line (genuine thin rebills) — unchanged behavior.
- Bases the decision on the **reconciliation relationship**, not on the presence of a supplier-reference phrase like "Levererat från".

Keep the change scoped to this rule. Don't alter unrelated extraction instructions. If the cascade (Haiku→Sonnet) handles the rule at one stage only, ensure the refinement is where the classification actually happens.

## Step 2 — Dry-run BOTH directions (no prod write)

On a feature branch, re-run extraction (dry-run / preview, not persisted) over:
- **Direction A — the 5 passthrough cases:** confirm each now extracts its page-2 items (Laweka 3174 → its 45; the others → their items), the summary line is dropped, and the extracted items still sum to the invoice total (no total drift, no double-count).
- **Direction B — the genuine rebills from Step 0:** confirm each is STILL handled correctly (attachment still ignored, no new double-counting, totals unchanged).
- Confirm no regression on a sample of **normal single-supplier multi-page invoices** (e.g. the Martin & Servera multi-page ones) — they must extract exactly as before.

Report the both-directions result. **Stop for review.** Apply only if Direction A recovers the items AND Direction B shows zero rebill regression.

## Step 3 — Re-extract the 5 affected invoices (after review)

- On approval, re-run real extraction on the 5 confirmed passthrough invoices through the existing pipeline (not hand-edited), idempotently — recovering the ~225 line items.
- Confirm the recovered lines flow through the normal matcher/categorization path (they're real food/catalogue items, especially the Laweka passthrough food — this feeds the recipe-cost foundation).
- Verify totals: each re-extracted invoice's line sum still equals its header total (the reconciliation that proves correctness).
- Note any of the ~225 that need owner review vs auto-match.

## Hard rules

- Step 0 gates the rewrite — don't change the rule until the genuine-rebill set it protects is known.
- Dry-run both directions before any prod change; the fix must recover passthroughs AND preserve rebill handling.
- Prompt-scope only — no extractor architecture change (the multi-page handling itself works; it's the classification rule that over-fires).
- Re-extraction is idempotent, via the existing pipeline, reviewed before apply.
- Feature branch + preview; no prod deploy without review.

## Deliverable

Step 0 findings (passthrough set vs genuine-rebill set, with examples). Then the rule rewrite + Step 2 both-directions dry-run result — **stop for review**. Then (on go) Step 3 re-extraction recovering the ~225 items, with totals reconciled.

Chat summary: (1) genuine rebills found that the rule must keep protecting (count + examples); (2) both-directions dry-run — do the 5 passthroughs now recover their items AND do the rebills still get ignored; (3) post-re-extraction, how many of the ~225 recovered lines auto-matched vs need owner review.
