# Claude Code — Multi-Page Invoice Extraction Loss (READ-ONLY investigation)

## Purpose

A real invoice surfaced a third, distinct cause of lost line detail — separate from the sync-gap (5-cluster) and no-PDF (59-cluster) findings. The **Laweka Gross & Matevent** invoices (and likely others) put a single summary line on **page 1** ("Levererat från Marini/Rima — 104,320 SEK") and the entire itemization — 45 products with EUR+SEK prices — on **page 2**. The extractor appears to read only page 1, so the whole invoice collapses to one uninformative summary line and all the real catalogue-seed detail on later pages is silently dropped.

Unlike the no-PDF cases, **this data is present in the document and recoverable** — the extractor just isn't reading past page 1. For passthrough suppliers like Laweka (12% food, all detail on page 2), first-page-only extraction captures essentially nothing useful.

**Diagnose the mechanism and quantify the scope. Read-only — fix nothing yet.**

## HARD RULES

- **READ-ONLY.** `SELECT`, file/metadata inspection, code reading only. No re-extraction, no writes, no extractor changes, no migrations.
- Print every query and every file/line reference checked.
- Reference invoice: **Laweka Gross & Matevent**, Vero/Pitchers, e.g. faktura **1385** (2025-09-30, 2-page, page 2 = 45 itemized products). Also faktura **1422** (the 2026-04 one seen earlier, same 2-page shape).
- Deliverable: `docs/investigation/multipage-extraction-loss.md` + a three-line chat summary. **No fix** — if confirmed, the page-handling fix is scoped separately.

## Step 1 — Confirm the symptom on the known invoice (READ-ONLY DB)

For the Laweka invoice(s):
1. Find their rows in `supplier_invoice_lines`. How many lines landed? Is it **just the page-1 summary line** ("Levererat från Marini/Rima…") with the page-2 itemization (Mozzarella, Burrata, Parmigiano, Farina 00, pinsa bases, etc.) **entirely absent**?
2. Confirm the line total: does the single captured line equal the invoice total (the summary), with zero of the 45 page-2 products present? That's the symptom in its clearest form.
3. Check `invoice_pdf_extractions` (M078) for these — extraction status, and crucially **how many pages the stored PDF has vs how many the extraction record reflects**.

## Step 2 — Determine the MECHANISM (READ-ONLY code) — this decides the fix

Read the PDF extractor (`lib/inventory/pdf-extractor.ts` and its page/image handling). The two candidate mechanisms need different fixes, so identify which:

- **(M1) Page-iteration loss:** the extractor only sends **page 1** to the vision model (renders/passes the first page only, or stops after page 1). The model never sees page 2 → can't extract it. *Fix would be: iterate all pages.*
- **(M2) Prompt/aggregation loss:** the extractor sends **all pages** but the model only returns the first page's content (prompt doesn't ask it to continue across pages, or the response handling stops at the first page's items, or a single-response token limit truncates). The model saw page 2 but it wasn't captured. *Fix would be: prompt/aggregation, not iteration.*

**The Laweka invoice is the decisive test:** page 1 has NO useful line items (just the summary). So —
- If the extraction returned the summary line and nothing else → did the model even receive page 2? Check whether the extractor rendered/sent page 2 at all (M1) or sent it and got nothing back (M2).
- Look specifically for: page-count handling, a loop over pages vs a hardcoded first-page render, how multi-page PDFs are converted to images, and whether the Haiku→Sonnet cascade prompt mentions multiple pages.

Report which mechanism (or both), with the file:line evidence.

## Step 3 — Quantify the scope (READ-ONLY)

How widespread is multi-page loss beyond Laweka?
1. **Stored PDFs with >1 page** — across Vero + Chicce, how many invoices have multi-page PDFs? Of those, how many have `supplier_invoice_lines` counts that look suspiciously low (e.g. 1–2 lines for a multi-page invoice, or a single line equal to the invoice total)?
2. **By supplier** — which suppliers systematically send multi-page invoices with itemization beyond page 1? (Laweka is one; the Martin & Servera multi-page invoices are another shape — confirm whether M&S multi-page extracted fully or also lost pages.) Flag the passthrough/summary-on-page-1 suppliers especially.
3. **Recoverable line estimate** — roughly how many line items are sitting unread on page 2+ of invoices whose PDFs we already hold? This is the recovery magnitude (and, for passthrough food suppliers, real catalogue-seed and cost data we're currently missing entirely).
4. Cross-check against the earlier "empty/summary lines" populations — how much of what we previously attributed to other causes is actually multi-page loss?

## Deliverable — the verdict

`docs/investigation/multipage-extraction-loss.md`:
- Laweka invoice confirmed: lines captured vs the 45 on page 2; pages in PDF vs pages extracted.
- **Mechanism: M1 (iteration) / M2 (prompt-aggregation) / both**, with code evidence — this is the key output, it determines the fix.
- Scope: count of multi-page invoices likely affected, by supplier, with a recoverable-line estimate.
- Whether this overlaps/explains any of the previously-diagnosed empty-line populations.
- Every query/file checked. **No fix performed.**

Three-line chat summary: (1) confirmed — does the Laweka invoice capture only page 1's summary with all 45 page-2 items missing; (2) mechanism — is the extractor not sending later pages (M1) or sending but not capturing them (M2); (3) scope — how many multi-page invoices and roughly how many unread line items are recoverable across the system.
