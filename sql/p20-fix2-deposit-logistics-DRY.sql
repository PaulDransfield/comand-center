-- ═══════════════════════════════════════════════════════════════════════
-- P2.0 Fix 2 — Deposit/logistics description rule cleanup — DRY RUN
-- ═══════════════════════════════════════════════════════════════════════
--
-- Paste into Supabase SQL Editor and Run. Wrapper is BEGIN…ROLLBACK so
-- every UPDATE auto-discards. Use to confirm V1–V4 verification counts
-- against dry-run predictions, then paste the APPLY twin (trailing COMMIT).
--
-- ── WHAT THIS DOES ────────────────────────────────────────────────────
--
-- Flips needs_review lines to not_inventory where raw_description matches
-- the extended description rule (existing rebate guard + new deposit /
-- logistics arms). Mirrors the P2.0 Op 2 pattern, simplified because:
--   - No matched-with-alias lines are affected (Direction-B check ran
--     clean over 10,579 matched lines — 0 false positives)
--   - So no alias clear, no outcome rows, no demotion RPC calls needed
--   - Just a status flip
--
-- Pattern is ANCHORED per arm (^token\M) — the discipline learned from
-- the original ^pant fix. Mid-string tokens on real product descriptions
-- (e.g. "Coca Cola 33CL, Varav pant per enhet…") MUST NOT be caught.
--
-- ── DRY-RUN-PREDICTED FIGURES (from JS dry-run 2026-05-31) ────────────
--
--   Flipped to not_inventory:   Chicce ~205    Vero ~354    Total ~559
--
-- Per-arm Direction-A catches (cross-business):
--   pant\M (existing — re-elevated stragglers):  384 lines
--   pantgrön (PANTGRÖN Retur):                    33
--   eur-pall (EUR-PALL GODKÄND):                 147
--   plastpall (PLASTPALL SRS 1/2):                76
--   pallet (PALLET HALF WOODEN):                   9
--   halvpall (Trädgårdshallen):                   64
--   engångspall (Trädgårdshallen):                56
--   kolli (Trädgårdshallen):                      48
--   pba retur (PBA RETURLÅDA):                    27
--   srs retur|back (SRS RETURBACK):              204
--   retur srs (Retur SRS Back):                   10
--   distribution (Distribution Chicce/…):         34
--   leveransavgift:                                8
--   plockavgift:                                  96
--   frakt:                                         6
--   miljörabatt:                                   3
--
-- ── IDEMPOTENT ────────────────────────────────────────────────────────
--
-- WHERE match_status != 'not_inventory' AND product_alias_id IS NULL.
-- Re-running is a no-op. Already-flipped lines untouched.

BEGIN;

-- ── PRE-WRITE SANITY: confirm Postgres regex matches the JS dry-run ──
SELECT '── PRE-SANITY: per-business expected moves ──' AS section;
SELECT
  CASE business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
  END AS business,
  COUNT(*) AS would_flip
FROM public.supplier_invoice_lines
WHERE business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
  AND match_status = 'needs_review'
  AND product_alias_id IS NULL
  AND raw_description ~* '(avtalsrabatt|^rabatt|^pant\M|pantersättning|öresavrundning|faktureringsavg|inkassoarvode|påminnelseavg|^pantgr[öo]n\M|^eur[-\s]?pall\M|^plastpall\M|^pallet\M|^halvpall\M|^eng[åa]ngspall\M|^kolli\M|^pba\s+retur|^srs\s+(retur|back)|^retur\s+srs|^distribution\s+|^leveransavgift\M|^plockavgift\M|^frakt\M|^milj[öo]rabatt\M)'
GROUP BY business_id
ORDER BY 1;

-- ── OPERATION — Flip eligible lines ───────────────────────────────────
--
-- Belt-and-braces guards:
--   - product_alias_id IS NULL: never touch matched-with-alias lines
--     (Direction-B check confirmed 0 false positives; this is defense
--     in depth in case of race)
--   - match_status != 'not_inventory': idempotency
--   - business scope pinned: only Chicce + Vero
--
-- The Postgres regex MUST be byte-identical to PRE-SANITY above (and to
-- the JS-side pattern in scripts/diag-gate0-precedence-deposit-dryrun.mjs)
-- or the verification counts diverge from predictions.

