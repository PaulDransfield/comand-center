-- M082 — Persist extracted rows on invoice_pdf_extractions
--
-- Phase B.4 (the review UI) needs access to the rows Claude extracted
-- even when validation BLOCKED the apply (status='needs_review'). Pre-
-- M082 the worker only persisted rows via apply_invoice_pdf_extraction
-- RPC when validation passed — for needs_review the rows lived only in
-- the model response and were discarded.
--
-- Adds a JSONB column on invoice_pdf_extractions to store the raw
-- extracted row payload. Used by:
--   1. The owner-facing review UI (/inventory/extractions/[id]) to
--      render an editable grid for fix-up.
--   2. The apply endpoint that re-runs the RPC after owner edits.
--
-- Shape: same as what apply_invoice_pdf_extraction's p_rows JSONB
-- argument accepts —
--   [{ row_number, description, article_number, quantity, unit,
--      price_per_unit, total_excl_vat, vat_rate }, ...]
--
-- Stored regardless of whether the extraction succeeded or was flagged
-- needs_review; nullable so old rows (pre-M082) remain valid.

ALTER TABLE invoice_pdf_extractions
  ADD COLUMN IF NOT EXISTS extracted_rows_json JSONB;
