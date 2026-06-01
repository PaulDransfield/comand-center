-- price-per-unit-backfill-DRY.sql
--
-- READ-ONLY preview. Shows what the APPLY would change.
--
-- Context: the PDF extractor sometimes mis-records `price_per_unit` on
-- supplier_invoice_lines — writes the line total there (so ppu == total),
-- or writes a per-bottle figure when the line is per-case, or picks up an
-- unrelated number from the invoice. `total_excl_vat / quantity` is the
-- paid-per-unit ground truth (the line total is validated against the
-- invoice header at extraction time, so it's hard to get wrong).
--
-- Scope filters:
--   - source = 'pdf_extraction'  (don't touch fortnox_row or owner_correction)
--   - quantity > 0 AND total_excl_vat != 0  (need both to derive)
--   - abs(price_per_unit - total/qty) / greatest(|ppu|, |total/qty|) > 0.05  (5% drift)
-- Threshold of 5% avoids touching legitimately rounded prices; everything
-- above is a model-extraction bug.
--
-- The engine fix in `lib/inventory/recipe-cost.ts` already derives at read
-- time for the recipe-cost surface. This DB backfill is the durable fix
-- that makes inventory items page, variance, and any future reader see the
-- corrected value without each having to re-implement the derivation.

-- ─── Section 1: Total scope ───
SELECT
  business_id,
  COUNT(*) AS lines_to_update,
  ROUND(SUM(ABS(total_excl_vat / quantity - price_per_unit))::numeric, 0) AS total_abs_price_shift_sek
FROM supplier_invoice_lines
WHERE source = 'pdf_extraction'
  AND quantity > 0
  AND total_excl_vat IS NOT NULL
  AND total_excl_vat <> 0
  AND price_per_unit IS NOT NULL
  AND ABS(total_excl_vat / quantity - price_per_unit)
    / GREATEST(ABS(price_per_unit), ABS(total_excl_vat / quantity), 0.01) > 0.05
GROUP BY business_id
ORDER BY lines_to_update DESC;

-- ─── Section 2: Drift severity buckets ───
SELECT
  business_id,
  CASE
    WHEN drift_pct > 5.0 THEN 'severe (>500%)'
    WHEN drift_pct > 1.0 THEN 'large (>100%)'
    WHEN drift_pct > 0.5 THEN 'moderate (50-100%)'
    WHEN drift_pct > 0.2 THEN 'small (20-50%)'
    ELSE 'minor (5-20%)'
  END AS severity,
  COUNT(*) AS lines
FROM (
  SELECT
    business_id,
    ABS(total_excl_vat / quantity - price_per_unit)
      / GREATEST(ABS(price_per_unit), ABS(total_excl_vat / quantity), 0.01) AS drift_pct
  FROM supplier_invoice_lines
  WHERE source = 'pdf_extraction'
    AND quantity > 0
    AND total_excl_vat IS NOT NULL
    AND total_excl_vat <> 0
    AND price_per_unit IS NOT NULL
    AND ABS(total_excl_vat / quantity - price_per_unit)
      / GREATEST(ABS(price_per_unit), ABS(total_excl_vat / quantity), 0.01) > 0.05
) t
GROUP BY business_id, severity
ORDER BY business_id, severity DESC;

-- ─── Section 3: Sample 20 of the most-impactful changes per business ───
-- Sorted by the absolute SEK shift (per-unit-price delta), so you see the
-- ones where the wrong number is wildly off.
SELECT
  business_id,
  fortnox_invoice_number AS inv,
  LEFT(supplier_name_snapshot, 24) AS supplier,
  LEFT(raw_description, 50) AS description,
  quantity AS qty,
  ROUND(price_per_unit::numeric, 2) AS ppu_now,
  ROUND((total_excl_vat / quantity)::numeric, 2) AS ppu_derived,
  ROUND(total_excl_vat::numeric, 2) AS line_total,
  ROUND((ABS(total_excl_vat / quantity - price_per_unit)
    / GREATEST(ABS(price_per_unit), ABS(total_excl_vat / quantity), 0.01) * 100)::numeric, 0) AS drift_pct
FROM supplier_invoice_lines
WHERE source = 'pdf_extraction'
  AND quantity > 0
  AND total_excl_vat IS NOT NULL
  AND total_excl_vat <> 0
  AND price_per_unit IS NOT NULL
  AND ABS(total_excl_vat / quantity - price_per_unit)
    / GREATEST(ABS(price_per_unit), ABS(total_excl_vat / quantity), 0.01) > 0.05
ORDER BY business_id, ABS(total_excl_vat / quantity - price_per_unit) DESC
LIMIT 40;

-- ─── Section 4: Spot-check Pizza sauce Classica (the originating trigger) ───
SELECT
  fortnox_invoice_number AS inv,
  raw_description,
  quantity AS qty,
  ROUND(price_per_unit::numeric, 2) AS ppu_now,
  ROUND((total_excl_vat / quantity)::numeric, 2) AS ppu_derived,
  ROUND(total_excl_vat::numeric, 2) AS line_total
FROM supplier_invoice_lines
WHERE business_id = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
  AND raw_description ILIKE '%Pizza sauce Classica%';

-- After running: review the samples for any that look "right as ppu" and
-- "wrong as derived" — those would be the legitimate cases we'd be over-
-- writing (none expected, but the eyeball is the gate). Then run the
-- APPLY in a separate query.
