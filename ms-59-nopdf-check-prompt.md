# Claude Code — M&S 59 With-Parent `no_pdf` Check (READ-ONLY)

## Purpose

The cluster verdict resolved the 5 missing-parent M&S invoices (sync-window gap, benign, 18 lines already terminal-stated). It left a larger, sharper question: **59 M&S Vero invoices have a parent in `fortnox_supplier_invoices` (so they synced fine) yet the PDF extractor marked them `no_pdf`.** Two possibilities, very different in consequence:

- **(A) Genuinely no PDF** — manually-keyed bookings, credit notes, EDI-only invoices with no attached document. Rule (b) correctly terminal-states them. Fine.
- **(B) PDF-lookup coverage bug** — the PDF *exists in Fortnox* but our extractor isn't finding it at the path/field it checks. If so, this is a **systematic extraction hole on your single biggest supplier**, quietly routing real itemized M&S invoices to `not_inventory` across all history — not a closed 3-week window like the 5-cluster.

Settle (A) vs (B) for the 59. This does **not** gate the manual pass (running in parallel) — but if it's (B), it's a code-level coverage bug worth fixing, and the bigger the recoverable population, the more it matters.

## HARD RULES

- **READ-ONLY.** `SELECT`, metadata, Fortnox **GET** probes only. No writes, no re-sync, no re-extraction, no changes to Rule (b) or the extractor.
- Fortnox calls **GET-only**, rate-limit-aware, off-peak, via the existing Fortnox client/auth. If tokens are stale, reuse the fresh-token path from the scope-probe work (or flag that the owner must trigger it).
- Never print secrets. Print every query/endpoint.
- Scope: **Vero**, Martin & Servera, the 59 with-parent `no_pdf` records.
- Deliverable: `docs/investigation/ms-59-nopdf-verdict.md` + a three-line chat summary. **No fix** — if (B), scope the lookup fix separately.

## Step 1 — Characterize the 59 (READ-ONLY DB)

1. Confirm the count and pull the 59's invoice identifiers (number/series/date), line counts, and current `match_status`. How many `supplier_invoice_lines` do they represent, and how many are already terminal-stated by Rule (a)/(b) vs still `needs_review`?
2. **Look for a pattern that hints at (A) vs (B):**
   - Date distribution — are they spread across all of M&S history (smells like a systematic lookup bug, (B)) or clustered (could be a period-specific (A) cause)?
   - Do any look like **credit notes / corrections** (negative totals, credit document type)? Those plausibly have no PDF legitimately → (A).
   - Compare against the 37 successfully-`extracted` M&S invoices: is there any field on the parent record (document type, source, a file-reference column) that systematically differs between the extracted-37 and the no_pdf-59? A field that's populated on the 37 and null on the 59 is a strong (B) lead — it's the thing the extractor keys its PDF lookup on.

## Step 2 — Probe Fortnox for a sample (READ-ONLY, GET)

Pick **8–10 samples** spanning the date range (and including any suspected credit notes). For each:
1. **Does Fortnox hold a PDF / attached file for this invoice?** Use the *same* file-attachment lookup the extractor uses (`GET` the invoice, inspect its file/attachment reference). 
2. Critically: if a PDF **does** exist in Fortnox but our extractor recorded `no_pdf` → that's **confirmed (B)**, a lookup miss. If Fortnox confirms no attachment → **(A)** for that invoice.
3. Tabulate: per sample — has-PDF-in-Fortnox? is-it-a-credit-note? what-field-differs-from-the-extracted-37? → classify (A) or (B).

## Step 3 — Verdict +, if (B), the lead on the cause

- Classify the 59: predominantly (A), predominantly (B), or mixed, with sample evidence.
- **If (B):** identify the likely lookup-layer cause — e.g. the extractor checks one attachment field/path but M&S PDFs for these arrive via a different field, a different `arkivplats` inbox reference, or a file type the lookup filters out. (Note: the working M&S invoices route via an `arkivplats.se` inbox per the document headers — check whether the no_pdf-59 differ in how/whether that reference is captured.) Estimate the recoverable line count across all 59. **Scope, don't build,** the fix.
- **If (A):** confirm Rule (b) is sound for the 59 and the `no_pdf` is honest (credit notes / manual bookings). Close the concern.
- Either way, state the recoverable-line magnitude so we can prioritize a lookup fix against other work — and confirm this never needed to gate the manual pass.

## Deliverable

`docs/investigation/ms-59-nopdf-verdict.md` + chat summary, three lines:
1. Of the 8–10 sampled, how many have a PDF in Fortnox our extractor missed (= (B), lookup bug) vs genuinely no PDF (= (A));
2. Is there a systematic field/path difference between the extracted-37 and the no_pdf-59 that points at the lookup cause;
3. Recoverable line magnitude across the 59, and whether this warrants a near-term lookup fix or is a genuine (A) close-the-book.

Every query/endpoint listed. No writes, no fix.
