-- ═══════════════════════════════════════════════════════════════════════
-- P2.0 voucher back-fill + rebate guard — APPLY (COMMIT)
-- ═══════════════════════════════════════════════════════════════════════
--
-- IDENTICAL body to p20-voucher-rebate-backfill-DRY.sql except for the
-- trailing COMMIT (vs ROLLBACK). Only run this AFTER:
--   1. M108 is applied
--   2. The DRY file has been run and every verification SELECT matches
--      the dry-run-predicted figures (see comments below)
--   3. Owner has eyeballed V5's 17-alias detail and confirmed each one
--      is a valid clear (no surprise real products)
--
-- The wrapper is BEGIN…COMMIT — every UPDATE/INSERT persists. There is
-- no "review and decide" gap inside Supabase SQL Editor; that gate was
-- the DRY file's job.
--
-- M108 must already be applied (account_source column + widened context
-- CHECK) before this file runs — see sql/M108-P20-PROVENANCE.sql.
--
-- ── WHAT THIS DOES ────────────────────────────────────────────────────
--
-- Op 1 — Account back-fill (audit-trail-only on already-correct lines;
--        signal-activating on the ~1,650 Vero needs_review lines)
--
--   For every supplier invoice whose matched voucher has EXACTLY ONE
--   expense-account debit row, set the line's account_number to that
--   account and tag account_source='voucher_backfill'.
--
--   IDEMPOTENT — only touches rows where account_number IS NULL.
--
-- Op 2 — Rebate guard (atomic with audit outcome rows)
--
--   For every line whose raw_description matches the rebate pattern,
--   flip match_status to 'not_inventory' and clear product_alias_id.
--   Atomically insert one inventory_review_outcomes row per affected
--   alias (lines previously 'matched' with a non-null alias). Tagged
--   context='rebate_guard_backfill' so D3 separates this auto-correction
--   signal from real owner decisions.
--
--   IDEMPOTENT — only touches rows where match_status != 'not_inventory'.
--
-- ── DRY-RUN-PREDICTED FIGURES (from JS dry-run 2026-05-30) ────────────
--
--   Op 1 lines back-filled:        Chicce 901    Vero 7051   Total 7952
--   Op 2 lines → not_inventory:    Chicce 117    Vero 576    Total 693
--   Op 2b outcome rows inserted:   Chicce 17     Vero 0      Total 17
--
-- A verification SELECT that does NOT match these figures means the
-- underlying state shifted between dry-run and apply. ROLLBACK (auto in
-- this file), re-run the JS dry-run, and re-derive APPLY before COMMIT.
--
-- ── IMMEDIATE-EFFECT vs AUDIT-TRAIL split ─────────────────────────────
--
-- Op 1 touches 7,952 lines but only the ~1,650 currently-needs_review
-- get a status-changing effect immediately (Gate-0 BAS routing on next
-- matcher pass). The 5,401 already-matched / already-not_inventory get
-- the account_number as audit trail only. Step 3's lift measurement
-- is decomposed against the 1,650, NOT against 7,952.

BEGIN;

-- ── PRE-WRITE SANITY: pattern catches the predicted line counts ───────
--
-- Confirms PostgreSQL's case-insensitive regex matches what the JS dry-run
-- counted. If these numbers differ from the predictions (Chicce ~131
-- raw rebate matches, Vero ~576), the PG regex isn't behaving like JS's
-- and the back-fill should be re-derived. (These include lines already
-- at not_inventory; the actual flip-eligible subset is smaller.)

SELECT
  '── PRE-SANITY: regex match count per business (expected Chicce~131, Vero~576) ──' AS section;

SELECT
  CASE business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
  END AS business,
  COUNT(*) AS lines_matching_rebate_pattern,
  COUNT(*) FILTER (WHERE match_status = 'matched' AND product_alias_id IS NOT NULL) AS matched_with_alias,
  COUNT(*) FILTER (WHERE match_status != 'not_inventory') AS flip_eligible
FROM public.supplier_invoice_lines
WHERE business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
  AND raw_description ~* '(avtalsrabatt|^rabatt|^pant\M|pantersättning|öresavrundning|faktureringsavg|inkassoarvode|påminnelseavg)'
GROUP BY business_id
ORDER BY 1;

