-- M126 — orphan-rescue agent audit log.
--
-- Tracks every decision the orphan-rescue cron makes (merge / defer /
-- skip) so we can audit the agent's behaviour and roll back if it ever
-- over-merges (Coke-on-Tzatziki style).
--
-- The agent finds products with 0 active aliases + a default_supplier
-- (the "no article" needs-attention class), looks for sibling products
-- at the same business with active aliases + a similar name, asks Haiku
-- whether they're the same SKU, and auto-merges only when the verdict
-- is 'same' with confidence >= 0.95 AND there's exactly one viable
-- candidate.

BEGIN;

CREATE TABLE IF NOT EXISTS orphan_rescue_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  business_id          UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  orphan_product_id    UUID        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  orphan_name          TEXT,      -- snapshot, in case the product is later renamed/archived

  -- Candidate product the agent considered (NULL = no candidate found).
  canonical_product_id UUID        REFERENCES products(id) ON DELETE SET NULL,
  canonical_name       TEXT,

  candidate_count      INTEGER     NOT NULL DEFAULT 0,
  verdict              TEXT,       -- 'same' | 'different' | 'uncertain' | NULL when no LLM call
  confidence           NUMERIC,    -- 0.0-1.0
  reasoning            TEXT,       -- LLM's one-sentence explanation

  -- What the agent did about it.
  action               TEXT        NOT NULL CHECK (action IN (
    'merged',
    'skipped_low_confidence',
    'skipped_ambiguous',
    'skipped_no_candidate',
    'skipped_pack_mismatch',
    'skipped_supplier_mismatch',
    'error'
  )),
  error_message        TEXT,

  tokens_in            INTEGER,
  tokens_out           INTEGER
);

CREATE INDEX IF NOT EXISTS orphan_rescue_log_business_idx ON orphan_rescue_log (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orphan_rescue_log_action_idx   ON orphan_rescue_log (action, created_at DESC);

COMMENT ON TABLE orphan_rescue_log IS
  'Audit log for the orphan-product-rescue cron (M126). One row per (orphan, run) — even when no action was taken — so the agent''s decision history is fully recoverable.';

COMMIT;
