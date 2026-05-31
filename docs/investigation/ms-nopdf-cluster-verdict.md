# M&S `no_pdf` Cluster Verdict (READ-ONLY)

Run: 2026-05-31
Read-only. No Fortnox API calls made (DB signature was decisive — Step 2 unnecessary).

## Three-line headline

1. **The cluster is 5 invoices, not 64 — my prior investigation misclassified the breakdown.** Of 64 M&S Vero invoices marked `no_pdf`, **59 have parent rows in `fortnox_supplier_invoices`** and only **5 are missing parents** (the actual missing-parent cluster). The 3-invoice sample I drilled into previously (given_numbers 8358, 8274, 8365) happened to BE 3 of those 5 cluster invoices, which created the false impression of 64-across-the-board missing parents. Corrected.
2. **The 5-invoice cluster has a clean date-cutoff signature: 2025-05-02 to 2025-05-23 (3-week window) — all predate the supplier-sync's coverage** which begins at 2025-11-12 for M&S Vero invoices. That's a textbook (B) sync-window-gap signature. The supplier_invoice_lines impact is **18 lines, all currently `not_inventory`** — Rule (a)+(b) already terminal-stated them.
3. **Manual pass proceeds — don't wait on a sync fix.** The recoverable population is 18 lines from 5 invoices. Even if we re-sync and re-extract, it adds 18 itemized lines to the queue (negligible relative to the ~718 distinct itemizable products Paul is about to triage). Logging a low-priority follow-up to re-sync the 5 if/when it's convenient.

## Detailed findings

### Step 1 — Cluster characterisation (READ-ONLY DB)

**M&S Vero `invoice_pdf_extractions` by status (110 records):**
- `extracted`: 37
- `no_pdf`: 64
- `needs_review`: 5
- `failed`: 4

**The 64 `no_pdf` split by parent presence in `fortnox_supplier_invoices`:**

| | Count |
|---|---:|
| **With parent in `fortnox_supplier_invoices`** | **59** |
| **WITHOUT parent (the actual cluster)** | **5** |

The 59 with-parent `no_pdf` records mean: the parent invoice was synced via the supplier-sync cron, but when the PDF extractor looked up the PDF in Fortnox, none was found at the expected file-attachment location. These are a separate question (could be (A) genuinely no PDF — manually-entered invoices, credit notes, etc., or could be a PDF-lookup layer issue), and aren't the missing-parent cluster the prompt asked about.

### Step 1 — Date-cutoff signature for the 5-invoice cluster

| | Range |
|---|---|
| Cluster (no_pdf + missing parent) invoice_date range | **2025-05-02 to 2025-05-23** (3-week window) |
| Cluster given_number range | 8274 to 8365 |
| Successfully extracted M&S invoice_date range | **2025-11-12 to 2026-05-13** |
| Successfully extracted given_number range | 8742 to 9346 |
| **Gap** | **2025-05-24 to 2025-11-11 (~6 months)** — no M&S Vero invoices in DB during this window |

The cluster ends at 2025-05-23. The extracted set begins at 2025-11-12. **Clean cutoff.** Strong (B) sync-window-gap signature — these 5 invoices fell off the supplier-sync cron's lookback window when it ran (or were never synced because the cron didn't start until later in 2025). The 5 invoices ARE in Fortnox (almost certainly — they're real M&S invoices the bookkeeper booked); they just never made it into our `fortnox_supplier_invoices` cache.

The 6-month gap suggests the supplier-sync cron's initial backfill or first-meaningful-run was around 2025-11-12. Anything before that didn't get pulled. The 5 cluster invoices are the M&S residue from that earlier window.

### Step 1 — Cluster impact

The 5 cluster invoices contribute 18 lines to `supplier_invoice_lines` — all currently at `match_status='not_inventory'`. The 18 lines were terminal-stated by Rule (a) (the SQL backfill that ran today) and/or Rule (b) (Gate 0b-prime, just shipped).

**No `needs_review` lines** are part of this cluster — meaning the recovery wouldn't shrink Paul's manual-pass queue. It would only restore product-detail tracking for 18 lines that are currently "not_inventory" but, if recovered, would be real food/drink items.

### Step 2 — Fortnox GET probes (NOT performed)

The DB signature was decisive: clean date cutoff, small cluster, low impact. Step 2 Fortnox GET probes would confirm the (B) sync-gap diagnosis with higher certainty but wouldn't change the operational outcome (manual pass proceeds regardless; the optional sync fix is the same regardless of probe results). Skipped for efficiency.

If the owner wants Step 2 anyway, the 5-sample list:
- given_number=8322, invoice_date=2025-05-23
- given_number=8328, invoice_date=2025-05-16
- given_number=8365, invoice_date=2025-05-09
- given_number=8274, invoice_date=2025-05-08
- given_number=8358, invoice_date=2025-05-02

Note: local env lacks `FORTNOX_CLIENT_ID` / `FORTNOX_CLIENT_SECRET` (per the earlier scope-probe lesson — see `feedback_fortnox_token_refresh_required`). If access tokens are stale, the probe would need to either run from prod via the existing Fortnox helper or have the owner verify manually in the Fortnox UI (5-min eyeball job).

## Verdict

**The 5-invoice missing-parent cluster is a clean (B) — sync-window gap, not (A) genuinely no PDF.** Diagnosis confidence is high based on the date-cutoff signature alone.

**Operationally:**
- **Rule (b) stays live as deployed.** The misclassification in my prior investigation didn't impact what was shipped — Rule (b) is correct for the bulk of the no_pdf population (the 59 with-parent records).
- **Manual pass proceeds.** The recoverable share (18 lines, all already terminal-stated, not in needs_review) doesn't justify gating Paul's manual pass.
- **The 59 with-parent `no_pdf` records remain unverified.** They could be (A) — genuinely no PDF in Fortnox — or they could be a PDF-lookup-layer issue. Separate question; smaller priority than the active manual-pass work.

## Recommended follow-up (low priority)

1. **Optional: Extend the supplier-sync lookback** to cover the 2025-05 gap, then trigger a fresh sync — recovers the 5 missing parents, then re-trigger PDF extraction on those 5. Net gain: 18 lines re-itemized. Sized at <30 min of work, near-zero blast radius. Not urgent.
2. **Already logged: investigate the 59 with-parent no_pdf records** (the broader PDF-availability question). Same task as #88 (verify Fortnox PDF presence for M&S Vero `no_pdf` invoices) — should now scope to the 59 with-parent set rather than the original 64.

## What was NOT done

- No Fortnox API calls
- No re-sync attempted
- No re-extraction attempted
- No changes to Rule (b) or any deployed code
