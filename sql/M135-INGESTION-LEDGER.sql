-- sql/M135-INGESTION-LEDGER.sql
--
-- Phase 1 of INGESTION-PIPELINE-RELIABILITY-PLAN.md (2026-06-06).
--
-- Establish the contract that every byte ingested from an external
-- source carries: what was expected, what arrived, when, by whom.
-- Triggered by the file_id-silently-null incident — 99% of supplier
-- invoices were missing PDF metadata because the sync skipped the
-- file-connections endpoint, and nothing alarmed because there was
-- no completeness contract.
--
-- This migration ships:
--   1. ingestion_log — single global audit table for every external
--      API call we make.
--   2. fortnox_supplier_invoices.ingestion_status + ingestion_meta —
--      row-level completeness flag. Pattern reusable on any future
--      ingestion target via the same column pair.
--   3. Truthful backfill — every existing row gets
--      ingestion_status='header_only' (we never fetched file_id) so
--      the read side can immediately distinguish "not yet checked"
--      from "Fortnox really has nothing".
--
-- Idempotent throughout — safe to re-run.

-- ── 1. ingestion_log — single global table ───────────────────────────
-- Why global (not per-source): cross-source coverage queries are the
-- expected dashboard read pattern once Phase 5 ships. Per-source
-- tables would force UNION ALL at every reader.
CREATE TABLE IF NOT EXISTS ingestion_log (
  id                bigserial   PRIMARY KEY,
  source            text        NOT NULL,                            -- 'fortnox' / 'personalkollen' / 'stripe' / etc.
  resource          text        NOT NULL,                            -- 'supplier_invoices' / 'staff_logs' / etc.
  business_id       uuid        REFERENCES businesses(id) ON DELETE CASCADE,
  org_id            uuid        REFERENCES organisations(id) ON DELETE CASCADE,
  operation         text        NOT NULL,                            -- 'list' / 'detail' / 'file_connections' / 'upsert'
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  -- Field-level coverage. expected_fields is the set of fields the
  -- caller declared as required for completeness; populated_fields is
  -- the subset that actually came back non-null. status is computed
  -- from these by the helper at close time.
  expected_fields   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  populated_fields  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  rows_processed    integer     NOT NULL DEFAULT 0,
  status            text        NOT NULL DEFAULT 'started',          -- started / complete / partial / failed
  error             text,
  context           jsonb        DEFAULT '{}'::jsonb,                 -- callsite extras: cursor, HTTP status, retry count, etc.

  CONSTRAINT ingestion_log_status_chk
    CHECK (status IN ('started', 'complete', 'partial', 'failed'))
);

CREATE INDEX IF NOT EXISTS ingestion_log_source_resource_idx
  ON ingestion_log (source, resource, started_at DESC);

CREATE INDEX IF NOT EXISTS ingestion_log_business_idx
  ON ingestion_log (business_id, started_at DESC) WHERE business_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ingestion_log_status_idx
  ON ingestion_log (status, started_at DESC) WHERE status IN ('failed', 'partial');

-- ── 2. Row-level completeness on fortnox_supplier_invoices ──────────
-- First ingestion target to adopt the pattern. Future tables follow
-- the same shape: ingestion_status text + ingestion_meta jsonb.
ALTER TABLE fortnox_supplier_invoices
  ADD COLUMN IF NOT EXISTS ingestion_status text NOT NULL DEFAULT 'header_only',
  ADD COLUMN IF NOT EXISTS ingestion_meta   jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fortnox_supplier_invoices_ingestion_status_chk'
  ) THEN
    ALTER TABLE fortnox_supplier_invoices
      ADD CONSTRAINT fortnox_supplier_invoices_ingestion_status_chk
      CHECK (ingestion_status IN ('complete', 'partial', 'header_only', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS fortnox_supplier_invoices_ingestion_status_idx
  ON fortnox_supplier_invoices (ingestion_status) WHERE ingestion_status <> 'complete';

-- ── 3. Truthful backfill ────────────────────────────────────────────
-- Every existing row defaults to 'header_only' via the column default
-- above — that's already truthful since the sync never fetched
-- file_id. But rows that DID pick up a file_id via the PDF extraction
-- worker (Vero backlog) are actually complete; flip them.
UPDATE fortnox_supplier_invoices
SET    ingestion_status = 'complete',
       ingestion_meta   = jsonb_build_object(
         'source_path',   'pdf_extraction_worker',
         'backfilled_at', now()
       )
WHERE  ingestion_status = 'header_only'
  AND  file_id IS NOT NULL;

-- ── 4. Verification (uncomment after apply) ─────────────────────────
-- SELECT ingestion_status, count(*) FROM fortnox_supplier_invoices GROUP BY 1 ORDER BY 1;
-- Expected after this migration: most 'header_only', a small handful 'complete'.
-- Phase 2 will flip header_only → complete as the sync starts fetching file_id properly.
