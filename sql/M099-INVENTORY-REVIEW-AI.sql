-- M099 — AI-assisted bulk review (suggestions cache + learning outcomes)
--
-- The /inventory/review page groups needs_review supplier_invoice_lines
-- into per-(supplier, normalised_desc, unit) groups. At Chicce scale
-- there are ~400 groups for an owner to triage — too much manual work.
--
-- This migration backs an AI bulk-review agent:
--
--   inventory_review_suggestions — Claude's per-group suggestion
--     cached for 24h. Re-renders of the page don't re-call the LLM.
--
--   inventory_review_outcomes — what the owner ACTUALLY did when the
--     AI suggested X. Owner agreement / override signal. Fed back
--     into future AI runs as in-context examples ('Recent owner
--     corrections — learn from these'). This is how the agent
--     improves confidence over time without retraining the model.

BEGIN;

CREATE TABLE IF NOT EXISTS inventory_review_suggestions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id     UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,
  /** Same key as the in-memory group: stable across page renders. Format
   *  is base64url(supplier|normalised_desc|unit) per
   *  /api/inventory/needs-review's grouping logic. */
  group_key       TEXT NOT NULL,

  /** AI's decision. */
  action          TEXT NOT NULL CHECK (action IN ('approve_existing','create_new','skip_non_inventory','review')),
  /** 0.00 - 1.00. Calibrated per the prompt's instructions; UI buckets
   *  to high (≥0.85) / medium (0.65-0.85) / low (<0.65). */
  confidence      NUMERIC NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  /** When action='approve_existing', the product the AI thinks matches. */
  product_id      UUID REFERENCES products(id) ON DELETE SET NULL,
  /** When action='create_new', the AI's suggested name + category. */
  suggested_name      TEXT,
  suggested_category  TEXT,
  /** Free-text Claude reasoning — owner sees this on hover or expand. */
  reasoning       TEXT,

  /** Provenance for cost reports + cache-busting. */
  ai_model        TEXT NOT NULL,
  tokens_input    INTEGER,
  tokens_output   INTEGER,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  /** One current suggestion per (business, group). Re-runs UPSERT. */
  CONSTRAINT inventory_review_suggestions_uniq UNIQUE (business_id, group_key)
);

CREATE INDEX IF NOT EXISTS idx_inv_review_sugg_business
  ON inventory_review_suggestions (business_id, created_at DESC);

-- ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS inventory_review_outcomes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id     UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,
  group_key       TEXT NOT NULL,

  /** What the AI suggested for this group at the moment of the action.
   *  Persisted as denormalised columns (not FK to suggestions) so the
   *  outcome record survives suggestion cache invalidation / pruning. */
  ai_action            TEXT,
  ai_confidence        NUMERIC,
  ai_product_id        UUID,
  ai_suggested_name    TEXT,

  /** What the owner actually did. */
  owner_action         TEXT NOT NULL CHECK (owner_action IN ('approve_existing','create_new','skip_non_inventory','approve_other','skip','override_name')),
  owner_product_id     UUID,
  owner_chosen_name    TEXT,

  /** Convenience derived field for the learning prompt: did the owner
   *  agree with the AI? TRUE when actions match AND any product/name
   *  picks also match. */
  agreed               BOOLEAN NOT NULL,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inv_review_outcomes_business_recent
  ON inventory_review_outcomes (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inv_review_outcomes_disagreements
  ON inventory_review_outcomes (business_id, created_at DESC)
  WHERE agreed = false;

-- ───────────────────────────────────────────────────────────────────
-- RLS

ALTER TABLE inventory_review_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_review_outcomes    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS irs_org_isolation ON inventory_review_suggestions;
CREATE POLICY irs_org_isolation ON inventory_review_suggestions
  FOR ALL TO authenticated
  USING      (org_id = ANY(current_user_org_ids()))
  WITH CHECK (org_id = ANY(current_user_org_ids()));

DROP POLICY IF EXISTS iro_org_isolation ON inventory_review_outcomes;
CREATE POLICY iro_org_isolation ON inventory_review_outcomes
  FOR ALL TO authenticated
  USING      (org_id = ANY(current_user_org_ids()))
  WITH CHECK (org_id = ANY(current_user_org_ids()));

COMMIT;