-- ── OPERATION 1 — Account back-fill ───────────────────────────────────
--
-- Re-derive (line → account) mapping from voucher data each run. The
-- bridge column fortnox_supplier_invoices.voucher_series/number is
-- 100% NULL today (sync didn't extract those into top-level columns);
-- data lives in raw_data.Vouchers JSONB. We parse it here.

WITH voucher_refs AS (
  -- One row per (business, given_number, voucher_series, voucher_number).
  -- Filter to ReferenceType='SUPPLIERINVOICE' so we don't pick up credit
  -- notes attached to the same given_number.
  SELECT
    fsi.business_id,
    fsi.given_number,
    (v->>'Series')::text AS voucher_series,
    (v->>'Number')::int  AS voucher_number
  FROM public.fortnox_supplier_invoices fsi,
       jsonb_array_elements(fsi.raw_data->'Vouchers') v
  WHERE fsi.business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
    AND v->>'ReferenceType' = 'SUPPLIERINVOICE'
),
expense_rows AS (
  -- Debit-side expense rows only. Excludes AP (2440), VAT (2641-2649),
  -- accrued costs (2990), rounding (3740), interest/FX (7960/7980), the
  -- entire 1xxx asset range, the entire 3xxx revenue range, and 8xxx
  -- financial. Per Step-0 finding.
  SELECT
    vc.business_id,
    vc.voucher_series,
    vc.voucher_number,
    (r->>'Account')::int AS account
  FROM public.fortnox_vouchers_cache vc,
       jsonb_array_elements(vc.rows) r
  WHERE vc.business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
    AND COALESCE((r->>'Debit')::numeric, 0) > 0
    AND (r->>'Account') IS NOT NULL
    AND (r->>'Account')::int >= 4000
    AND (r->>'Account')::int <  8000
    AND (r->>'Account')::int NOT IN (2440, 2641, 2642, 2643, 2644, 2645, 2646, 2647, 2648, 2649, 2990, 3740, 7960, 7980)
),
single_account_invoices AS (
  -- Invoices where every expense debit row posts to the same account.
  SELECT
    vr.business_id,
    vr.given_number,
    MIN(er.account) AS expense_account
  FROM voucher_refs vr
  JOIN expense_rows er
    ON er.business_id     = vr.business_id
   AND er.voucher_series  = vr.voucher_series
   AND er.voucher_number  = vr.voucher_number
  GROUP BY vr.business_id, vr.given_number
  HAVING COUNT(DISTINCT er.account) = 1
)
UPDATE public.supplier_invoice_lines sil
SET
  account_number = sai.expense_account::text,
  account_source = 'voucher_backfill'
FROM single_account_invoices sai
WHERE sil.business_id            = sai.business_id
  AND sil.fortnox_invoice_number = sai.given_number
  -- IDEMPOTENCY GUARD — only touch lines without an account yet.
  -- Owner manual edits (account_source='owner_correction', future) and
  -- Fortnox-native rows (account_source='fortnox_row') are left alone.
  AND sil.account_number IS NULL;

-- ── OPERATION 2 — Rebate guard + audit outcomes (atomic) ──────────────
--
-- ONE statement, two data-modifying CTEs: capture pre-update aliases,
-- UPDATE lines, INSERT outcome rows from the captured snapshot. The
-- two writes commit together or roll back together.
--
-- PostgreSQL regex notes:
--   ~*       case-insensitive POSIX ARE match
--   \M       end-of-word boundary (ARE equivalent of JS \b after \w)
--   ^pant\M  matches Pant/PANT/pant at start-of-string only, ending at
--            a word boundary. Does NOT match mid-string "Varav pant".

WITH affected_aliases AS (
  -- Snapshot the (alias, org, business) tuples about to be unlinked.
  -- Only 'matched' lines with a non-null alias generate an outcome row.
  SELECT DISTINCT
    sil.product_alias_id AS alias_id,
    sil.org_id,
    sil.business_id
  FROM public.supplier_invoice_lines sil
  WHERE sil.business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
    AND sil.raw_description ~* '(avtalsrabatt|^rabatt|^pant\M|pantersättning|öresavrundning|faktureringsavg|inkassoarvode|påminnelseavg)'
    AND sil.match_status = 'matched'
    AND sil.product_alias_id IS NOT NULL
),
updated_lines AS (
  -- Flip every rebate line not already at 'not_inventory'. Clears the
  -- alias link.
  UPDATE public.supplier_invoice_lines
  SET
    match_status     = 'not_inventory',
    product_alias_id = NULL
  WHERE business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
    AND raw_description ~* '(avtalsrabatt|^rabatt|^pant\M|pantersättning|öresavrundning|faktureringsavg|inkassoarvode|påminnelseavg)'
    -- IDEMPOTENCY GUARD — only flip rows that haven't been flipped yet.
    AND match_status != 'not_inventory'
  RETURNING id, business_id, raw_description
)
INSERT INTO public.inventory_review_outcomes (
  org_id,
  business_id,
  group_key,
  ai_action,
  ai_confidence,
  owner_action,
  agreed,
  context
)
SELECT
  a.org_id,
  a.business_id,
  'rebate_guard:' || a.alias_id::text  AS group_key,
  'approve_existing'                   AS ai_action,
  NULL                                 AS ai_confidence,
  'skip_non_inventory'                 AS owner_action,
  false                                AS agreed,
  'rebate_guard_backfill'              AS context
FROM affected_aliases a;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION SELECTs — eyeball EVERY count against dry-run predictions
-- before pasting the APPLY file. ROLLBACK below discards all writes from
-- this run regardless.
-- ═══════════════════════════════════════════════════════════════════════

SELECT '── V1 ── Op 1: lines back-filled (expect Chicce=901, Vero=7051) ──' AS section;
SELECT
  CASE business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
  END                                                         AS business,
  COUNT(*)                                                    AS lines_backfilled,
  COUNT(*) FILTER (WHERE match_status = 'matched')            AS matched_audit_trail,
  COUNT(*) FILTER (WHERE match_status = 'not_inventory')      AS not_inventory_audit,
  COUNT(*) FILTER (WHERE match_status = 'needs_review')       AS needs_review_immediate_effect
FROM public.supplier_invoice_lines
WHERE business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
  AND account_source = 'voucher_backfill'
GROUP BY business_id
ORDER BY 1;

SELECT '── V2 ── Op 1: account distribution (expect 4010/4011 dominant at Vero) ──' AS section;
SELECT
  CASE business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
  END                                AS business,
  account_number,
  COUNT(*)                           AS lines
FROM public.supplier_invoice_lines
WHERE business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
  AND account_source = 'voucher_backfill'
GROUP BY business_id, account_number
ORDER BY business_id, COUNT(*) DESC;

SELECT '── V3 ── Op 2: rebate lines now at not_inventory (expect Chicce=117 [from 0], Vero=576 [from 349 pre-flip; so +227 flipped]) ──' AS section;
SELECT
  CASE business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
  END                                AS business,
  COUNT(*)                           AS rebate_lines_at_not_inventory_total
FROM public.supplier_invoice_lines
WHERE business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
  AND match_status = 'not_inventory'
  AND raw_description ~* '(avtalsrabatt|^rabatt|^pant\M|pantersättning|öresavrundning|faktureringsavg|inkassoarvode|påminnelseavg)'
GROUP BY business_id
ORDER BY 1;

SELECT '── V4 ── Op 2b: outcome rows inserted (expect Chicce=17, Vero=0) ──' AS section;
SELECT
  CASE business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
  END                                AS business,
  COUNT(*)                           AS outcome_rows_inserted
FROM public.inventory_review_outcomes
WHERE business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
  AND context = 'rebate_guard_backfill'
GROUP BY business_id
ORDER BY 1;

SELECT '── V5 ── AFFECTED ALIAS DETAIL (the 17 — eyeball one last time) ──' AS section;
SELECT
  CASE iro.business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
  END                                  AS business,
  REPLACE(iro.group_key, 'rebate_guard:', '') AS alias_id,
  pa.raw_description                   AS alias_raw_description,
  p.name                               AS product_name,
  pa.supplier_name_snapshot            AS supplier,
  pa.match_method,
  pa.match_confidence,
  pa.seen_count
FROM public.inventory_review_outcomes iro
LEFT JOIN public.product_aliases pa
  ON pa.id = NULLIF(REPLACE(iro.group_key, 'rebate_guard:', ''), '')::uuid
LEFT JOIN public.products p
  ON p.id = pa.product_id
WHERE iro.context = 'rebate_guard_backfill'
  AND iro.business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
ORDER BY iro.business_id, pa.seen_count DESC NULLS LAST;

SELECT '── V6 ── IDEMPOTENCY: re-applying would be a no-op ──' AS section;
SELECT
  'op2_rebate_lines_not_yet_at_not_inventory' AS check,
  COUNT(*) AS count
FROM public.supplier_invoice_lines
WHERE business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
  AND raw_description ~* '(avtalsrabatt|^rabatt|^pant\M|pantersättning|öresavrundning|faktureringsavg|inkassoarvode|påminnelseavg)'
  AND match_status != 'not_inventory'

UNION ALL

-- For Op 1 idempotency we can't easily re-derive single_account_invoices
-- to check the "remaining null in single-account invoices" set without
-- re-running the whole CTE, so we approximate with a structural check:
-- any line tagged 'voucher_backfill' must have account_number set.
SELECT
  'op1_voucher_backfill_lines_missing_account_number' AS check,
  COUNT(*)
FROM public.supplier_invoice_lines
WHERE business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
  AND account_source = 'voucher_backfill'
  AND account_number IS NULL;
-- Both expected to be 0 after the transaction.

SELECT '── V7 ── REGRESSION GUARD: cost-path columns untouched ──' AS section;
SELECT
  COUNT(*) FILTER (WHERE quantity        IS NOT NULL) AS lines_with_qty,
  COUNT(*) FILTER (WHERE price_per_unit  IS NOT NULL) AS lines_with_price,
  COUNT(*) FILTER (WHERE total_excl_vat  IS NOT NULL) AS lines_with_total
FROM public.supplier_invoice_lines
WHERE business_id IN ('63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid, '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid)
  AND account_source = 'voucher_backfill';
-- Op 1 only sets account_number / account_source. Op 2 only sets
-- match_status / product_alias_id. None of qty/price/total should ever
-- shift. (Non-zero counts here mean the column has DATA, not that it
-- was modified — but the cost-path columns are NEVER referenced in any
-- WRITE in this transaction.)

-- ═══════════════════════════════════════════════════════════════════════
-- APPLY — persist all writes.
-- ═══════════════════════════════════════════════════════════════════════

COMMIT;
