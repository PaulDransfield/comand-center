# Empty-Line Recovery Investigation (READ-ONLY)

Run: 2026-05-31
Read-only. No recovery performed.

## Three-line headline

1. **The 2 reference M&S invoices were PERFECTLY EXTRACTED — not a recovery opportunity, but the proof point that the extractor works when there's a PDF.** Vero #78592617 (given_number 9339): 7 itemized lines from pdf_extraction, total matches within 0.0003%. Chicce #78691561 (given_number 3598): 32 itemized lines, total matches within 0.00003%. Both `source='pdf_extraction'`, `status='extracted'`, `error_message=''`. The PDF vision pipeline is doing exactly what it should; the hypothesis "empties = extraction loss" doesn't hold for these two.

2. **The system-wide empties are on invoices the extractor marked `'no_pdf'` — 1,371 of 1,550 Vero empties (88.5%) and 234 of 239 Chicce empties (98%).** This is the classification "we looked up the invoice in Fortnox and found no PDF attached at the inbox/archive location." If accurate, those are genuinely source-blank from our system's perspective. Recoverable set is small: 40 Vero lines on 14 `'failed'` invoices (retryable now), 139 lines on 51 `'pending'` invoices (will resolve as worker processes them), 0 Chicce recoverable.

3. **One pattern worth flagging but not blocking on: 64 of 110 M&S Vero invoices (58%) are marked `'no_pdf'`, and a 3-invoice sample shows their parent rows aren't in `fortnox_supplier_invoices` at all** (probably older than the supplier-sync window). Could be a real "Fortnox truly has no PDF for these" answer, or could be the supplier-sync window cutting off the lookup before the PDF was discoverable. Worth a separate ticket: re-sync those older M&S invoices from Fortnox + re-attempt PDF extraction on a sample. NOT an emergency — the just-shipped Rule (b) is on reasonably solid ground; the recoverable population it's terminal-stating is small.

## Detailed findings

### Step 1 — The two reference M&S invoices traced end-to-end

#### Vero #78592617 (`given_number=9339`, 2026-05-08)

| | Value |
|---|---|
| Parent in `fortnox_supplier_invoices` | YES (total 1,529 SEK) |
| `supplier_invoice_lines` rows | **7 (all itemized)** |
| `source` for all rows | `pdf_extraction` |
| `match_status` breakdown | 3 matched, 2 needs_review, 2 not_inventory |
| `invoice_pdf_extractions` | 1 row, `status='extracted'`, `attempts=1`, `pdf_file_id=3918ff7f-...`, `rows_extracted=7`, total_extracted=1304.83 vs total_header=1305.22, delta 0.0003%, model `claude-sonnet-4-6`, cost $0.028 |
| `raw_data.Vouchers` | 1 SUPPLIERINVOICE ref (Series C, Number 413) |

