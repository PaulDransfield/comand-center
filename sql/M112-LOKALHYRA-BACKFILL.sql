-- ═══════════════════════════════════════════════════════════════════════
-- M112 — lokalhyra not_inventory backfill (DRY + APPLY)
-- ═══════════════════════════════════════════════════════════════════════
--
-- Adds three compound-word arms to the description-rule veto so premises-
-- rent lines (Chicce landlord "Behrn, Per Johan Gustav" invoices) stop
-- landing in the catalogue review queue:
--
--   lokalhyra
--   hyra<space>lokal     (matches "Förråd – Hyra lokal", "Restaurang/café – Hyra lokal")
--   lokal<space>hyra     (matches reversed form)
--
-- ── ANCHORING DISCIPLINE ──────────────────────────────────────────────
--
-- These three arms are UNANCHORED — same discipline as the existing
-- pantersättning / öresavrundning / inkassoarvode arms. Justification
-- (both-directions dry-run 2026-06-01):
--
--   A. Catches 65/65 Chicce rent lines (all from Behrn, Per Johan
--      Gustav landlord; descriptions: "<location> – Hyra lokal" + a few
--      "(varav N kr indextillägg)" variants). 0 at Vero/Rosali.
--
--   B. 0 false positives on product names. The Loka-brand drink
--      products at Vero ("Lokal Hallon/Rabarber 33cl Burk") contain
--      "lokal" as a standalone word but NOT the compound `lokal\s+hyra`
--      or `hyra\s+lokal`. The compound is the discriminator.
--
-- The owner's exact framing (2026-06-01): "Loka is a drink brand and
-- lokal hyra is rent — try to understand the words before matching
-- them." This rule encodes that distinction structurally.
--
-- ── KEEP IN SYNC ──────────────────────────────────────────────────────
--
-- Mirror of the JS pattern in lib/inventory/description-rules.ts.
-- If you update one, update the other AND re-run the dry-run script
-- at scripts/diag-lokalhyra-rule-dryrun.mjs.
--
-- ── IDEMPOTENT ────────────────────────────────────────────────────────
--
-- WHERE match_status != 'not_inventory' AND product_alias_id IS NULL.
-- Re-running is a no-op. Already-flipped lines untouched.
--
-- ── HOW TO RUN ────────────────────────────────────────────────────────
--
-- 1. Paste into Supabase SQL Editor. The file starts BEGIN ends ROLLBACK
--    for DRY. Run as-is to verify V1-V4 counts match dry-run predictions.
--
-- 2. Once verified, change the trailing `ROLLBACK;` to `COMMIT;` and
--    re-run to actually persist.

BEGIN;

-- ── PRE-WRITE SANITY: confirm Postgres regex matches the JS dry-run ──
SELECT '── PRE-SANITY: per-business expected moves ──' AS section;
SELECT
  CASE business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
    WHEN '97187ef3-b816-4c41-9230-7551430784a7'::uuid THEN 'Rosali'
  END AS business,
  COUNT(*) AS would_flip
FROM public.supplier_invoice_lines
WHERE match_status = 'needs_review'
  AND product_alias_id IS NULL
  AND raw_description ~* '(lokalhyra|hyra\s+lokal|lokal\s+hyra)'
GROUP BY business_id
ORDER BY 1;
-- Expected: Chicce 65, Vero 0, Rosali 0 (per dry-run 2026-06-01).

-- ── OPERATION — Flip eligible lines ───────────────────────────────────
--
-- Same belt-and-braces guards as p20-fix2:
--   - product_alias_id IS NULL: never touch matched-with-alias lines
--   - match_status != 'not_inventory': idempotency
--
-- The Postgres regex MUST be byte-identical to PRE-SANITY above (and to
-- the JS pattern in lib/inventory/description-rules.ts).

UPDATE public.supplier_invoice_lines
SET match_status = 'not_inventory'
WHERE match_status = 'needs_review'
  AND product_alias_id IS NULL
  AND raw_description ~* '(lokalhyra|hyra\s+lokal|lokal\s+hyra)';

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════

SELECT '── V1 ── Lines now at not_inventory matching new pattern (per business) ──' AS section;
SELECT
  CASE business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
    WHEN '97187ef3-b816-4c41-9230-7551430784a7'::uuid THEN 'Rosali'
  END AS business,
  COUNT(*) AS lines_at_not_inventory_now
FROM public.supplier_invoice_lines
WHERE match_status = 'not_inventory'
  AND raw_description ~* '(lokalhyra|hyra\s+lokal|lokal\s+hyra)'
GROUP BY business_id
ORDER BY 1;

SELECT '── V2 ── IDEMPOTENCY: re-applying would be a no-op (expect 0) ──' AS section;
SELECT
  CASE business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
    WHEN '97187ef3-b816-4c41-9230-7551430784a7'::uuid THEN 'Rosali'
  END AS business,
  COUNT(*) AS lines_still_needs_review_matching_pattern
FROM public.supplier_invoice_lines
WHERE match_status = 'needs_review'
  AND product_alias_id IS NULL
  AND raw_description ~* '(lokalhyra|hyra\s+lokal|lokal\s+hyra)'
GROUP BY business_id
ORDER BY 1;
-- Expected: no rows returned (every match was flipped).

SELECT '── V3 ── REGRESSION GUARD: no matched line touched ──' AS section;
-- The UPDATE filter `product_alias_id IS NULL` makes this impossible,
-- but verify by sampling.
SELECT
  COUNT(*) AS matched_lines_now_not_inventory_with_alias
FROM public.supplier_invoice_lines
WHERE match_status = 'not_inventory'
  AND product_alias_id IS NOT NULL
  AND raw_description ~* '(lokalhyra|hyra\s+lokal|lokal\s+hyra)';
-- Expected: 0.

SELECT '── V4 ── Sample flipped descriptions (sanity scan) ──' AS section;
SELECT business_id, raw_description, total_excl_vat, supplier_name_snapshot
FROM public.supplier_invoice_lines
WHERE match_status = 'not_inventory'
  AND raw_description ~* '(lokalhyra|hyra\s+lokal|lokal\s+hyra)'
ORDER BY business_id, raw_description
LIMIT 20;

-- ═══════════════════════════════════════════════════════════════════════
-- DRY RUN — discard everything. To APPLY: change ROLLBACK to COMMIT.
-- ═══════════════════════════════════════════════════════════════════════
ROLLBACK;
