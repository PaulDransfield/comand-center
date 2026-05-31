-- ═══════════════════════════════════════════════════════════════════════
-- P2.0 Reliability Paydown Ticket 1 — Backfill voucher_series + voucher_number
-- columns on fortnox_supplier_invoices from raw_data.Vouchers JSONB.
-- DRY RUN.
-- ═══════════════════════════════════════════════════════════════════════
--
-- Paste into Supabase SQL Editor and Run. Wrapper is BEGIN…ROLLBACK so
-- every write auto-discards. Verification + spot-check SELECTs run inside
-- the transaction so the owner can confirm extraction correctness before
-- pasting APPLY.
--
-- ── LOAD-BEARING FILTER ──────────────────────────────────────────────
--
-- v->>'ReferenceType' = 'SUPPLIERINVOICE'  — pulls the booking voucher
-- ref, not the SUPPLIERPAYMENT ref (each supplier invoice has both).
-- If a caller grabbed the payment voucher by mistake, downstream joins
-- would silently resolve to the wrong voucher (which has bank/AP-credit
-- rows, not expense rows).
--
-- MIRRORS lib/fortnox/extract-voucher-ref.ts:extractSupplierInvoiceVoucher
-- The cron writer (app/api/cron/fortnox-supplier-sync/route.ts) uses the
-- TS helper for future writes. This SQL uses the same filter for the
-- one-time backfill. Drift between the two is the subtle bug the shared-
-- logic discipline exists to prevent — if you change the filter here,
-- change it in the TS helper too.
--
-- ── DRY-RUN-PREDICTED FIGURES (from JS characterise 2026-05-31) ─────
--
--   Chicce: 725 of 748 rows backfillable (23 unrecoverable, no Vouchers)
--   Vero:   995 of 1,012 rows backfillable (17 unrecoverable)
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────
--
-- WHERE voucher_series IS NULL — re-running is a no-op. Already-populated
-- rows (whether from this backfill or future cron writes) untouched.
-- Unrecoverable rows (no SUPPLIERINVOICE ref in JSONB) stay NULL —
-- never coerced to empty-string sentinel.

BEGIN;

-- ── OPERATION — backfill columns from JSONB ──
--
-- Subquery-per-column extracts the FIRST SUPPLIERINVOICE voucher ref.
-- LIMIT 1 matches the TS helper's `vouchers.find(...)` semantics.
-- Idempotency guard: only touches rows where voucher_series IS NULL.

UPDATE public.fortnox_supplier_invoices fsi
SET
  voucher_series = (
    SELECT (v->>'Series')::text
    FROM jsonb_array_elements(fsi.raw_data->'Vouchers') v
    WHERE v->>'ReferenceType' = 'SUPPLIERINVOICE'
    LIMIT 1
  ),
  voucher_number = (
    SELECT (v->>'Number')::int
    FROM jsonb_array_elements(fsi.raw_data->'Vouchers') v
    WHERE v->>'ReferenceType' = 'SUPPLIERINVOICE'
    LIMIT 1
  )
WHERE fsi.business_id IN (
        '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid,
        '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid
      )
  AND fsi.voucher_series IS NULL
  AND fsi.raw_data ? 'Vouchers'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(fsi.raw_data->'Vouchers') v
    WHERE v->>'ReferenceType' = 'SUPPLIERINVOICE'
  );

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION + SPOT-CHECK
-- ═══════════════════════════════════════════════════════════════════════

-- V1: per-business backfill counts (expect Chicce 725, Vero 995)
SELECT * FROM (
  SELECT 1 AS k, 'V1 Chicce voucher_series now populated (expect 725)' AS metric,
    (SELECT COUNT(*)::text FROM fortnox_supplier_invoices
     WHERE business_id = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid
       AND voucher_series IS NOT NULL) AS v
  UNION ALL SELECT 2, 'V1 Vero voucher_series now populated (expect 995)',
    (SELECT COUNT(*)::text FROM fortnox_supplier_invoices
     WHERE business_id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid
       AND voucher_series IS NOT NULL)
  UNION ALL SELECT 3, 'V1 Chicce voucher_series still NULL (expect 23 unrecoverable)',
    (SELECT COUNT(*)::text FROM fortnox_supplier_invoices
     WHERE business_id = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid
       AND voucher_series IS NULL)
  UNION ALL SELECT 4, 'V1 Vero voucher_series still NULL (expect 17 unrecoverable)',
    (SELECT COUNT(*)::text FROM fortnox_supplier_invoices
     WHERE business_id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid
       AND voucher_series IS NULL)
) summary ORDER BY k;

-- V2: SPOT-CHECK 5 backfilled pairs against their source JSONB.
--     Owner eyeballs: does the extracted (series, number) match the
--     SUPPLIERINVOICE entry in the raw_data.Vouchers array (NOT the
--     SUPPLIERPAYMENT one)?
SELECT
  fsi.given_number,
  fsi.voucher_series              AS extracted_series,
  fsi.voucher_number              AS extracted_number,
  fsi.raw_data->'Vouchers'        AS raw_vouchers_jsonb
FROM public.fortnox_supplier_invoices fsi
WHERE fsi.business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
  AND fsi.voucher_series IS NOT NULL
ORDER BY random()
LIMIT 5;

-- V3: SPOT-CHECK confirm extracted series matches SUPPLIERINVOICE refs only
--     (i.e. no rows where the extracted series exists in JSONB but only as
--     a SUPPLIERPAYMENT). Expect 0 — any non-zero is the load-bearing bug.
SELECT
  'V3 rows where extracted ref is NOT a SUPPLIERINVOICE in JSONB (expect 0 — load-bearing)' AS check,
  COUNT(*) AS count
FROM public.fortnox_supplier_invoices fsi
WHERE fsi.business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
  AND fsi.voucher_series IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(fsi.raw_data->'Vouchers') v
    WHERE v->>'ReferenceType' = 'SUPPLIERINVOICE'
      AND (v->>'Series')::text = fsi.voucher_series
      AND (v->>'Number')::int  = fsi.voucher_number
  );

-- V4: idempotency — re-running would touch 0 rows because the WHERE
--     clause filters voucher_series IS NULL AND a SUPPLIERINVOICE ref
--     exists. Confirm by counting matching rows POST-update.
SELECT
  'V4 idempotency: rows still backfillable (expect 0)' AS check,
  COUNT(*) AS count
FROM public.fortnox_supplier_invoices fsi
WHERE fsi.business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
  AND fsi.voucher_series IS NULL
  AND fsi.raw_data ? 'Vouchers'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(fsi.raw_data->'Vouchers') v
    WHERE v->>'ReferenceType' = 'SUPPLIERINVOICE'
  );

ROLLBACK;
