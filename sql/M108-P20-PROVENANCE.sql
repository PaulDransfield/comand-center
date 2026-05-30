-- M108 — P2.0 provenance columns + context CHECK widening
--
-- Two additive schema changes that the voucher-back-fill transaction
-- depends on. Same-commit-DB+TS discipline: the application code that
-- writes 'voucher_backfill' / 'rebate_guard_backfill' ships in the
-- same branch as this migration.
--
-- A. supplier_invoice_lines.account_source TEXT
--    Provenance for the account_number column. Distinguishes:
--      'fortnox_row'        — line came with account_number set by Fortnox
--                             at extraction time (the today-default for
--                             Vero's article-bearing invoices)
--      'voucher_backfill'   — account inferred from the matched
--                             SINGLE-expense-account voucher (P2.0)
--      'owner_correction'   — an owner edited the line's account
--                             manually (admin UI; not built yet, but
--                             reserved so a future edit can be tagged)
--
--    Existing rows: defaulted to 'fortnox_row'. That's the honest read
--    of the current state — every existing non-NULL account_number on
--    a line was either present at extraction (Vero's case) or set by
--    the supplier-name fallback at Gate-0 ingest. Either way it's not
--    a voucher-derived back-fill, so 'fortnox_row' is the right tag.
--
-- B. inventory_review_outcomes.context CHECK widened to add
--    'rebate_guard_backfill' alongside the existing 'needs_review' +
--    'audit_sample'. Pre-commit snapshot confirmed those two are the
--    only existing values (2498 + 1 = 2499 rows scanned), so the
--    new CHECK won't fail on existing data.
--
--    The new context value gives D3's accuracy snapshot the freedom
--    to segment "owner manually skipped a rebate-noise line" (the
--    existing 'needs_review' / 'audit_sample' contexts) from "the
--    rebate guard auto-corrected this once at back-fill time" — two
--    different confidence signals you don't want blended in the
--    rolling agreement-rate metric.
--
-- IDEMPOTENT — safe to re-run. ADD COLUMN IF NOT EXISTS + DROP-and-recreate
-- of the CHECK so a re-run is a true no-op.
--
-- ROLLBACK (rare; only if discovered after-the-fact that the column
-- needs a different shape):
--   ALTER TABLE public.supplier_invoice_lines DROP COLUMN IF EXISTS account_source;
--   ALTER TABLE public.inventory_review_outcomes
--     DROP CONSTRAINT IF EXISTS inventory_review_outcomes_context_chk;
--   ALTER TABLE public.inventory_review_outcomes
--     ADD CONSTRAINT inventory_review_outcomes_context_chk
--     CHECK (context IN ('needs_review', 'audit_sample'));

BEGIN;

-- ── A. supplier_invoice_lines.account_source ──────────────────────────

ALTER TABLE public.supplier_invoice_lines
  ADD COLUMN IF NOT EXISTS account_source TEXT NOT NULL DEFAULT 'fortnox_row';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'supplier_invoice_lines_account_source_chk'
  ) THEN
    ALTER TABLE public.supplier_invoice_lines
      ADD CONSTRAINT supplier_invoice_lines_account_source_chk
      CHECK (account_source IN ('fortnox_row', 'voucher_backfill', 'owner_correction'));
  END IF;
END $$;

-- Audit index — "show me everything the voucher back-fill touched"
-- (used by the back-fill verification SELECTs + Step 3 measurement).
CREATE INDEX IF NOT EXISTS supplier_invoice_lines_account_source_idx
  ON public.supplier_invoice_lines (business_id, account_source)
  WHERE account_source != 'fortnox_row';

-- ── B. inventory_review_outcomes.context CHECK widening ───────────────
--
-- DROP + recreate (Postgres has no ALTER CONSTRAINT widen-CHECK).
-- Pre-commit snapshot 2026-05-30 confirmed only 'needs_review' (2498)
-- and 'audit_sample' (1) currently exist, both still allowed by the
-- new CHECK; no strand risk.

ALTER TABLE public.inventory_review_outcomes
  DROP CONSTRAINT IF EXISTS inventory_review_outcomes_context_chk;

ALTER TABLE public.inventory_review_outcomes
  ADD CONSTRAINT inventory_review_outcomes_context_chk
  CHECK (context IN ('needs_review', 'audit_sample', 'rebate_guard_backfill'));

COMMIT;

-- ── Verification (run manually after COMMIT) ──────────────────────────

-- A1. New column exists with default + NOT NULL
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'supplier_invoice_lines'
  AND column_name = 'account_source';

-- A2. CHECK constraint exists and lists the three allowed values
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conname = 'supplier_invoice_lines_account_source_chk';

-- A3. Index created
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'supplier_invoice_lines'
  AND indexname = 'supplier_invoice_lines_account_source_idx';

-- A4. Every existing row defaulted to 'fortnox_row'
SELECT account_source, COUNT(*)
FROM public.supplier_invoice_lines
GROUP BY account_source
ORDER BY 2 DESC;

-- B1. context CHECK now allows the third value
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conname = 'inventory_review_outcomes_context_chk';

-- B2. No existing rows stranded
SELECT context, COUNT(*)
FROM public.inventory_review_outcomes
GROUP BY context
ORDER BY 2 DESC;
