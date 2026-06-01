-- price-per-unit-backfill-APPLY.sql
--
-- One-time backfill. Sets price_per_unit = total_excl_vat / quantity on
-- supplier_invoice_lines rows where the PDF-extracted price_per_unit
-- disagrees with the line-validated total/qty by >5%.
--
-- Read price-per-unit-backfill-DRY.sql first; sanity-check the sample
-- output; then run this in Supabase SQL Editor.
--
-- Why this is safe:
--   - Filter to source='pdf_extraction' — never touches owner_correction
--     or fortnox_row data.
--   - Filter to qty > 0 AND total != 0 — must have both inputs.
--   - Threshold 5% drift — well above floating noise, well below any
--     plausible legitimate variation between ppu and total/qty.
--   - Update is idempotent: re-running won't shift values further because
--     after the UPDATE, price_per_unit IS total/qty so drift = 0.
--   - No schema change, no constraint touched, fully reversible (we have
--     daily backups + PITR; if needed, restore from snapshot).
--
-- Out-of-scope (NOT touched):
--   - source='fortnox_row' rows where only one of ppu/total is populated —
--     they don't have both fields needed for derivation; the engine's
--     read-time fallback handles them.
--   - The wrong-extraction itself in `invoice_pdf_extractions` — the
--     extracted_rows_json keeps the original (wrong) ppu for audit. Only
--     the queryable supplier_invoice_lines row is corrected.

BEGIN;

WITH targets AS (
  SELECT id, total_excl_vat / quantity AS derived_ppu
  FROM supplier_invoice_lines
  WHERE source = 'pdf_extraction'
    AND quantity > 0
    AND total_excl_vat IS NOT NULL
    AND total_excl_vat <> 0
    AND price_per_unit IS NOT NULL
    AND ABS(total_excl_vat / quantity - price_per_unit)
      / GREATEST(ABS(price_per_unit), ABS(total_excl_vat / quantity), 0.01) > 0.05
)
UPDATE supplier_invoice_lines AS s
SET price_per_unit = t.derived_ppu
FROM targets t
WHERE s.id = t.id;

-- Show how many rows landed
SELECT 'updated row count' AS label,
       (SELECT COUNT(*)
        FROM supplier_invoice_lines
        WHERE source = 'pdf_extraction'
          AND quantity > 0
          AND total_excl_vat IS NOT NULL
          AND total_excl_vat <> 0
          AND price_per_unit IS NOT NULL
          AND ABS(total_excl_vat / quantity - price_per_unit)
            / GREATEST(ABS(price_per_unit), ABS(total_excl_vat / quantity), 0.01) > 0.05
       ) AS remaining_drift_rows;

-- Spot-check: Pizza sauce Classica (the originating trigger)
SELECT
  fortnox_invoice_number AS inv,
  raw_description,
  quantity AS qty,
  ROUND(price_per_unit::numeric, 2) AS ppu_after,
  ROUND(total_excl_vat::numeric, 2) AS line_total,
  ROUND((price_per_unit * quantity)::numeric, 2) AS ppu_x_qty_should_equal_total
FROM supplier_invoice_lines
WHERE business_id = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
  AND raw_description ILIKE '%Pizza sauce Classica%';

-- Commit if the count looks right and Pizza sauce shows ~155.61.
COMMIT;
