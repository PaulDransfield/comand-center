-- M105 — Demotion & decay infrastructure on product_aliases
--
-- Deliverable 1 of the categorization learning-loop hardening
-- (LEARNING-LOOP-PHASE1-PLAN.md §2). Adds the columns + RPCs that let
-- a wrong alias be pulled back without ever being hard-deleted.
--
-- WHY this matters today (from the Step-0 diagnostic 2026-05-30):
--   - 95% of product_aliases rows are owner_confirmed; only ~5% (~89) are
--     auto-matched. So the immediate demotion surface is the owner-confirmed
--     rules themselves — when an owner overrides their own past decision on
--     a new invoice line, the old alias was wrong and needs to go.
--   - 0 flip-flops observed across 224 group revisits → threshold = 2
--     corrections is safe (zero risk of "two accidental clicks nuke a legit
--     alias").
--   - Auto-link demotion is cheap insurance for when the matcher's share
--     grows — same mechanism, same threshold.
--
-- WHAT THIS MIGRATION DOES:
--   1. Add 6 nullable/defaulted columns on product_aliases (additive only)
--   2. Add a CHECK on deactivated_reason (4 allowed values)
--   3. Add two indexes for hot paths (active-matcher SELECT + decay sweep)
--   4. Extend inventory_touch_alias RPC to also set last_applied_at
--   5. Add product_aliases_record_correction RPC (atomic increment + maybe-deactivate)
--   6. Modify inventory_trigram_search RPC to filter pa.is_active = TRUE
--
-- IDEMPOTENT. Safe to re-run. ALL operations wrapped in IF NOT EXISTS or
-- CREATE OR REPLACE.
--
-- ROLLBACK (if needed):
--   ALTER TABLE product_aliases
--     DROP COLUMN IF EXISTS deactivated_at,
--     DROP COLUMN IF EXISTS deactivated_reason,
--     DROP COLUMN IF EXISTS last_corrected_at,
--     DROP COLUMN IF EXISTS last_applied_at,
--     DROP COLUMN IF EXISTS corrections_against,
--     DROP COLUMN IF EXISTS is_active;
--   DROP FUNCTION IF EXISTS product_aliases_record_correction(UUID, INTEGER);
--   -- Restore the original RPCs from sql/M075-INVENTORY-CATALOGUE.sql.

BEGIN;

-- ── 1. Columns on product_aliases ───────────────────────────────────────

ALTER TABLE public.product_aliases
  ADD COLUMN IF NOT EXISTS is_active            BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS corrections_against  INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_applied_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_corrected_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deactivated_reason   TEXT,
  ADD COLUMN IF NOT EXISTS deactivated_at       TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_aliases_deactivated_reason_chk'
  ) THEN
    ALTER TABLE public.product_aliases
      ADD CONSTRAINT product_aliases_deactivated_reason_chk
      CHECK (
        deactivated_reason IS NULL
        OR deactivated_reason IN (
          'owner_override',
          'corrections_threshold',
          'decay_stale',
          'manual_admin'
        )
      );
  END IF;
END $$;

-- Defensive: if a row is is_active=FALSE, it must have a deactivated_reason.
-- This catches code paths that flip the flag without recording why.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_aliases_deactivation_reason_required_chk'
  ) THEN
    ALTER TABLE public.product_aliases
      ADD CONSTRAINT product_aliases_deactivation_reason_required_chk
      CHECK (is_active = TRUE OR deactivated_reason IS NOT NULL);
  END IF;
END $$;

-- ── 2. Indexes for hot paths ────────────────────────────────────────────

-- Hot path 1: matcher Steps 1-2 SELECTs against active aliases only.
-- Existing partial uniques on (business_id, supplier_fortnox_number,
-- article_number) etc. continue to enforce dedup; this index speeds up
-- the new is_active filter.
CREATE INDEX IF NOT EXISTS product_aliases_active_lookup
  ON public.product_aliases (business_id, supplier_fortnox_number)
  WHERE is_active = TRUE;

-- Hot path 2: D2 decay sweep (cross-supplier auto-aliases by last_applied_at).
-- Tiny partial index; only matches the population that needs decay attention.
CREATE INDEX IF NOT EXISTS product_aliases_decay_candidates
  ON public.product_aliases (last_applied_at NULLS FIRST)
  WHERE is_active = TRUE AND match_method = 'fuzzy_cross_supplier';

-- ── 3. inventory_touch_alias — extend to set last_applied_at ───────────
--
-- Original from M075 only bumped last_seen_at + seen_count. We extend
-- so the matcher's auto-call after a successful match also records when
-- the alias was last used to match a real invoice line. D2's decay
-- sweep reads this to flag stale aliases.
--
-- last_seen_at vs last_applied_at distinction:
--   - last_seen_at: bumped on ANY match path (deterministic exact OR fuzzy)
--     plus owner_confirmed insertions. Same as M075 behaviour.
--   - last_applied_at: bumped ONLY when an alias is successfully used by
--     the matcher to attribute a new invoice line. The new column.
--   In practice both happen on the same call today, but the semantics
--   diverge once we add the audit queue (D2) — auditor-only events touch
--   last_seen_at but not last_applied_at.
--
-- Skips no-op on demoted aliases. Belt-and-braces: the matcher should
-- have stopped returning demoted aliases first.

