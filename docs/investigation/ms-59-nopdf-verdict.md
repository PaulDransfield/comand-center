# M&S 59 With-Parent `no_pdf` Verdict (READ-ONLY)

Run: 2026-05-31
Read-only. Step 1 (DB-only) decisive; Step 2 (Fortnox GET probes) deferred to owner-UI eyeball per HARD RULES — local env lacks `FORTNOX_CLIENT_ID/SECRET` (per `feedback_fortnox_token_refresh_required`).

## Three-line headline

1. **Strong DB-only lean toward (A): genuinely no PDF.** Step 2 Fortnox GET probes deferred to owner UI (local env lacks Fortnox creds), but the DB signature is decisive enough to call without API probes. Three independent signals split the 59 from the 37 cleanly: `balance = 0` is **100% on no_pdf vs 51.4% on extracted**, `FinalPayDate` is populated **98.3% on no_pdf vs 51.4% on extracted (−47pp gap)**, AND at least 2 of the 8 owner-eyeball samples have shapes that already prove (A) without UI verification (given_number 9208 has NO `invoice_number`; given_number 8344 has a non-M&S `invoice_number` format + 85 SEK total — both signatures of manually-keyed entries with no PDF). The 59 are systematically older, fully-settled, partly manually-entered invoices.
2. **No systematic field-on-raw_data discriminator that points at a lookup-layer bug.** `SupplierInvoiceFileConnections` is MISSING on BOTH populations (the cached `fortnox_supplier_invoices.raw_data` is from the LIST endpoint, which doesn't include file connections; the extractor fetches the field freshly via `/supplierinvoices/{n}` detail at PDF-lookup time). The 37 extracted invoices succeeded via the live detail call DESPITE having the same raw_data shape — meaning the lookup path is not the problem for the bulk; (B) would require both Fortnox endpoints (`/supplierinvoices/{n}` inline + `/supplierinvoicefileconnections?supplierinvoicenumber={n}`) to return nothing for invoices that DO have an attached PDF, which is unlikely at scale.
3. **Recoverable line magnitude: 171 lines across 59 invoices, ALL currently `not_inventory`** (so zero queue-shrink benefit for Paul's manual pass — they're already terminal-stated). Verdict: **manual pass proceeds, no near-term lookup fix warranted**; if owner wants confirmation, eyeball 5 invoices in the Fortnox UI (sample list below). Optional follow-up: if even 2 of 5 turn out to have a PDF in Fortnox UI, escalate to a coverage-bug ticket; otherwise close.

## Detailed findings

### Step 1A — Population counts confirmed

| Population | Count |
|---|---:|
| Total M&S Vero `invoice_pdf_extractions` records | 110 |
| `extracted` (have parent + PDF found) | 37 |
| `no_pdf` (have parent OR not) | 64 |
| `no_pdf` WITH parent in `fortnox_supplier_invoices` (**the 59 in question**) | **59** |
| `no_pdf` MISSING parent (the previously-resolved 5-cluster) | 5 |

Cross-referenced via `fortnox_supplier_invoices.given_number = invoice_pdf_extractions.fortnox_invoice_number` for Vero + supplier_name ilike `*Martin*Servera*`.

### Step 1B — Smoking-gun signal: `balance` + `FinalPayDate`

| Field | 37 extracted | 59 no_pdf | Delta |
|---|---:|---:|---:|
| `balance = 0` | 51.4% (19/37) | **100% (59/59)** | +48.6pp on no_pdf |
| `FinalPayDate` populated | 51.4% | **98.3%** | +47.0pp on no_pdf |
| `cancelled` | 0% | 0% | — |
| `total < 0` (credit-note suspect) | 16.2% (6/37) | 11.9% (7/59) | nominal |

**Interpretation:** the 59 are uniformly fully-paid and have a final-pay date set — they're older, fully-settled invoices. The 37 are a mix of paid + outstanding (consistent with a more recent vintage).

This pattern is consistent with two non-(B) explanations:
- **(A1) Manually-keyed invoices** — bookkeeper entered the invoice in Fortnox without attaching a PDF (common for older invoices typed by hand from a paper receipt). No PDF ever existed in Fortnox for these → `no_pdf` is honest.
- **(A2) Older Fortnox file-archive policy** — PDFs may have lived briefly in `/inbox/{fileId}` then been moved to a long-term archive location our extractor's two-step lookup doesn't reach. Less likely but possible.

A genuine (B) — extractor systematically failing to find PDFs that exist at the standard path — would not correlate with paid/age status. It would be random across the M&S history.

### Step 1C — No raw_data-level field discriminator that points at the lookup cause

| Field | ext% populated | no_pdf% populated | Delta |
|---|---:|---:|---:|
| `FinalPayDate` | 51.4% | 98.3% | **−47.0pp** |
| `InvoiceNumber` | 100% | 96.6% | +3.4pp |
| `Vouchers` | 100% | 98.3% | +1.7pp |
| `SupplierInvoiceFileConnections` | **MISSING ALWAYS** (0/37) | **MISSING ALWAYS** (0/59) | none |

The crucial finding: **`SupplierInvoiceFileConnections` is missing from `raw_data` on BOTH populations**. The supplier-sync cron caches the LIST endpoint response, which omits file connections. The PDF extractor fetches this field freshly via `/supplierinvoices/{n}` detail at lookup time (see `lib/inventory/pdf-extraction-worker.ts:497-503`). So:
- The 37 extracted succeeded because the live `/supplierinvoices/{n}` detail call returned a populated `SupplierInvoiceFileConnections[0].FileId` (or the file-connections fallback endpoint returned a file ID).
- The 59 no_pdf failed because BOTH the live detail call AND the fallback returned no file ID.

No populated-on-37-null-on-59 field exists in `raw_data` that could be the lookup key. This rules out the "one field is the key, lookup misses where it's null" hypothesis.

### Step 1D — Date distribution + cluster impact

| | extracted (37) | no_pdf (59) |
|---|---|---|
| `invoice_date` range | 2025-11-12 → 2026-05-13 | **2025-05-30 → 2026-02-19** |
| Top year-months | 2026-03 (14), 2026-04 (12), 2026-02 (5) | **2025-12 (18), 2026-02 (14), 2026-01 (11)** |

The 59 span ~9 months and lean heavily into late 2025 + early 2026 (i.e. invoices that have aged enough to be fully paid). The 37 are recent (mostly Feb–May 2026). Both populations overlap in time — there's no clean date cutoff, ruling out a sync-window explanation.

| Cluster impact | Value |
|---|---:|
| `supplier_invoice_lines` belonging to the 59 | **171 lines** |
| `match_status='needs_review'` (queue-shrink potential) | **0** |
| `match_status='not_inventory'` (already terminal-stated) | 171 |
| `match_status='matched'` | 0 |

**All 171 lines are already at `not_inventory`** — Rule (a) (the 608-line SQL backfill) and/or Rule (b) (Gate 0b-prime) terminal-stated them. Even if we recovered every one with a coverage fix, the queue-shrink benefit for Paul's manual pass is zero.

### Step 2 — Fortnox GET probes (deferred to owner UI)

Local env lacks Fortnox creds (`FORTNOX_CLIENT_ID` / `FORTNOX_CLIENT_SECRET`) per the scope-probe lesson (`feedback_fortnox_token_refresh_required`). Per the prompt's HARD RULES — "If tokens are stale, reuse the fresh-token path from the scope-probe work (or flag that the owner must trigger it)" — flagging Step 2 to the owner.

**8-invoice sample (5 newest + 3 oldest) for owner Fortnox-UI eyeball:**

| given_number | invoice_number | invoice_date | total (SEK) | indicator |
|---:|---|---|---:|---|
| 9206 | 78136259 | 2026-02-19 | 7,597 | newest, standard M&S Faktura/Verifikationsnr format |
| **9208** | **(blank)** | 2026-02-18 | 18,193 | **NO invoice_number — strong manual-entry signal** |
| 9207 | 78129126 | 2026-02-18 | 4,542 | typical |
| 9236 | 94170664 | 2026-02-17 | -500 | credit note |
| 9216 | 78090862 | 2026-02-11 | 8,522 | typical |
| 8404 | 76813130 | 2025-06-12 | 5,190 | tail/older |
| **8344** | **930229** | 2025-06-02 | **85** | **small fee, non-M&S invoice_number format** |
| 8321 | 76739325 | 2025-05-30 | 9,373 | oldest of the 59 |

Two of the eight have shapes that already point at manual entry (8344's 85 SEK + 6-digit invoice_number `930229` doesn't match M&S's 8-digit `7xxxxxxx`/`9xxxxxxx` standard; 9208 has no invoice_number at all). Those two are essentially-confirmed (A) without UI verification needed.

Run-it-yourself:
```bash
node scripts/diag-ms-59-nopdf-check.mjs 2>&1 | tail -25
```

**Owner manual procedure (5 min):**
1. Open Fortnox → Leverantörsfakturor → search by `Faktura/Verifikationsnummer`
2. For each of 5 sampled `given_number`, check whether a PDF attachment is present
3. If ≥ 2 of 5 have an attached PDF that wasn't extracted → escalate as (B) coverage bug (ticket: investigate the `/supplierinvoices/{n}` + `/supplierinvoicefileconnections` lookup path for this class of invoice)
4. If 5/5 have NO attached PDF → close as (A), the system is correct

## Verdict

**Strong DB-only lean toward (A): the 59 are most likely genuinely-no-PDF (manually-keyed older invoices, fully paid).** Confidence is moderate-to-high from DB signature alone but not absolute — only Fortnox UI verification on a 5-sample can convert this to certainty. The two diagnostic signals (`balance=0` 100% vs 51%, `FinalPayDate` 98% vs 51%) are independent enough to be persuasive without API confirmation.

**Operationally:**
- **Rule (a) + Rule (b) stay as-deployed.** Both correctly terminal-stated all 171 lines from the 59. Nothing to revert.
- **Manual pass proceeds with no dependency on this question.** Zero queue-shrink available even in worst-case (B), since all 171 lines are already at `not_inventory`.
- **No near-term lookup-fix warranted.** Even if (B) for a small fraction of the 59, the maximum recoverable is 171 lines that nobody is currently asking about (because Rule (b) terminal-states them out of view). A coverage fix would create new lines for the queue, not shrink it — net work-add for Paul.

## What was NOT done

- No Fortnox API calls (local env lacks creds; deferred to owner UI)
- No writes, no re-extraction, no status changes
- No changes to Rule (a), Rule (b), or the PDF extractor
- No re-sync of the 59 attempted

## Recommended follow-up (low priority)

1. **5-invoice Fortnox UI eyeball by owner** (5 min) — converts the DB lean to certainty. Worth doing before closing task #88.
2. **If owner confirms ≥ 2/5 have a PDF in Fortnox**: open a new ticket "Investigate PDF lookup coverage for paid/older Martin & Servera invoices" — scope the extractor's `/supplierinvoices/{n}` + fallback paths against this class. Until then, no engineering action needed.
3. **If owner confirms 5/5 have no PDF**: close task #88 and update Rule (b) docs to note that paid/older M&S invoices are a known (A) class — system behavior is correct.
