-- M106 — Audit queue + durable demotion history
--
-- Deliverable 2 of the categorization learning-loop hardening
-- (LEARNING-LOOP-PHASE1-PLAN.md §2b + §3).
--
-- TWO ADDITIVE SCHEMA CHANGES + ONE NEW TABLE + ONE NEW DISCRIMINATOR:
--
--   A. product_aliases gains times_demoted + last_demoted_at
--      (monotonic — never reset by re-activation)
--   B. inventory_review_outcomes gains a `context` column with CHECK
--      (distinguishes audit_sample outcomes from needs_review outcomes
--      so the AI-suggester can read them separately)
--   C. inventory_audit_queue (NEW) — lightweight spot-check queue
--      with reason enum + sampling metadata
--   D. product_aliases_record_correction RPC extended to bump
--      times_demoted + last_demoted_at on the deactivation step
--
-- IDEMPOTENT. Safe to re-run. CHECK constraints + new RPC body re-
-- declared with CREATE OR REPLACE / DO blocks.
--
-- RUNS AFTER M105. The DDL assumes M105 already added is_active +
-- corrections_against + deactivated_reason + deactivated_at columns.

BEGIN;

-- ── A. product_aliases — durable demotion history ──────────────────────

ALTER TABLE public.product_aliases
  ADD COLUMN IF NOT EXISTS times_demoted    INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_demoted_at  TIMESTAMPTZ;

-- Defensive CHECK: times_demoted is monotonic (never goes negative).
-- App-level code MUST never decrement; the RPC + reactivation path are
-- the only writers.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_aliases_times_demoted_monotonic_chk'
  ) THEN
    ALTER TABLE public.product_aliases
      ADD CONSTRAINT product_aliases_times_demoted_monotonic_chk
      CHECK (times_demoted >= 0);
  END IF;
END $$;

-- Index for the D2 audit-queue sampler's "previously-demoted" risk
-- weight + reporting query: previously-demoted-but-active aliases.
CREATE INDEX IF NOT EXISTS product_aliases_previously_demoted
  ON public.product_aliases (times_demoted DESC, last_demoted_at DESC)
  WHERE times_demoted > 0;

-- ── B. inventory_review_outcomes — context discriminator ──────────────

ALTER TABLE public.inventory_review_outcomes
  ADD COLUMN IF NOT EXISTS context TEXT NOT NULL DEFAULT 'needs_review';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inventory_review_outcomes_context_chk'
  ) THEN
    ALTER TABLE public.inventory_review_outcomes
      ADD CONSTRAINT inventory_review_outcomes_context_chk
      CHECK (context IN ('needs_review', 'audit_sample'));
  END IF;
END $$;

-- Sampler / accuracy-snapshot read path uses (business, context, created_at).
CREATE INDEX IF NOT EXISTS inv_review_outcomes_context_recent
  ON public.inventory_review_outcomes (business_id, context, created_at DESC);

-- ── C. inventory_audit_queue — spot-check queue ────────────────────────

CREATE TABLE IF NOT EXISTS public.inventory_audit_queue (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id         UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,
  alias_id            UUID NOT NULL REFERENCES product_aliases(id) ON DELETE CASCADE,
  -- The line that triggered this sample (optional — may be null for
  -- decay-sourced flags where no specific line drives the sample).
  line_id             UUID REFERENCES supplier_invoice_lines(id) ON DELETE SET NULL,
  reason              TEXT NOT NULL CHECK (reason IN (
                        'confident_auto_match',  -- newly inserted fuzzy_* alias
                        'previously_demoted',    -- times_demoted > 0 reactivated alias
                        'decay_stale',           -- cross-supplier alias unused for DECAY_DAYS_CROSS_SUPPLIER
                        'manual_review'          -- admin/operator manually flagged
                      )),
  -- Risk weight at sample time. Higher = more important to review.
  -- See lib/inventory/audit-sampler.ts for the score formula.
  risk_score          NUMERIC,
  -- Snapshot fields so the queue UI doesn't have to join out for the
  -- common-case render (alias might be deactivated by review time).
  alias_match_method     TEXT,
  alias_match_confidence NUMERIC,
  alias_times_demoted    INTEGER,
  -- Workflow timestamps
  sampled_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at         TIMESTAMPTZ,
  reviewer_decision   TEXT CHECK (reviewer_decision IS NULL OR reviewer_decision IN (
                        'confirm',   -- audit confirms the alias was correct
                        'correct',   -- audit found the alias wrong → triggers demotion
                        'skip'       -- defer (no positive or negative signal)
                      )),
  reviewer_user_id    UUID,
  -- Idempotency: one queue item per (business, alias, reason). The
  -- sampler upserts so re-runs don't double-queue.
  UNIQUE (business_id, alias_id, reason)
);

-- Hot path: "pending audit items for this business, top-N by risk".
CREATE INDEX IF NOT EXISTS inventory_audit_queue_pending
  ON public.inventory_audit_queue (business_id, risk_score DESC NULLS LAST, sampled_at DESC)
  WHERE reviewed_at IS NULL;

ALTER TABLE public.inventory_audit_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_audit_queue_select ON public.inventory_audit_queue;
CREATE POLICY inventory_audit_queue_select ON public.inventory_audit_queue
  FOR SELECT
  USING (org_id = ANY(current_user_org_ids()));

DROP POLICY IF EXISTS inventory_audit_queue_modify ON public.inventory_audit_queue;
CREATE POLICY inventory_audit_queue_modify ON public.inventory_audit_queue
  FOR ALL
  USING      (org_id = ANY(current_user_org_ids()))
  WITH CHECK (org_id = ANY(current_user_org_ids()));

-- ── D. product_aliases_record_correction — extend to track times_demoted ──
--
-- M105's version incremented corrections_against + flipped is_active=FALSE
-- on threshold cross. M106 ALSO bumps times_demoted + last_demoted_at on
-- the deactivation step — the durable history that survives re-activation.
--
-- Same return semantics:
--   TRUE  = this call caused deactivation
--   FALSE = no-op (alias missing, already demoted) OR below threshold

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

  -- Alias missing or already demoted → no-op.
  IF new_count IS NULL THEN RETURN FALSE; END IF;

  IF new_count >= p_threshold THEN
    UPDATE public.product_aliases
       SET is_active           = FALSE,
           deactivated_reason  = 'corrections_threshold',
           deactivated_at      = NOW(),
           -- M106 additions: durable history.
           times_demoted       = times_demoted + 1,
           last_demoted_at     = NOW()
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

-- A. Confirm new columns are populated with defaults on existing rows.
SELECT
  COUNT(*)                                                AS total_aliases,
  COUNT(*) FILTER (WHERE times_demoted = 0)               AS pristine_aliases,
  COUNT(*) FILTER (WHERE times_demoted > 0)               AS previously_demoted_aliases,
  COUNT(*) FILTER (WHERE last_demoted_at IS NOT NULL)     AS aliases_with_demotion_history
FROM public.product_aliases;

-- B. Confirm context column on outcomes is populated.
SELECT context, COUNT(*) AS outcomes
FROM public.inventory_review_outcomes
GROUP BY context
ORDER BY outcomes DESC;

-- C. Confirm audit queue table exists + is empty.
SELECT COUNT(*) AS queue_rows FROM public.inventory_audit_queue;

-- D. Smoke-test the extended RPC — should still no-op safely on missing alias.
SELECT public.product_aliases_record_correction(
  '00000000-0000-0000-0000-000000000000'::uuid
) AS rpc_smoke_returns_false;
