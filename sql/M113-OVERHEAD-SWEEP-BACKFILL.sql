-- ═══════════════════════════════════════════════════════════════════════
-- M113 — Overhead sweep backfill (DRY + APPLY)
-- ═══════════════════════════════════════════════════════════════════════
--
-- Six additional description-rule arms, surfaced by the residual-queue
-- analysis at Chicce + Vero (scripts/diag-overhead-sweep.mjs +
-- scripts/diag-needs-review-suppliers.mjs). Each arm passed a both-
-- directions dry-run before shipping — A catches the noise, B is empty
-- on product names.
--
-- ── ARMS ──────────────────────────────────────────────────────────────
--
--   öres.{0,3}och\s+kron        ← "Öres- och kronutjämning" (Kungsholmens)
--   brand(släckar|\s+ansulex)   ← Brandsläckarservice, Brand ansulexservice
--                                  (Tingstad fire-extinguisher annual service)
--   förpackningsavgift           ← "Förpackningsavgift" (PAC-PRODUCTION)
--   försenings(ersättning|avgift) ← "Förseningsersättning" (Martin Servera
--                                    delivery comp) — forward-defensive
--   ^engångsemballage\M          ← "ENGÅNGSEMBALLAGE KOLLI/STYCK" (Spendrups)
--   ^europapall(e)?\M            ← "EUROPAPALLE 4 VEJS" (Carlsberg) —
--                                   sibling to existing ^eur[-\s]?pall
--
-- ── ANCHORING DISCIPLINE ──────────────────────────────────────────────
--
-- Four arms unanchored (öres-och-kron, brand-, förpacknings-, försenings-)
-- because the compound or token is specific enough not to appear in any
-- real product name. Two arms ^-anchored (engångsemballage, europapall)
-- because the prefix form is the noise signature and an unanchored match
-- could catch real packaging products.
--
-- ── DRY-RUN-PREDICTED FIGURES (per 2026-06-01) ─────────────────────────
--
--   Chicce:  öres-och-kron 7  +  brand- 2  +  ^engångsemballage 2
--            +  ^europapall 5  =  16 lines
--   Vero:    förpackningsavgift 2  +  ^engångsemballage 1
--            +  ^europapall 1  =  4 lines
--   Total flipped ~20.
--
-- ── KEEP IN SYNC ──────────────────────────────────────────────────────
--
-- Mirror of the JS pattern in lib/inventory/description-rules.ts.
-- If you update one, update the other AND re-run the dry-run script.
--
-- ── HOW TO RUN ────────────────────────────────────────────────────────
--
-- 1. Paste into Supabase SQL Editor. The file starts BEGIN ends ROLLBACK
--    for DRY. Run as-is to verify V1-V4 counts match dry-run predictions.
--
-- 2. Once verified, change the trailing `ROLLBACK;` to `COMMIT;` and
--    re-run to persist.

BEGIN;

-- ── PRE-WRITE SANITY ───────────────────────────────────────────────────
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
  AND raw_description ~* '(öres.{0,3}och\s+kron|brand(släckar|\s+ansulex)|förpackningsavgift|försenings(ersättning|avgift)|^eng[åa]ngsemballage\M|^europapall(e)?\M)'
GROUP BY business_id
ORDER BY 1;
-- Expected: Chicce ~16, Vero ~4 (per dry-run 2026-06-01).

-- ── OPERATION — Flip eligible lines ───────────────────────────────────
UPDATE public.supplier_invoice_lines
SET match_status = 'not_inventory'
WHERE match_status = 'needs_review'
  AND product_alias_id IS NULL
  AND raw_description ~* '(öres.{0,3}och\s+kron|brand(släckar|\s+ansulex)|förpackningsavgift|försenings(ersättning|avgift)|^eng[åa]ngsemballage\M|^europapall(e)?\M)';

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════

SELECT '── V1 ── Lines now at not_inventory matching new arms (per business) ──' AS section;
SELECT
  CASE business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
    WHEN '97187ef3-b816-4c41-9230-7551430784a7'::uuid THEN 'Rosali'
  END AS business,
  COUNT(*) AS lines_at_not_inventory_now
FROM public.supplier_invoice_lines
WHERE match_status = 'not_inventory'
  AND raw_description ~* '(öres.{0,3}och\s+kron|brand(släckar|\s+ansulex)|förpackningsavgift|försenings(ersättning|avgift)|^eng[åa]ngsemballage\M|^europapall(e)?\M)'
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
  AND raw_description ~* '(öres.{0,3}och\s+kron|brand(släckar|\s+ansulex)|förpackningsavgift|försenings(ersättning|avgift)|^eng[åa]ngsemballage\M|^europapall(e)?\M)'
GROUP BY business_id
ORDER BY 1;
-- Expected: no rows.

SELECT '── V3 ── REGRESSION GUARD: no matched line touched ──' AS section;
SELECT
  COUNT(*) AS matched_lines_now_not_inventory_with_alias
FROM public.supplier_invoice_lines
WHERE match_status = 'not_inventory'
  AND product_alias_id IS NOT NULL
  AND raw_description ~* '(öres.{0,3}och\s+kron|brand(släckar|\s+ansulex)|förpackningsavgift|försenings(ersättning|avgift)|^eng[åa]ngsemballage\M|^europapall(e)?\M)';
-- Expected: 0.

SELECT '── V4 ── Sample flipped descriptions per arm (sanity scan) ──' AS section;
SELECT
  CASE business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
  END AS business,
  raw_description,
  total_excl_vat,
  supplier_name_snapshot
FROM public.supplier_invoice_lines
WHERE match_status = 'not_inventory'
  AND raw_description ~* '(öres.{0,3}och\s+kron|brand(släckar|\s+ansulex)|förpackningsavgift|försenings(ersättning|avgift)|^eng[åa]ngsemballage\M|^europapall(e)?\M)'
ORDER BY business_id, raw_description
LIMIT 30;

-- ═══════════════════════════════════════════════════════════════════════
-- DRY RUN — discard everything. To APPLY: change ROLLBACK to COMMIT.
-- ═══════════════════════════════════════════════════════════════════════
ROLLBACK;
