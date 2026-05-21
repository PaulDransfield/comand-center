# Inventory Path B — PDF Row Extraction

> **Owner:** Paul Dransfield
> **Drafted:** 2026-05-22
> **Status:** Implementing
> **Builds on:** `INVENTORY-CATALOGUE-PLAN.md`, M047 Fortnox apply guardrails

---

## 0. The reality this exists to solve

Phase A of the inventory catalogue (commits `a088d64`, `b274d8e`) assumed Fortnox's `/supplierinvoices/{n}` endpoint returns per-line product descriptions. On Chicce's first real backfill we discovered the assumption is false: **all 3218 lines came back with `raw_description = ''`**.

Why: Chicce's bookkeeper (and many small Swedish restaurants) books supplier invoices as a single-line payable — "Inköp från Martin Servera, 12 540 kr" — not as itemised rows. The actual product detail lives in the PDF attachment, not in Fortnox's structured data.

The owner mandate is unchanged: *"100% way to build inventory items from day 1 we connect"*. So Path B = parse the PDFs.

---

## 1. The prime directive (Path B edition)

> **Every supplier invoice in Fortnox with an attached PDF becomes structured product rows in `supplier_invoice_lines` within minutes of OAuth connect. Failure modes are explicit, never silent. The owner can trust the catalogue.**

Specifically:
- **Extracted rows MUST balance against the Fortnox invoice header total** (within ±2 % tolerance, configurable). A failed total-match flags the extraction for owner review — never silently overwrites a placeholder.
- **PDF extraction is keyed on `(business_id, fortnox_invoice_number)`** — re-running is a no-op, never duplicates.
- **The catalogue dedup invariant from Phase A still holds.** Extracted rows enter the matching ladder exactly like Fortnox-row data did.

---

## 2. Where this slots into the existing pipeline

```
Fortnox supplier invoice
       │
       ▼
[Phase A backfill worker]                    ← already shipped
       │  pulls /supplierinvoices/{n}
       │  upserts supplier_invoice_lines     ← may have raw_description=''
       │
       ▼
[NEW: PDF extraction worker]                 ← Path B
       │  detects empty-description rows
       │  fetches PDF via Fortnox file API
       │  Claude Sonnet 4.6 → structured rows
       │  validates total + VAT match header
       │  REPLACES empty placeholders atomically
       │
       ▼
[Matcher]                                    ← already shipped, gate now
       │  steps 1-5 of INVENTORY-CATALOGUE-PLAN §3
       │
       ▼
[Catalogue + Phase B review queue]           ← already shipped
```

The extraction runs **between** the existing backfill and the matcher. The matcher doesn't need to know whether rows came from Fortnox-structured-data or from PDF extraction — both end up shaped the same in `supplier_invoice_lines`.

---

## 3. Data model — M078

### `invoice_pdf_extractions`

Per-invoice job + audit record. One row per `(business_id, fortnox_invoice_number)`.

```sql
CREATE TABLE invoice_pdf_extractions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id             UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,
  fortnox_invoice_number  TEXT NOT NULL,
  invoice_date            DATE NOT NULL,
  supplier_fortnox_number TEXT,
  supplier_name_snapshot  TEXT,

  pdf_file_id             TEXT,                -- Fortnox file ID; NULL = no PDF attached
  status                  TEXT NOT NULL,
  -- 'pending' | 'extracting' | 'extracted' | 'failed' | 'no_pdf'
  -- 'needs_review' (validation flagged it for owner; rows are NOT applied)

  attempts                INTEGER NOT NULL DEFAULT 0,

  -- Result fields (populated on success)
  rows_extracted          INTEGER,
  total_extracted         NUMERIC,
  total_header            NUMERIC,             -- from Fortnox invoice header
  total_delta_pct         NUMERIC,             -- |extracted - header| / header
  validation_warnings     JSONB,               -- [{ code, message, severity }, …]

  -- Cost telemetry
  ai_model                TEXT,
  tokens_input            INTEGER,
  tokens_output           INTEGER,
  cost_usd                NUMERIC,

  error_message           TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,

  UNIQUE (business_id, fortnox_invoice_number)
);
```

### `supplier_invoice_lines.source`

New column tagging row provenance:

```sql
ALTER TABLE supplier_invoice_lines
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'fortnox_row';
-- 'fortnox_row'      — original structured row from /supplierinvoices/{n}
-- 'pdf_extraction'   — extracted by the Path B worker
-- 'owner_correction' — manually entered/edited by the owner
```

### Atomicity rule