UPDATE public.supplier_invoice_lines
SET match_status = 'not_inventory'
WHERE business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
  AND match_status = 'needs_review'
  AND product_alias_id IS NULL
  AND raw_description ~* '(avtalsrabatt|^rabatt|^pant\M|pantersättning|öresavrundning|faktureringsavg|inkassoarvode|påminnelseavg|^pantgr[öo]n\M|^eur[-\s]?pall\M|^plastpall\M|^pallet\M|^halvpall\M|^eng[åa]ngspall\M|^kolli\M|^pba\s+retur|^srs\s+(retur|back)|^retur\s+srs|^distribution\s+|^leveransavgift\M|^plockavgift\M|^frakt\M|^milj[öo]rabatt\M)';

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════

SELECT '── V1 ── Lines now at not_inventory matching new pattern (per business) ──' AS section;
SELECT
  CASE business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
  END AS business,
  COUNT(*) AS lines_at_not_inventory_now
FROM public.supplier_invoice_lines
WHERE business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
  AND match_status = 'not_inventory'
  AND raw_description ~* '(avtalsrabatt|^rabatt|^pant\M|pantersättning|öresavrundning|faktureringsavg|inkassoarvode|påminnelseavg|^pantgr[öo]n\M|^eur[-\s]?pall\M|^plastpall\M|^pallet\M|^halvpall\M|^eng[åa]ngspall\M|^kolli\M|^pba\s+retur|^srs\s+(retur|back)|^retur\s+srs|^distribution\s+|^leveransavgift\M|^plockavgift\M|^frakt\M|^milj[öo]rabatt\M)'
GROUP BY business_id
ORDER BY 1;

SELECT '── V2 ── New queue depths per business ──' AS section;
SELECT
  CASE business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
  END AS business,
  match_status,
  COUNT(*) AS lines
FROM public.supplier_invoice_lines
WHERE business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
GROUP BY business_id, match_status
ORDER BY business_id, match_status;

SELECT '── V3 ── IDEMPOTENCY: re-applying would be a no-op (expect 0) ──' AS section;
SELECT
  CASE business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
  END AS business,
  COUNT(*) AS lines_still_needs_review_matching_pattern
FROM public.supplier_invoice_lines
WHERE business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
  AND match_status = 'needs_review'
  AND product_alias_id IS NULL
  AND raw_description ~* '(avtalsrabatt|^rabatt|^pant\M|pantersättning|öresavrundning|faktureringsavg|inkassoarvode|påminnelseavg|^pantgr[öo]n\M|^eur[-\s]?pall\M|^plastpall\M|^pallet\M|^halvpall\M|^eng[åa]ngspall\M|^kolli\M|^pba\s+retur|^srs\s+(retur|back)|^retur\s+srs|^distribution\s+|^leveransavgift\M|^plockavgift\M|^frakt\M|^milj[öo]rabatt\M)'
GROUP BY business_id
ORDER BY 1;

SELECT '── V4 ── REGRESSION GUARD: no currently-matched line touched ──' AS section;
-- The UPDATE filter `product_alias_id IS NULL` makes this structurally
-- impossible, but verify by sampling. Direction-B was clean across
-- 10,579 matched lines pre-apply; should still be clean post-apply.
SELECT
  COUNT(*) AS matched_lines_now_not_inventory_with_alias
FROM public.supplier_invoice_lines
WHERE business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
  AND match_status = 'not_inventory'
  AND product_alias_id IS NOT NULL;
-- Expected: 0. (A non-zero here would mean some matched line lost its
-- alias to this UPDATE — should never happen given the WHERE guard.)

-- ═══════════════════════════════════════════════════════════════════════
-- DRY RUN — discard everything.
-- ═══════════════════════════════════════════════════════════════════════
ROLLBACK;
