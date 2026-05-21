-- M078 — Invoice PDF extraction (Path B of INVENTORY-PATH-B-PDF-EXTRACTION.md)
--
-- Phase A revealed that Fortnox's /supplierinvoices/{n} doesn't return
-- per-line product data for every customer (Chicce's first backfill:
-- 3218/3218 rows had raw_description = ''). Path B parses the PDF
-- attachment with Claude Sonnet 4.6 + extended thinking + tool use.
--
-- This migration adds:
--   1. invoice_pdf_extractions — one row per (business, invoice_no)
--      audit + job state.
--   2. supplier_invoice_lines.source — provenance tag so we can
--      tell apart Fortnox-structured rows, PDF-extracted rows, and
--      owner corrections.
--   3. apply_invoice_pdf_extraction() RPC — atomic
--      DELETE + INSERT so a re-extraction replaces (never duplicates)
--      the placeholder rows.
--
-- Idempotent: all CREATEs are IF NOT EXISTS, all ALTERs likewise.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. supplier_invoice_lines.source
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.supplier_invoice_lines
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'fortnox_row';

COMMENT ON COLUMN public.supplier_invoice_lines.source IS
  'Row provenance: fortnox_row (original from /supplierinvoices/{n}), '
  'pdf_extraction (parsed from PDF via M078 pipeline), '
  'owner_correction (manually entered/edited).';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. invoice_pdf_extractions
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.invoice_pdf_extractions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id             UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,
  fortnox_invoice_number  TEXT NOT NULL,
  invoice_date            DATE NOT NULL,
  supplier_fortnox_number TEXT,
  supplier_name_snapshot  TEXT,

  -- Fortnox file ID. NULL = the invoice has no PDF attachment, so
  -- there's nothing to extract; the row goes to status='no_pdf'.
  pdf_file_id             TEXT,

  -- Workflow state. See INVENTORY-PATH-B-PDF-EXTRACTION.md §7.
  status                  TEXT NOT NULL,

  attempts                INTEGER NOT NULL DEFAULT 0,

  -- Result fields (populated on extracted/needs_review)
  rows_extracted          INTEGER,
  total_extracted         NUMERIC,
  total_header            NUMERIC,
  total_delta_pct         NUMERIC,
  validation_warnings     JSONB,

  -- Cost telemetry (per call). Sums per business give the org cost report.
  ai_model                TEXT,
  tokens_input            INTEGER,
  tokens_output           INTEGER,
  cost_usd                NUMERIC,

  error_message           TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT invoice_pdf_extractions_status_chk CHECK (status IN (
    'pending', 'extracting', 'extracted', 'failed', 'no_pdf', 'needs_review'
  )),

  UNIQUE (business_id, fortnox_invoice_number)
);

CREATE INDEX IF NOT EXISTS invoice_pdf_extractions_status_idx
  ON public.invoice_pdf_extractions (business_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS invoice_pdf_extractions_needs_review_idx
  ON public.invoice_pdf_extractions (business_id, completed_at DESC)
  WHERE status = 'needs_review';

ALTER TABLE public.invoice_pdf_extractions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoice_pdf_extractions_select ON public.invoice_pdf_extractions;
CREATE POLICY invoice_pdf_extractions_select ON public.invoice_pdf_extractions
  FOR SELECT USING (org_id = ANY(current_user_org_ids()));

DROP POLICY IF EXISTS invoice_pdf_extractions_modify ON public.invoice_pdf_extractions;
CREATE POLICY invoice_pdf_extractions_modify ON public.invoice_pdf_extractions
  FOR ALL USING (org_id = ANY(current_user_org_ids()))
  WITH CHECK (org_id = ANY(current_user_org_ids()));

-- updated_at trigger reusing the existing helper pattern.
CREATE OR REPLACE FUNCTION public.set_invoice_pdf_extractions_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_invoice_pdf_extractions_updated_at ON public.invoice_pdf_extractions;
CREATE TRIGGER trg_invoice_pdf_extractions_updated_at
  BEFORE UPDATE ON public.invoice_pdf_extractions
  FOR EACH ROW EXECUTE FUNCTION public.set_invoice_pdf_extractions_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- 3. apply_invoice_pdf_extraction RPC — atomic DELETE + INSERT
-- ═══════════════════════════════════════════════════════════════════════
--
-- Called by lib/inventory/pdf-extractor.ts after validation passes. The
-- atomic shape means re-extracting an invoice is safe — the placeholder
-- rows are removed in the same transaction as the new rows being added.
-- supplier_invoice_lines' unique constraint (business_id,
-- fortnox_invoice_number, row_number) is the safety net if anything else
-- races.

CREATE OR REPLACE FUNCTION public.apply_invoice_pdf_extraction(
  p_org_id                 UUID,
  p_business_id            UUID,
  p_supplier_fortnox_number TEXT,
  p_supplier_name_snapshot  TEXT,
  p_fortnox_invoice_number TEXT,
  p_invoice_date           DATE,
  p_rows                   JSONB           -- array of row objects from the extractor
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  inserted_count INTEGER;
BEGIN
  -- Wipe any existing rows for this invoice (placeholders + any
  -- previous extraction). Caller's responsibility to have validated
  -- the new rows before this call.
  DELETE FROM public.supplier_invoice_lines
   WHERE business_id            = p_business_id
     AND fortnox_invoice_number = p_fortnox_invoice_number;

  -- Insert the extracted rows. row_number is 1-based and sequential
  -- per the extractor's schema; we trust it but the unique index
  -- enforces it.
  INSERT INTO public.supplier_invoice_lines (
    org_id,
    business_id,
    supplier_fortnox_number,
    supplier_name_snapshot,
    fortnox_invoice_number,
    invoice_date,
    invoice_period_year,
    invoice_period_month,
    row_number,
    raw_description,
    article_number,
    quantity,
    unit,
    price_per_unit,
    total_excl_vat,
    vat_rate,
    account_number,
    match_status,
    source
  )
  SELECT
    p_org_id,
    p_business_id,
    p_supplier_fortnox_number,
    p_supplier_name_snapshot,
    p_fortnox_invoice_number,
    p_invoice_date,
    EXTRACT(YEAR  FROM p_invoice_date)::INTEGER,
    EXTRACT(MONTH FROM p_invoice_date)::INTEGER,
    (r->>'row_number')::INTEGER,
    COALESCE(r->>'description', ''),
    r->>'article_number',
    NULLIF(r->>'quantity',       '')::NUMERIC,
    r->>'unit',
    NULLIF(r->>'price_per_unit', '')::NUMERIC,
    COALESCE(NULLIF(r->>'total_excl_vat', '')::NUMERIC, 0),
    NULLIF(r->>'vat_rate', '')::NUMERIC,
    NULL,                                       -- account_number — unknown from PDF
    'needs_review',                             -- matcher will reclassify
    'pdf_extraction'
  FROM jsonb_array_elements(p_rows) AS r;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_invoice_pdf_extraction(
  UUID, UUID, TEXT, TEXT, TEXT, DATE, JSONB
) TO authenticated, service_role;
