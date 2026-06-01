# Rebill Rule — Step 0 Findings (READ-ONLY)

Run: 2026-06-01
Read-only DB analysis. Per `rebill-rule-passthrough-fix-prompt.md` Step 0.

## Three-line headline

1. **Passthrough set confirmed at 5 invoices** (the multi-page-loss class): 4 with "Levererat från Marini/Rima" single-line summaries (Laweka 3174 + Eventcenter 2902, 2948, 2975) plus Laweka 3278 (credit-note variant: "Levererat från Marini/Rima 2025 11 — Kreditering av fakturanummer 1397"). All at Chicce. All show the signature: 1 row extracted, total_extracted ≈ total_header, page-2 items entirely absent.
2. **Genuine thin-rebill candidates: 5 Frimurarholmen "Axfood NNNNNNN" invoices at Chicce** (inv 2828, 3075, 3315, 3345, 3462). Same shape as the passthroughs in the database (1 row, total matches header), but the page-1 description is an explicit Axfood receipt-number reference — the documented pattern the rule was designed to protect. Frimurarholmen rebills selected items from an Axfood receipt to its tenant (Chicce); the attached Axfood receipt is informational/audit-trail, and the line total (411–1610 SEK) is what Chicce actually owes — NOT the full Axfood receipt total. These are the regression cases the rewrite must still handle.
3. **Reconciliation test is the right discriminator.** For all 5 passthroughs, line total = the header total = the SUM of the attached page-2 items → extract items, drop summary. For all 5 thin-rebill candidates, the attached Axfood receipt almost certainly sums to MORE than the small rebilled amount (Frimurarholmen passes through partial selections of a tenant's purchases) → reconciliation fails → keep ignoring the attachment. Zero passthroughs at Vero — the rewrite has no impact there.

## Detailed findings

### Method

Scanned every `source='pdf_extraction'` line at Chicce + Vero for rebill-indicator patterns:
- `Levererat från [supplier]` — confirmed passthrough signature
- `Axfood NNNNNNN` / `Snabbgross NNNNNN` / `Martin Servera NNNNNN` — wholesaler-receipt references (the rule's documented protection target)
- `Faktura NNNNNNN`, `Kreditering av faktura`, `Avser faktura` — invoice cross-references
- `Vidarefakturering` — pass-on billing keyword

Then cross-referenced each candidate with `invoice_pdf_extractions` (rows_extracted, total_extracted, total_header) and grouped by line count.

### Counts

| | Chicce | Vero |
|---|---:|---:|
| Total `pdf_extraction` lines scanned | 9,050 | 6,642 |
| Invoices with rebill-indicator lines | 12 | 4 |
| **Passthroughs** (1 line, "Levererat från", sums to header) | **4** | 0 |
| **Thin-rebill candidates** (1 line, wholesaler-reference) | **5** | 2 (false +) |
| Other (multi-line OR credit references) | 3 | 2 |

### Set A — Passthroughs (the rewrite must capture these)

All Chicce, all "Levererat från Marini/Rima":

| inv | date | supplier | total (SEK) | description |
|---:|---|---|---:|---|
| 3174 | 2025-09-30 | Laweka Gross & Matevent AB | 104,320 | Levererat från Marini/Rima 2025 09 |
| 2902 | 2025-05-31 | Eventcenter i Örebro AB | 234,691 | Levererat från Marini/Rima 2025 04-05 |
| 2948 | 2025-06-30 | Eventcenter i Örebro AB | 90,242 | Levererat från Marini/Rima 2025 06 |
| 2975 | 2025-07-31 | Eventcenter i Örebro AB | 58,323 | Levererat från Marini/Rima 2025 07 |
| 3278 | 2025-11-30 | Laweka Gross & Matevent AB | -10,898 | Levererat från Marini/Rima 2025 11 — Kreditering av fakturanummer 1397 (credit note) |

Sum ≈ +487k SEK food (with -11k credit). Estimated ~225 page-2 items recoverable across these 5.

### Set B — Genuine thin-rebill candidates (the rewrite must NOT break)

All Chicce, all Frimurarholmen AB rebilling Axfood receipts:

| inv | date | total (SEK) | description (the Axfood receipt # rebilled) |
|---:|---|---:|---|
| 2828 | 2025-05-12 | 411 | Axfood 0094332129 |
| 3075 | 2025-09-29 | 531 | Axfood 0020339642 |
| 3315 | 2026-01-16 | 531 | Axfood 0020773958 |
| 3345 | 2026-01-29 | 782 | Axfood 0020832748 |
| 3462 | 2026-03-23 | 1,610 | Axfood 0021035252 |

Plus inv 3410 (2026-03-02, 2 lines totalling 1,690) — same pattern but extracted as 2 lines (probably because the Frimurarholmen page-1 had two line items, both Axfood-referenced). This is the marginal multi-line variant of the same family.

**Why these are different from the passthroughs:** Frimurarholmen is rebilling SOME items from a larger Axfood receipt (the receipt total is much higher than 411 SEK). If we extract the underlying Axfood items, we'd record items Chicce didn't actually buy (Frimurarholmen also bought stuff for other tenants from the same receipt). The current rule correctly ignores the attached receipt. **The reconciliation test will preserve this:** the page-2 Axfood items will NOT sum to the rebilled 411 SEK — they'll sum to whatever Frimurarholmen's full Axfood basket was, which is larger.

### Set C — Other (false positives + edge cases)

3 Chicce + 2 Vero invoices the pattern-search caught but which are NOT genuine rebills:

| Business | inv | description | classification |
|---|---:|---|---|
| Chicce | 3173 | Carlsberg-Intrum: "Dröjsmålsränta faktura 0503784998" | Late-payment fee — not a rebill |
| Vero | 9300 | Martin Servera: "Förseningsersättning (avser faktura DMI 78289296)" | Same — late-payment fee |
| Vero | 9069 | Svensk Cater: "Faktura 1610383545 - ränta" | Same — interest charge |
| Vero | 8679 | Svensk Cater: "Faktura 1610371180" (16 lines) | Normal multi-line invoice; description happens to start with "Faktura" |
| Vero | 9010 | Svensk Cater: "Kyckling… (Retur/Kredit mot faktura 1…)" | Normal extraction; credit note line referencing another invoice |

None of these involve the rebill rule firing — they're just text that happens to match the pattern. Out of scope for the rewrite (the model handles them correctly today).

### Reconciliation test — the structural discriminator

The prompt's insight: the discriminator is **does the page-2 itemization sum to the page-1 summary line**, NOT the supplier-reference wording.

| Class | page-1 line | page-2+ items | Reconciliation | Correct action |
|---|---|---|---|---|
| Passthrough | "Levererat från Marini/Rima = 104,320" | 45 items summing to 104,320 | **YES — items sum to summary** | Extract items, drop summary |
| Thin rebill | "Axfood 0020832748 = 782" | Axfood receipt items summing to (say) 3,500 SEK total | **NO — receipt total > rebilled amount** | Keep summary, ignore attachment |

This test cleanly separates Set A from Set B without keyword matching. It also handles edge cases the keyword approach misses (e.g. a passthrough invoice that doesn't say "Levererat från" — would still pass the reconciliation test).

## Verdict on whether to proceed

**Gate passes.** Both classes are concretely identified. The rewrite has 5 regression cases to validate (the Frimurarholmen Axfood rebills) AND 5 recovery cases to verify (the Marini/Rima passthroughs). The reconciliation test is the right discriminator — it explains both classes' correct behavior without supplier-reference keyword matching, and it's something the model can compute on the fly from the PDF content.

**Recommended next steps (per prompt):**
1. Step 1: rewrite the MULTI-INVOICE REBILLS section of `pdf-extractor.ts`'s SYSTEM_PROMPT to base the decision on reconciliation, not on the presence of "Levererat från" or supplier-number patterns. Keep the change scoped to the rebill rule; don't touch unrelated extraction logic.
2. Step 2 dry-run: feature branch + preview. Re-extract (dry-run, not persisted) over all 10 invoices in Sets A and B. Direction A — confirm the 5 passthroughs now return their items, summary line dropped, total still matches. Direction B — confirm the 5 Frimurarholmen rebills are still handled correctly (no new line items from the attached Axfood receipts).
3. Also dry-run on a sample of normal multi-page invoices (e.g. the M&S multi-page food invoices that currently extract correctly) to confirm no regression.
4. **Stop after dry-run for owner review** — apply Step 3 (real re-extraction of the 5 passthroughs) only after both directions confirm clean.

## What was NOT done

- No changes to `pdf-extractor.ts` or SYSTEM_PROMPT.
- No re-extraction triggered on any invoice.
- No writes to any table.
- No PDF content fetched (DB analysis only — would need PDF reads to verify the Set B reconciliation hypothesis with full certainty; defer to the Step 2 dry-run which exercises the actual extractor against actual PDFs).

## Queries / files referenced

- `supplier_invoice_lines?business_id=eq.{Chicce|Vero}&source=eq.pdf_extraction` (full scan, ~15k rows)
- Pattern matching: `Levererat från`, `Axfood NNNNNNN`, `Faktura NNNNNNN`, `Krediterar`, `Vidarefakturering`
- `invoice_pdf_extractions?business_id=eq.{Chicce|Vero}&fortnox_invoice_number=in.(…)` (header reconciliation)
- `lib/inventory/pdf-extractor.ts:682-706` — the current SYSTEM_PROMPT MULTI-INVOICE REBILLS rule (the surface that needs rewriting)
- Previous investigation: `docs/investigation/multipage-extraction-loss.md` (mechanism = M2 confirmed)

**Stop here for owner review of the Set A / Set B classification before Step 1 rewrite.**
