# Claude Code — Empty-Line Recovery Investigation (READ-ONLY)

## Purpose

Real invoices (uploaded to the design chat) revealed that the "empty account-total lines" we've been treating as un-itemizable are, on the actual PDFs, **fully itemized** — and at least one major supplier (Martin & Servera) prints a complete BAS `ÖVERSIKT KONTERING` (account-coded subtotals) on the document. That means the blank lines in `supplier_invoice_lines` are very likely an **extraction/ingestion loss**, not source-blank — and the detail may be **recoverable**. If so, that changes the manual-pass scope (currently ~718 distinct Vero products) and turns "empty lines" system-wide from a write-off into a recovery opportunity.

**Determine, read-only, whether the empty lines are recoverable and how big the opportunity is.** Recover nothing yet — quantify it.

## HARD RULES

- **READ-ONLY.** `SELECT` / metadata / file-existence checks only. No re-extraction, no writes, no status changes, no migrations. (Re-extraction, if we decide to do it, is a separate task.)
- Print every query. No PDF *content* dumping — report structure/availability, not full extracted text.
- Scope: **Vero** and **Chicce**. The reference documents are Martin & Servera invoices (Vero faktura **78592617** 2026-05-08; Chicce **78691561** 2026-05-26), plus the supplier set below.
- Deliverable: `docs/investigation/empty-line-recovery.md` + a three-line chat summary. **No recovery action** — quantify, then we decide.

## Step 1 — Trace the two known Martin & Servera invoices end-to-end

For Vero invoice `78592617` and Chicce invoice `78691561`:
1. **How did they land?** Find their rows in `supplier_invoice_lines` (and parent invoice record). How many lines? Are the lines itemized (real descriptions: "MONIN HASSELNÖT 70CL", "HÖGREV MARM KL4 4KG+") or are they collapsed to account-total / blank-description rows?
2. **Which ingestion path?** `source='fortnox_row'` (API) or `source='pdf_extraction'` (PDF vision)? This is the crux: if the API row carried only `ÖVERSIKT KONTERING` subtotals (the account-coded blocks: 4011 MAT, 4012 DRYCK, 4014 VIN, 4080 PANT, 5460 FÖRBRUKNINGSMATERIAL) while the itemized lines live only on the PDF, that explains the blanks.
3. **Is the PDF stored and re-readable?** Check the `fortnox-pdfs` bucket (or wherever invoice PDFs live) — is the source PDF for each present and retrievable? (Existence/path only — don't dump it.)
4. **Was PDF extraction ever run on them?** Check `invoice_pdf_extractions` (M078) — is there an extraction record for these invoices? Succeeded/failed/never-attempted?

The answer to "itemized vs blank, and is the PDF available" for these two is the whole question in miniature.

## Step 2 — Quantify the system-wide recovery opportunity

Generalize from the two to the population:
1. **Empty-line lines that HAVE a stored, re-readable PDF** — per business, how many of the blank/account-total `needs_review`-or-`not_inventory` lines belong to invoices whose PDF is present in the bucket? These are the **recoverable** set.
2. **Split by supplier** — which suppliers' empty lines are recoverable (PDF present, itemized on document) vs genuinely source-blank (no PDF, or PDF also header-only)? Martin & Servera is the prime suspect; confirm and find the others.
3. **Extraction state** — of the recoverable set, how many already have a `pdf_extraction` attempt (and what was the outcome) vs never attempted? Never-attempted-with-PDF-present is the cleanest recovery.
4. **The headline:** of the ~559 Vero empties (and the Chicce equivalents) we were about to write off, **how many are recoverable** — i.e., PDF present, itemized, re-extraction plausible? That number is the size of the catalogue-seed we'd be recovering vs hand-keying.

## Step 3 — Characterize the M&S ÖVERSIKT KONTERING opportunity (don't build)

The Martin & Servera PDF prints supplier-provided BAS-coded subtotals (`DELSUMMA 003 Kolonial...`, `4011 VARUINKÖP MAT`, etc.). Note for later (no action now):
- Could this konteringsöversikt be parsed to give a **supplier-provided category mapping** per line/section — i.e. ground truth even richer than the voucher cache for this supplier?
- Roughly how many M&S invoices per business carry it? (Is it standard on every M&S invoice or occasional?)
This is a Phase-3/extraction enhancement candidate; just size it.

## Deliverable — the verdict

`docs/investigation/empty-line-recovery.md`:
- The two M&S invoices traced: itemized-or-blank in the DB, which ingestion path, PDF present?, extraction attempted?
- **The headline number:** of the empties we were treating as un-itemizable, how many are recoverable (PDF present + itemized on document), per business and per supplier.
- The genuinely-source-blank remainder (no PDF / header-only) — these stay terminal-stated.
- The M&S ÖVERSIKT KONTERING sizing (how many invoices, how rich the mapping).
- Every query / check. **No recovery performed.**

Three-line chat summary: (1) for the two M&S invoices, are they blank-in-DB-but-itemized-on-PDF, and which path lost the detail; (2) system-wide, how many "empty" lines are recoverable from stored PDFs vs genuinely source-blank; (3) is the recovery opportunity big enough to change the manual-pass plan (i.e., re-extract before hand-keying ~718 products), or marginal.
