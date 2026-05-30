# Claude Code — VAT Misrouting Diagnostic (READ-ONLY, urgent)

## Purpose

Confirm or rule out **one specific, possibly-live data bug**: since Sweden cut food VAT to 6% on **2026-04-01**, are food lines at 6% being misclassified into the **takeaway** (or non-food) bucket because the code hard-codes "6% = takeaway"? If this is firing, affected businesses' food-cost and dine-in/takeaway splits have been wrong for ~2 months.

This is a **diagnostic only**. Produce a verdict with numbers. Change nothing.

## HARD RULES

- **Read-only.** No code changes, no fixes, no migrations, no deploys, no writes.
- **SELECT-only queries are explicitly permitted and expected** for this task (it's a data question). Run `SELECT` / `COUNT` / `SUM` only — never `INSERT/UPDATE/DELETE/ALTER/DROP`. **Print every query you run** in the report.
- If a query would be expensive, add a `LIMIT` or aggregate; don't dump rows.
- Deliverable: `docs/investigation/vat-misrouting-verdict.md` + a short chat summary. No remediation — if it's confirmed, we'll scope the fix separately.

## The verified Swedish rule to apply

- **Until 2026-03-31:** foodstuffs (groceries/ingredients) = **12%**.
- **2026-04-01 → 2027-12-31:** foodstuffs sold as **goods** = **6%** (temporary cut); **takeaway** food = **6%**; **dine-in restaurant service** = **12%** (unchanged); **alcohol** = **25%**.
- So after 1 April, a **6% line is ambiguous** between "takeaway" and "ordinary food goods/ingredient." That ambiguity is the suspected bug.

## Part A — Trace every VAT-rate → category decision point (code)

From the current-state report, start with these and follow the call graph; list **every** site where a VAT *rate* influences a *category/bucket* decision, and state exactly what **6%** maps to at each:

- `lib/fortnox/classify.ts` (~121-124) — `classifyByVat`; the "6% means takeaway" regex (~:123).
- `lib/inventory/pdf-extractor.ts` (~310-336) — `for (const vatRate of [25, 12, 6])`.
- `lib/inventory/matcher.ts` Gate 0 — `categoryForBasAccount` / `categoryForSupplier`; the `takeaway_material` category path.
- `lib/inventory/categories.ts` — the hardcoded BAS/category classifier.
- `lib/pos/personalkollen.ts` (~307-309) and any POS revenue split that keys off 12% vs 6%.
- `lib/revisor/momsrapport.ts` (~375-377) — `Box 11 / 0.12` (correctness of the VAT report itself if food is now 6%).
- Any LLM system-prompt text that tells the model "6% = takeaway".

For each: **does a 6% rate force a takeaway/non-food classification, or is category decided primarily by something else (BAS account, supplier, description) with VAT as a minor signal?** This determines whether the bug can even fire.

## Part B — Check the data for a regime break at 2026-04-01

Run read-only aggregates (print each query). Focus on the live businesses (Chicce, Vero/Rosali, Mojo). Suggested checks:

1. **Supplier-invoice lines by VAT × category, before vs after 1 April.** For `supplier_invoice_lines` (join to invoice/voucher date), group by `vat_rate` bucket and resulting category/`match_status`, split on `date < '2026-04-01'` vs `>=`. Look for food volume at 6% suddenly landing in `takeaway_material` / non-food after the cutoff.
2. **Category mix shift.** Monthly sum of line value per category for Jan–May 2026. Is there a visible step at April where a "food" category drops and "takeaway"/"other" rises by a similar amount — with no real operational reason?
3. **Revenue side (if POS data present).** `pos_sales` / tracker revenue split into dine-in vs takeaway by month — any artificial step at April from VAT-rate-based splitting?
4. **VAT report sanity.** Does `momsrapport` still divide 6%-rated food by 0.12 anywhere (which would now be wrong)?

## Deliverable — the verdict

Write `docs/investigation/vat-misrouting-verdict.md`:

- **Verdict:** CONFIRMED / NOT FIRING / PARTIAL — one line up top.
- **Decision points** where 6%→takeaway/non-food can fire (file:line), and which are guarded by BAS/supplier/description so they *don't*.
- **Blast radius:** per business, how many lines and how much SEK value at 6% since 2026-04-01 landed in a takeaway/non-food bucket that look like ordinary food.
- **Earliest affected date** and whether it's still happening on today's ingest.
- Every SQL query you ran.
- **No fix.** Stop at the verdict.

In chat, give me the one-line verdict and the blast-radius number.