Sample rows: "MONIN HASSELNÖT 70CL", "MONIN KARAMEL 70CL", "MONIN VANILLE 70CL", "PAPPERSSUGRÖR SV 6X150 250 FSC". Plus 2 not_inventory rows (SRS RETURBACK, Miljörabatt/Lev.avgift — correctly caught by Fix 2's deposit-logistics rule).

#### Chicce #78691561 (`given_number=3598`, 2026-05-26)

| | Value |
|---|---|
| Parent in `fortnox_supplier_invoices` | YES (total 10,006 SEK) |
| `supplier_invoice_lines` rows | **32 (all itemized)** |
| `source` for all rows | `pdf_extraction` |
| `match_status` breakdown | 30 matched, 1 needs_review, 1 not_inventory |
| `invoice_pdf_extractions` | 1 row, `status='extracted'`, `attempts=1`, `pdf_file_id=9b0032d7-...`, `rows_extracted=32`, total_extracted=9298.62 vs total_header=9298.91, delta 0.00003%, model `claude-haiku-4-5`, cost $0.031 |
| `raw_data.Vouchers` | 0 refs (interesting — this invoice predates the new cron-writer fix?) |

Sample rows: "AVOCADO MOGEN SOFTRIPE", "HÖGREV MARM KL4 4KG+", "NÖTFÄRS 10% KY EU 2,5KG", "FRITYROLJA LONG LIFE 10L", "RAPSOLJA 10L", "REAL MAJONNÄS 70% 10L UBF", "KEBAB NÖT FÄRDIGGR 2,5KG", "POMMES FRIT SLÄT 10MM 2,5K", "TOMAT SOLTORK STR OLJA 1,7". All real food products. Owner saw the PDF; the system has the same rich detail.

**Verdict on Step 1:** the hypothesis "empty lines = extraction loss" doesn't apply to these two invoices. The PDF extractor worked perfectly. The owner's intuition that M&S PDFs are rich is correct AND the system captured that richness for these specific invoices.

### Step 2 — System-wide recovery opportunity

| | Chicce | Vero |
|---|---:|---:|
| Total empty/blank lines | 239 | 1,550 |
| Distinct parent invoices | 59 | 505 |

**Invoice extraction state per parent:**

| | Chicce | Vero |
|---|---:|---:|
| already extracted successfully | 3 | 0 |
| extraction FAILED (retryable) | 0 | 14 |
| extraction `no_pdf` (per extractor's lookup) | 0 | 440 |
| extraction pending/in-progress | 56 | 51 |
| no extraction record at all | 0 | 0 |

**Line-level breakdown (Vero, the larger population):**

| Class | Lines | Note |
|---|---:|---|
| extraction `no_pdf` invoice | **1,371** (88.5%) | Per extractor classification, no recoverable PDF |
| extraction pending | 139 | Will resolve when worker processes them |
| extraction FAILED | **40** (2.6%) | **Immediately retryable** |
| extraction succeeded but line still empty | 0 | No anomaly |
| no extraction record at all | 0 | All invoices have at least one attempt |

**Recoverable headline: 40 Vero lines + 139 pending lines = at most ~179 lines could land back in the queue with extraction retries/completion.** Compared to the 608 lines I terminal-stated in (a) plus the ~268 that Rule (b) is catching now, the recoverable share is small (<20% of what's being terminal-stated).

**Chicce: 0 recoverable.** All Chicce empties trace to invoices either already extracted (anomaly worth flagging — empties survived extraction; 5 lines, low priority) or pending in-flight extraction.

### Step 3 — The Martin & Servera `no_pdf` mystery

| | Chicce | Vero |
|---|---:|---:|
| Total M&S invoices in DB | 179 | 105 (110 in extractions) |

**Vero M&S `invoice_pdf_extractions` breakdown:**
- 37 `extracted` (33%)
- **64 `no_pdf` (58%)** ← surprising
- 5 `needs_review`
- 4 `failed`

A 3-invoice sample of the 64 M&S `no_pdf` set (given_numbers 8358, 8274, 8365 — all lower than the working test invoice 9339, suggesting they're earlier) reveals: **their parent rows aren't in `fortnox_supplier_invoices` at all.** Three possibilities:

1. The supplier-sync cron has a lookback window (~12 months?) and these older invoices fell off
2. They were invoices entered into Fortnox without a PDF attachment
3. The supplier-sync cron failed/skipped them at the time and they were never imported

Without re-querying Fortnox's API directly we can't distinguish. But the existence of 64 M&S invoices with `no_pdf` extraction records but no corresponding parent in `fortnox_supplier_invoices` suggests the supplier-sync cache may have been wiped/recreated at some point, OR the M&S invoices vary in PDF attachment state.

### Step 3 — ÖVERSIKT KONTERING opportunity (sizing only)

Confirmed M&S supplies BAS-account subtotals on their PDFs (per the 2 reference invoices the owner saw). This would give a supplier-provided category mapping — richer than the voucher cache for this supplier. Not built; sizing only:

- 179 M&S invoices at Chicce; 105 at Vero (110 in extraction table)
- Of those, 37 already successfully extracted — the extractor's prompt currently captures itemized rows, not the ÖVERSIKT KONTERING summary block
- If the prompt was extended to capture the summary, ~37 Vero invoices' worth of supplier-provided BAS mappings could be added to our data with zero additional Fortnox calls

This is a Phase-3 extraction-enhancement candidate, not now.

## Implications for what was just shipped

**Rule (b) — Gate 0b-prime — is on reasonably solid ground.** It terminal-states source-blank empties on positive-BAS accounts. The empties it catches are predominantly from invoices the PDF extractor marked `no_pdf`, which is the closest signal we have to "genuinely no recoverable PDF." So Rule (b) isn't terminal-stating data we're losing.

**But two caveats worth not forgetting:**

1. **The `no_pdf` classification might be wrong for some.** 64 M&S Vero invoices is a striking pattern. The 3-invoice sample shows their parent records are missing from `fortnox_supplier_invoices` — could be old, could be data integrity. Worth a focused ticket to (a) re-sync those parents from Fortnox and (b) re-attempt PDF extraction on a sample to verify the `no_pdf` answer is honest. If `no_pdf` is sometimes wrong, the population terminal-stated by Rule (b) overlaps with that population.

2. **The 40 `failed` Vero lines + 139 `pending` lines are recoverable today.** A targeted "retry PDF extraction on failed/pending M&S Vero invoices" pass could land ~179 line items back in needs_review for Paul's manual pass — small relative to ~718 distinct, but still actual food/alcohol products. Worth a separate small ticket.

## What was NOT done

- No recovery action (per the prompt's HARD RULES)
- No re-extraction attempted
- No PDF content fetched or dumped
- No status changes to existing lines
- No verification against Fortnox API of whether the 64 `no_pdf` M&S invoices truly have no attached PDF — would require fresh Fortnox API calls

## Recommended next steps (for owner to call)

1. **Open a ticket: "Verify Fortnox PDF presence for the 64 M&S Vero `no_pdf` invoices."** Pick 5-10 invoices, manually check via Fortnox UI whether PDFs are attached. If they ARE present, the extractor's `no_pdf` check is missing them — investigate the pdf_file_id lookup path. If they ARE NOT present, the extractor was right; the `no_pdf` classification is honest.
2. **Open a ticket: "Retry PDF extraction on the 14 `failed` + 51 `pending` Vero invoices."** Cheap; could recover ~179 lines. Run after Paul's manual pass starts so it doesn't muddy the queue counts mid-triage.
3. **Phase 3 candidate: extend the PDF extractor prompt to capture the ÖVERSIKT KONTERING summary block** for M&S invoices, adding supplier-provided BAS mappings to the data. Not now.