When extraction succeeds and rows are persisted, ALL existing rows for that `(business_id, fortnox_invoice_number)` get DELETED first inside the same transaction, then the new rows INSERTED. No mixed placeholders + extracted rows. The unique constraint on `(business_id, fortnox_invoice_number, row_number)` enforces this.

---

## 4. The extraction worker

`lib/inventory/pdf-extractor.ts` — pure function `extractInvoicePdf(db, ctx)` that:

### 4.1 Identify the PDF

The invoice's `SupplierInvoiceFileConnections` array (already in the Fortnox response) carries `FileId` values. We pick the first one and treat it as the canonical invoice PDF. Multi-file invoices: we extract the first; the others get a warning in `validation_warnings`.

If no FileId → `status = 'no_pdf'`, done.

### 4.2 Fetch the PDF bytes

Via Fortnox's `/3/inbox/{file_id}` endpoint with the same token-refresh chokepoint (`getFreshFortnoxAccessToken`) used everywhere else. Response is `application/pdf` bytes. Cap at 10 MB; bigger → fail with `error: 'pdf_too_large'`.

### 4.3 Send to Claude

**Model:** `AI_MODELS.ANALYSIS` (Sonnet 4.6) with extended thinking + tool use, per the existing extraction pattern from M047.

**Prompt structure** (system prompt cached via prompt caching):
```
You are extracting product-row data from a Swedish supplier invoice PDF.

Output schema (call the `record_invoice_rows` tool):
{
  "rows": [
    {
      "row_number":      integer  (1-based, sequential, no gaps),
      "description":     string   (product name, including brand + variant),
      "article_number":  string|null  (supplier's SKU if printed),
      "quantity":        number,
      "unit":            string|null  (kg, st, l, förp, etc.),
      "price_per_unit":  number,
      "total_excl_vat":  number,
      "vat_rate":        number   (Swedish standard 6/12/25 — match the row's printed VAT)
    }
  ],
  "header": {
    "invoice_total_excl_vat": number,
    "invoice_total_inc_vat":  number,
    "supplier_org_number":    string|null,
    "invoice_date":           string|null  (YYYY-MM-DD)
  }
}

Hard rules:
- Extract EVERY line item that represents a product sold.
- Do NOT include rate-of-VAT summary rows, sub-totals, "fraktkostnad" unless
  it is itemised against goods.
- If a line shows quantity 0 or is a credit-note line (negative qty/total),
  preserve the sign — the matcher handles negatives.
- Never invent rows. If the PDF is unreadable, return rows: [] and we'll
  flag the invoice for owner review.
```

**Why tool use:** Anthropic's function-call API forces the response into the schema — no JSON parsing of free-text needed.

**Token budget:**
- Input: ~3-10 KB system prompt (cached) + PDF (typically 50-500 KB → ~10-100 K tokens for vision)
- Output: 500-3000 tokens typical
- Per-invoice cost: $0.02-0.04 (Sonnet 4.6 pricing)
- 784 invoices × $0.03 ≈ $24 for Chicce's full backfill
- 50 customers × 200 invoices × $0.03 ≈ $300 one-time onboarding cost across customer base

### 4.4 Validate

Run two validators before committing rows:

1. **`total_match`** — `|sum(rows.total_excl_vat) - header.invoice_total_excl_vat| / header.invoice_total_excl_vat < 0.02` (2 % tolerance).
   - Fail → `status='needs_review'`, push to owner queue. Rows NOT persisted.
2. **`vat_present`** — every row has `vat_rate IN (6, 12, 25)`. Anything else → warning (not blocker).
3. **`description_non_empty`** — every row has `description.length > 2`. Empty rows → warning + dropped.

Validation warnings go into `validation_warnings[]`. Blockers stop persistence; warnings let it proceed with a flag.

### 4.5 Persist atomically

Inside one Supabase RPC (`apply_invoice_pdf_extraction`) so we get transactional semantics:

```sql
CREATE OR REPLACE FUNCTION apply_invoice_pdf_extraction(
  p_business_id  UUID,
  p_invoice_no   TEXT,
  p_rows         JSONB
) RETURNS VOID AS $$
BEGIN
  DELETE FROM supplier_invoice_lines
  WHERE business_id = p_business_id
    AND fortnox_invoice_number = p_invoice_no;

  INSERT INTO supplier_invoice_lines (...)
  SELECT … FROM jsonb_to_recordset(p_rows) AS x(...);
END;
$$ LANGUAGE plpgsql;
```

After this RPC the matcher can run on the new rows (status='needs_review' until matched).

---

## 5. Onboarding hook — day 1

The user's hard requirement: *"from day 1 we connect, inventory + sales + staff cost"*. Wiring:

