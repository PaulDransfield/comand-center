# Multi-Page Invoice Extraction Loss — verdict (READ-ONLY)

Run: 2026-06-01
Read-only. No fix performed; no writes; no extractor changes.

## Three-line headline

1. **Confirmed for Laweka 3174 (= supplier inv 1385, Chicce 2025-09-30):** `invoice_pdf_extractions.rows_extracted=1`, `total_extracted=104,320.24`, `total_header=104,320.57` (delta 0.0000031 %). The single extracted row is "Levererat från Marini/Rima 2025 09 = 104,320.24" — the page-1 summary. The 45 page-2 items (Pinsa bases, Pomodoro, Mozzarella, Parmigiano, Farina 00 …) are entirely absent from `supplier_invoice_lines`. Counter-example: Laweka invoice 3518 (March 2026) was extracted with 40 line items intact — the same supplier extracts correctly when the PDF doesn't open with a "Levererat från X" wrapper.
2. **Mechanism is M2 — prompt-aggregation loss, not iteration loss.** `lib/inventory/pdf-extractor.ts:770-787` passes the entire PDF as ONE base64 document block to Anthropic's API — multi-page handling is native to the API, page 2 IS sent. The model receives the whole PDF (tokens_input=8302 for Laweka 3174 supports a 2-page document). The model then chooses to return one row because the SYSTEM_PROMPT's **"MULTI-INVOICE REBILLS"** section (lines 682-706 of `pdf-extractor.ts`) explicitly instructs it to: *"Extract ONLY from the TOP-LEVEL invoice — the one from the supplier on the Fortnox header. IGNORE attached receipts from other suppliers."* The page-1 line "Levererat från Marini/Rima 2025 09" matches the prompt's stated rebill indicator (`The page-1 line description references the other supplier's invoice number directly`), so the model applies the rule. Validator can't catch the loss because the page-1 summary already equals the invoice header total.
3. **Scope is small but the recoverable detail is real.** **5 confirmed cases at Chicce** (2 Laweka + 3 Eventcenter, all with explicit "Levererat från Marini/Rima YYYY MM" wording), totalling **~487,576 SEK of summary lines** that hide an estimated **~225 page-2 line items** (~45 per invoice based on the Laweka 1385 reference). **0 confirmed cases at Vero** (none of Vero's 32 suspicious 1-row extractions carry the "Levererat från" pattern; all 32 are legitimate 1-row business — consultancy, audit, single-product orders, credit notes). Across both businesses: 71 total 1-row extractions, only 5 are the multi-page loss pattern. The other 66 are honest 1-row invoices. The fix would unlock ~225 line items at Chicce — catalogue-seed for an Italian-deli passthrough supplier whose itemization is currently entirely missing from the system.

## Detailed findings

### Step 1 — Laweka 3174 confirmed

`invoice_pdf_extractions` for `business_id=Chicce`, `fortnox_invoice_number=3174`:

| Field | Value |
|---|---|
| status | extracted |
| attempts | 1 |
| rows_extracted | **1** |
| total_extracted | 104,320.24 SEK |
| total_header | 104,320.57 SEK |
| total_delta_pct | 0.0000031 % |
| tokens_input | 8,302 |
| tokens_output | 238 |
| ai_model | claude-haiku-4-5-20251001 |
| validation_warnings | [] |

`extracted_rows_json[0]`: `{ description: "Levererat från Marini/Rima …", quantity: 1.1, unit: "st", vat_rate: 12, row_number: 1 }`

`fortnox_supplier_invoices` parent: `given_number=3174, invoice_number=1385, supplier_name='Laweka Gross & Matevent AB', total=116,839, invoice_date=2025-09-30, voucher_series=D, voucher_number=144`.

**The 45 page-2 items (mentioned in the prompt as the actual itemization) are absent from `supplier_invoice_lines` entirely.** Validator passed because the page-1 summary equals the invoice total — there's no internal inconsistency to flag.

### Counter-example: Laweka 3518 (same supplier, different month)

| Field | Value |
|---|---|
| rows_extracted | **40** |
| total_extracted | 87,637.37 |
| description sample | "A3 Scatole per pizza 40x20x5 cm", "D3 Nduja piccante", "Mozzarella per pizza Julienne", "Pall Farina 00 Molino Pasini 25 kg", … |

Same supplier (Laweka Gross & Matevent AB), same business (Chicce), but the PDF doesn't open with "Levererat från Marini/Rima" — and the extraction captures the full 40-line itemization. This isolates the trigger to the **page-1 wording**, not the supplier identity.

### Step 2 — Mechanism: M2 (prompt-aggregation loss)

**Not M1.** `pdf-extractor.ts:766-815` shows the entire base64 PDF passed in ONE `document` content block:

```typescript
const userMessage = [
  { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
  { type: 'text',     text: 'Extract the product rows from this invoice. …' },
]
…
body: JSON.stringify({
  model, max_tokens: 4096,
  system: SYSTEM_PROMPT, tools: [RECORD_TOOL],
  tool_choice: { type: 'tool', name: 'record_invoice_rows' },
  messages: [{ role: 'user', content: userMessage }],
}),
```

There is no page-iteration loop, no first-page rendering, no per-page-image conversion. Anthropic's API handles multi-page PDFs natively. The token usage (8,302 input for Laweka 3174) is consistent with two PDF pages being seen by the model.

**M2 mechanism — SYSTEM_PROMPT lines 682-706 (`MULTI-INVOICE REBILLS`):**

> "Some PDFs contain MULTIPLE invoices or receipts stitched together: the supplier's invoice to YOU on page 1, then the supplier's OWN underlying purchase receipt from a wholesaler attached as pages 2+. Common when a small supplier resells / passes through goods from Axfood Snabbgross, Martin Servera, Menigo, Granngården, etc."
>
> "Extract ONLY from the TOP-LEVEL invoice — the one from the supplier on the Fortnox header. **IGNORE attached receipts from other suppliers.** The buyer only owes the rebilled amount, not the underlying full purchase."
>
> "The top-level rebill line is often a single line like: `Axfood 0021035252  1 st  1 610,00 kr`. Extract that one line as-is. **DO NOT dig into the attached Axfood receipt to enumerate 15 product rows** — the buyer didn't receive all 15 of those items in those quantities."
>
> "Indicators that a PDF is a rebill: … The page-1 line description references the other supplier's invoice number directly (e.g. `Axfood 0021035252`) …"

The Laweka 3174 page-1 summary "Levererat från Marini/Rima 2025 09" exactly fits the indicator pattern. The model correctly applies the documented rule and returns one row.

**The mis-classification:** the Laweka case is NOT a rebill in the strict sense the prompt intends — Laweka IS the actual supplier of the goods (or at least the billing party), and Marini/Rima is the distributor/source whose items Laweka resells. The 45 page-2 items ARE what Laweka delivered to Chicce; ignoring them loses the catalogue-seed AND the actual product cost detail.

**Distinguishing a true rebill from a passthrough invoice:** a rebill is a thin pass-through (supplier resold ONE item from another supplier's receipt, buyer owes only the rebilled amount). A passthrough invoice ENUMERATES every item with prices and totals on page 2+, sums them on page 1 as a summary, and the buyer owes the page-1 total which IS the sum of page 2. The prompt's rule treats them the same; the model can't currently tell them apart from the page-1 line alone.

### Step 3 — Scope across Vero + Chicce

Method: pulled every `invoice_pdf_extractions` row with `status='extracted'` and `rows_extracted=1`, filtered for `total_extracted > 5,000 SEK` (small invoices like consultancy fees legitimately have 1 row) AND `|total_extracted − total_header| < 5%` (summary line matches header — the false-pass signature).

| Business | Total extracted records | 1-row >5k matching header | "Levererat från" pattern | Other (legit 1-row) |
|---|---:|---:|---:|---:|
| Chicce | 723 | 39 | **5** | 34 |
| Vero | 537 | 32 | 0 | 32 |

**The 5 confirmed multi-page-loss cases at Chicce:**

| inv | date | supplier | total (SEK) | page-1 wording |
|---|---|---|---:|---|
| 3174 | 2025-09-30 | Laweka Gross & Matevent AB | 104,320 | "Levererat från Marini/Rima 2025 09" |
| 2902 | 2025-05-31 | Eventcenter i Örebro AB | 234,691 | "Levererat från Marini/Rima 2025 04-05" |
| 2948 | 2025-06-30 | Eventcenter i Örebro AB | 90,242 | "Levererat från Marini/Rima 2025 06" |
| 2975 | 2025-07-31 | Eventcenter i Örebro AB | 58,323 | "Levererat från Marini/Rima 2025 07" |
| 3278 | 2025-11-30 | Laweka Gross & Matevent AB | -10,898 | "Levererat från Marini/Rima 2025 11 — Kreditering av fakturanummer 1397" (credit note) |

Sum of summary-line totals: **487,576 SEK** (487,476 if the −10,898 credit is netted as same direction). Per-invoice item count estimate: 45 (Laweka 1385 reference). Estimated recoverable lines: **~225 across 5 invoices**, of which 4 are positive ~450k SEK of food-line detail and 1 is a credit-note correction.

**Vero shows zero "Levererat från" pattern** — Vero's 32 suspicious 1-row extractions are all genuine 1-row invoices (8 Carlsson & Åqvist disk-material delivery confirmations, 7 Mathias Aldén consulting, 6 Nygårdens audit/redovisning, 4 Rosalis inter-business invoices, 3 Spräng o Bax misc, 2 Cake on Cake graphic design, etc.). The Marini/Rima passthrough doesn't appear at Vero — it's a Chicce-Italian-cuisine sourcing artefact.

### Overlap with previously diagnosed empty-line populations

- **`source='fortnox_row'` empties** (`docs/investigation/empty-line-recovery.md`, the 1,371 Vero / 234 Chicce empties) — these are Fortnox supplier-invoice API rows with no item text (amounts-per-account bookkeeping). Distinct cause. **No overlap** with this multi-page-loss class; the 5 affected invoices here all have `source='pdf_extraction'` (the page-1 summary line IS the captured PDF row).
- **M&S no_pdf cluster** (`docs/investigation/ms-59-nopdf-verdict.md`) — paid older M&S invoices where Fortnox has no PDF attached. Distinct cause; M&S multi-page invoices that DO have PDFs extract correctly (the reference invoice 78592617 extracted 7 lines). **No overlap.**
- This is a **third distinct cause**, small in count but disproportionately impactful because each affected invoice carries 30–45 hidden line items.

## Verdict

**M2 (prompt-aggregation loss) confirmed.** Scope is 5 invoices at Chicce, 0 at Vero, ~225 recoverable line items. The fix would NOT be page iteration (already covered by Anthropic's native multi-page support) but **refining the rebill rule in SYSTEM_PROMPT to distinguish thin rebills from passthrough invoices** — e.g. "if the page-2+ section sums to the page-1 summary total within ~5%, treat as itemization to enumerate, NOT as rebill detail to ignore". Alternatively: a per-supplier override (Laweka + Eventcenter are known passthrough suppliers at Chicce) or a per-invoice fallback to second-pass extraction when `rows_extracted=1` and `total_extracted > 30,000 SEK` and the description matches `/levererat från/i`.

**Operationally:**
- Not urgent enough to interrupt the recipe-authoring tool work — the 225 lines are concentrated in 5 invoices, and 4 of those are 2025-05 through 2025-09 (historical data, no longer driving fresh cost decisions).
- Worth scoping the prompt-refinement fix as a follow-up. Low risk (prompt-only change), high signal (each refined Laweka/Eventcenter extraction yields 30–45 new catalogue rows + product prices for an Italian-deli supplier currently invisible).
- Don't touch the cost path or the extractor in this investigation.

## Queries / files referenced

- `supplier_invoice_lines?business_id=eq.{Chicce|Vero}&supplier_name_snapshot=ilike.*{Laweka|Eventcenter|Marini|Rima}*`
- `supplier_invoice_lines?raw_description=ilike.*{Levererat}*`
- `invoice_pdf_extractions?business_id=eq.{Chicce|Vero}&status=eq.extracted`
- `fortnox_supplier_invoices?business_id=eq.Chicce&given_number=eq.3174` (header confirmation)
- `lib/inventory/pdf-extractor.ts:121` — `pdfBase64 = pdfBuffer.bytes.toString('base64')` (whole PDF, no page split)
- `lib/inventory/pdf-extractor.ts:770-787` — the `document` content block passed to Anthropic API
- `lib/inventory/pdf-extractor.ts:682-706` — the SYSTEM_PROMPT MULTI-INVOICE REBILLS rule (the false-positive surface)
- `lib/inventory/pdf-extractor.ts:811` — `max_tokens: 4096` (output cap; not a bottleneck in this case — Laweka 3174 used only 238 output tokens)

## What was NOT done

- No fix to SYSTEM_PROMPT.
- No re-extraction triggered on the 5 affected invoices.
- No writes to `supplier_invoice_lines`, `invoice_pdf_extractions`, or any other table.
- No additional Fortnox API calls; all read from existing cached state.
- No tasks marked complete that would have been pending on the fix.
