-- ═══════════════════════════════════════════════════════════════════════
-- Vero PDF backlog cleanup (one-off, NOT a migration)
-- ═══════════════════════════════════════════════════════════════════════
--
-- Two narrow fixes for the residual at Vero invoice_pdf_extractions:
--
--   1. Eleven rows at status='pending' that already have extracted_rows
--      populated and total_extracted ≈ total_header. The original May 25
--      extraction succeeded but the status flag didn't flip. Cosmetic
--      fix: flip them to 'extracted' so the dashboard counts are honest.
--
--   2. Thirty-seven rows at status='failed' with
--      error_message='pdf_lookup_failed: http_401' (or http_429) from
--      May 25, when Vero's Fortnox integration was broken. The
--      integration is now back at status='connected' (last sync today).
--      Flip these back to 'pending' + clear error_message so the
--      extraction-sweeper cron re-picks them up.
--
-- ── Belt-and-braces guards ────────────────────────────────────────────
--
--   - Both UPDATEs scope by business_id explicitly (Vero only).
--   - Operation 1 requires rows_extracted > 0 (the cosmetic flip is
--     ONLY for rows that already have data).
--   - Operation 2 requires error_message contains 'pdf_lookup_failed:
--     http_4' (the auth-failure shape specifically; not other failures).
--
-- ── HOW TO RUN ────────────────────────────────────────────────────────
--
-- DRY by default (BEGIN…ROLLBACK). After V1/V2/V3 verification, change
-- ROLLBACK to COMMIT and re-run to persist.

BEGIN;

-- ── OP 1: cosmetic-pending → extracted ──────────────────────────────
SELECT '── OP 1: cosmetic-pending rows about to flip ──' AS section;
SELECT fortnox_invoice_number, rows_extracted, total_extracted, total_header, updated_at
FROM public.invoice_pdf_extractions
WHERE business_id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid
  AND status = 'pending'
  AND rows_extracted > 0
ORDER BY fortnox_invoice_number;
-- Expected: 11 rows (the cosmetic-pending set).

UPDATE public.invoice_pdf_extractions
SET status = 'extracted',
    updated_at = NOW()
WHERE business_id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid
  AND status = 'pending'
  AND rows_extracted > 0;

-- ── OP 2: token-auth-failed → pending (re-eligible) ─────────────────
SELECT '── OP 2: token-auth-failed rows about to flip ──' AS section;
SELECT fortnox_invoice_number, attempts, error_message, updated_at
FROM public.invoice_pdf_extractions
WHERE business_id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid
  AND status = 'failed'
  AND error_message ~* 'pdf_lookup_failed: (fc_)?http_4'
ORDER BY fortnox_invoice_number;
-- Expected: 37 rows (32 http_401 + 4 http_429 + 1 fc_http_429).

UPDATE public.invoice_pdf_extractions
SET status = 'pending',
    error_message = NULL,
    attempts = 0,        -- reset so the sweeper actually re-tries
    updated_at = NOW()
WHERE business_id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid
  AND status = 'failed'
  AND error_message ~* 'pdf_lookup_failed: (fc_)?http_4';

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════

SELECT '── V1 ── New status distribution at Vero ──' AS section;
SELECT status, COUNT(*) AS lines
FROM public.invoice_pdf_extractions
WHERE business_id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid
GROUP BY status
ORDER BY 2 DESC;
-- Expected: extracted ~554, no_pdf 440, needs_review 52, pending ~37, failed 0.

SELECT '── V2 ── Idempotency (re-applying would be a no-op) ──' AS section;
SELECT
  (SELECT COUNT(*) FROM public.invoice_pdf_extractions
   WHERE business_id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid
     AND status = 'pending' AND rows_extracted > 0) AS op1_remaining,
  (SELECT COUNT(*) FROM public.invoice_pdf_extractions
   WHERE business_id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid
     AND status = 'failed' AND error_message ~* 'pdf_lookup_failed: (fc_)?http_4') AS op2_remaining;
-- Expected: 0, 0.

SELECT '── V3 ── Sample of newly-pending invoices (will be picked up by the cron) ──' AS section;
SELECT fortnox_invoice_number, attempts, error_message, updated_at
FROM public.invoice_pdf_extractions
WHERE business_id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid
  AND status = 'pending'
  AND rows_extracted IS NULL
ORDER BY fortnox_invoice_number
LIMIT 20;

-- ═══════════════════════════════════════════════════════════════════════
-- DRY RUN — discard everything. To APPLY: change ROLLBACK to COMMIT.
-- ═══════════════════════════════════════════════════════════════════════
ROLLBACK;