1. Owner clicks **Connect Fortnox** → existing OAuth flow → integration row created.
2. Existing post-OAuth: kicks Fortnox tracker_data backfill (12-month P&L summaries).
3. **NEW**: also kicks the inventory pipeline:
   a. `/api/inventory/lines/backfill` — gets the 784 invoice metadata rows
   b. `/api/inventory/lines/extract-pdfs` — runs Path B on every invoice with empty descriptions and an attached PDF
   c. Re-match runs automatically when extraction completes
4. By the time the owner lands on `/dashboard`, the catalogue is populated. `/inventory/items` shows real SKUs.

Sequencing: extraction runs serially per business because of the Vercel function maxDuration (800 s × ~10-15 s per invoice = ~50-60 invoices per function invocation). For 784 invoices that's ~10-15 chained function calls. Auto-chaining via `waitUntil` at the end of each batch.

---

## 6. Phasing for the build (today)

### Phase B.1 — Foundation (~3-4 h)
- `sql/M078-INVOICE-PDF-EXTRACTIONS.sql` — table + source column + RPC
- `lib/inventory/pdf-extractor.ts` — fetch + Claude call + validate + persist
- `app/api/inventory/lines/extract-pdfs/route.ts` — kick endpoint (waitUntil)
- `lib/inventory/pdf-extraction-worker.ts` — the loop body (one batch's worth of invoices)
- Status surfaced through existing `inventory_backfill_state` (extra phase: `extracting_pdfs`)

### Phase B.2 — Admin operability (~30 min)
- Button on `/admin/v2/tools`: "Extract PDFs for needs-extraction invoices"
- Live progress card shows: invoices_with_pdf, extracted, failed, needs_review, total_cost_usd

### Phase B.3 — Onboarding wire-up (~30 min)
- After Fortnox OAuth completes, auto-fire the inventory pipeline (backfill → extract → match) via background job

### Phase B.4 — Validation-failure review UI (deferred to Phase C planning)
- `/inventory/extractions` page listing invoices in `status='needs_review'`
- Side-by-side: PDF preview + extracted rows + owner edit grid

---

## 7. Failure modes + their explicit handling

| Failure | `status` | What the worker does | What the owner sees |
|---|---|---|---|
| No PDF attached | `no_pdf` | Skip, no retry | Catalogue line stays at supplier level for this invoice |
| PDF > 10 MB | `failed` (error='pdf_too_large') | Skip, no retry | Flagged in tooling; owner can manually upload via `/overheads/upload` |
| Claude returns 0 rows | `needs_review` | No persistence | Manual review queue |
| Total mismatch > 2 % | `needs_review` | No persistence | Manual review queue with PDF + rows for editing |
| Anthropic 5xx / quota | `failed` (retryable) | Increment attempts, retry on next worker pass up to 3× | Background; owner unaware unless it sticks |
| All retries exhausted | `failed` | Final state | Surfaced in admin tools as ops alert |

---

## 8. Cost guardrails

- Per-org daily AI cap (existing `checkAndIncrementAiLimit`) — extraction calls count.
- Global kill switch (existing `ai_spend_24h_global_usd`) — if total AI cost crosses the cap, extraction pauses.
- `invoice_pdf_extractions.cost_usd` accumulates per row; we can query `SUM(cost_usd) BY business_id` for the org-level cost report.

---

## 9. What success looks like for Chicce

Within 30 minutes of kicking the PDF extraction:
- Most of the 784 invoices: `status = 'extracted'` with average ~3-8 rows each
- A handful: `status = 'needs_review'` (total mismatch / unusual PDF layout)
- Maybe 5-10: `status = 'no_pdf'` (rare — most Fortnox invoices have attachments)
- `supplier_invoice_lines` grows from 3218 placeholder rows to ~3000-5000 real product rows
- Matcher re-run: most go to `needs_review` (cold catalogue), some auto-cluster
- Real SKU catalogue exists for the first time

Then Phase B (the original Phase B from `INVENTORY-CATALOGUE-PLAN.md`) — the review UI — becomes the next thing to build.

---

## 10. Memory hooks (after ship)

- `feedback_inventory_pdf_extraction_canonical` — the only canonical source for inventory item names when Fortnox structured rows are empty. M078 RPC `apply_invoice_pdf_extraction` is the only writer; matcher runs after.
- `feedback_extraction_total_match_invariant` — extracted rows must balance to Fortnox header within 2 %, else `needs_review`. Same discipline as M047 tracker_data extraction.
- `reference_fortnox_inbox_endpoint` — `/3/inbox/{file_id}` returns PDF bytes; same token-refresh chokepoint as everywhere else.