CREATE OR REPLACE FUNCTION public.inventory_touch_alias(p_alias_id UUID)
RETURNS VOID
LANGUAGE sql AS $$
  UPDATE public.product_aliases
     SET last_seen_at     = NOW(),
         seen_count       = seen_count + 1,
         last_applied_at  = NOW()
   WHERE id = p_alias_id
     AND is_active = TRUE
$$;

-- ── 4. inventory_trigram_search — filter on is_active = TRUE ───────────
--
-- The matcher's fuzzy path (Steps 3-4) calls this RPC. Without the filter,
-- a demoted alias would still appear in trigram candidates and the
-- matcher's JS-side filter would have to drop it — wasteful + risk of
-- accidentally linking. Filter at SQL boundary.

CREATE OR REPLACE FUNCTION public.inventory_trigram_search(
  p_business_id UUID,
  p_query       TEXT,
  p_limit       INTEGER DEFAULT 12
)
RETURNS TABLE (
  alias_id                UUID,
  product_id              UUID,
  product_name            TEXT,
  raw_description         TEXT,
  supplier_fortnox_number TEXT,
  similarity              REAL
)
LANGUAGE sql STABLE AS $$
  SELECT
    pa.id                            AS alias_id,
    pa.product_id                    AS product_id,
    p.name                           AS product_name,
    pa.raw_description               AS raw_description,
    pa.supplier_fortnox_number       AS supplier_fortnox_number,
    similarity(pa.normalised_description, p_query) AS similarity
  FROM public.product_aliases pa
  JOIN public.products p ON p.id = pa.product_id AND p.archived_at IS NULL
  WHERE pa.business_id = p_business_id
    AND pa.is_active = TRUE                       -- M105: skip demoted aliases
    AND pa.normalised_description % p_query
  ORDER BY pa.normalised_description <-> p_query
  LIMIT p_limit
$$;

-- ── 5. product_aliases_record_correction ────────────────────────────────
--
-- Atomic increment + maybe-deactivate. Called from
-- PATCH /api/inventory/lines/[id] when the owner changes a line's
-- product_alias_id (= "this auto-link is wrong").
--
-- Returns TRUE iff this correction caused the alias to be deactivated.
-- Returns FALSE if the alias didn't exist, was already deactivated, or
-- the new corrections_against is below the threshold.
--
-- Threshold default is 2 (LEARNING-LOOP-PHASE1-PLAN.md §0.2 + locked
-- decision in §7.1 of phase-1-harden-learning-loop-prompt.md). Caller can
-- override per-call (e.g. D2's audit-queue UI uses threshold=1 because
-- the auditor is explicitly reviewing).

CREATE OR REPLACE FUNCTION public.product_aliases_record_correction(
  p_alias_id   UUID,
  p_threshold  INTEGER DEFAULT 2
)
RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
  new_count INTEGER;
BEGIN
  UPDATE public.product_aliases
     SET corrections_against = corrections_against + 1,
         last_corrected_at   = NOW()
   WHERE id = p_alias_id
     AND is_active = TRUE
   RETURNING corrections_against
        INTO new_count;

  -- Alias missing or already demoted → no-op (return FALSE).
  IF new_count IS NULL THEN RETURN FALSE; END IF;

  IF new_count >= p_threshold THEN
    UPDATE public.product_aliases
       SET is_active           = FALSE,
           deactivated_reason  = 'corrections_threshold',
           deactivated_at      = NOW()
     WHERE id = p_alias_id
       AND is_active = TRUE;
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END $$;

GRANT EXECUTE ON FUNCTION public.product_aliases_record_correction(UUID, INTEGER)
  TO authenticated, service_role;

COMMIT;

-- ── Verification (run manually after COMMIT) ────────────────────────────
-- Confirms M105 landed without disturbing existing data.

-- Should return is_active=TRUE for every row (existing aliases stay active).
SELECT
  COUNT(*)                                          AS total_aliases,
  COUNT(*) FILTER (WHERE is_active = TRUE)          AS active_aliases,
  COUNT(*) FILTER (WHERE is_active = FALSE)         AS demoted_aliases,
  COUNT(*) FILTER (WHERE corrections_against > 0)   AS aliases_with_corrections,
  COUNT(*) FILTER (WHERE last_applied_at IS NOT NULL) AS aliases_ever_applied
FROM public.product_aliases;

-- Should show the new indexes.
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'product_aliases'
  AND indexname IN ('product_aliases_active_lookup', 'product_aliases_decay_candidates');

-- Should list both new CHECK constraints.
SELECT conname
FROM pg_constraint
WHERE conrelid = 'public.product_aliases'::regclass
  AND conname LIKE 'product_aliases_deactivat%';

-- Quick smoke-test of the correction RPC (DRY — uses a non-existent UUID).
-- Should return FALSE without changing any rows.
SELECT public.product_aliases_record_correction('00000000-0000-0000-0000-000000000000'::uuid)
  AS smoke_test_returns_false;
