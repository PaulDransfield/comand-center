-- M102 — ai_request_log archive table
-- =================================================================
-- The weekly retention cron deletes ai_request_log rows older than
-- 365 days. Before this migration the data was simply lost — no audit
-- trail for compliance, no historical cost analysis past one year.
--
-- This migration adds ai_request_log_archive with per-day aggregates
-- so we keep 7+ years of audit data at ~99% smaller footprint.
--
-- Roll-up grain: (date, org_id, request_type, model). One row covers
-- every AI call of a given type-model that org made on that day. At
-- 20 customers × 8 surfaces × 2 models × 365 days = ~120k rows/year,
-- compared to potentially millions of raw request rows.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.ai_request_log_archive (
  -- Composite PK = the rollup grain
  date            DATE NOT NULL,
  org_id          UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  request_type    TEXT NOT NULL,    -- e.g. 'ask', 'budget_generate', 'pdf_extract_supplier_invoice_haiku'
  model           TEXT NOT NULL,    -- e.g. 'claude-haiku-4-5-20251001'

  -- Aggregates from the source ai_request_log rows
  request_count       INTEGER     NOT NULL DEFAULT 0,
  input_tokens_total  BIGINT      NOT NULL DEFAULT 0,
  output_tokens_total BIGINT      NOT NULL DEFAULT 0,
  cost_usd_total      NUMERIC(12,6) NOT NULL DEFAULT 0,
  cost_sek_total      NUMERIC(12,4) NOT NULL DEFAULT 0,
  duration_ms_total   BIGINT      NOT NULL DEFAULT 0,

  -- Archive bookkeeping
  archived_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (date, org_id, request_type, model)
);

-- Index for cost-over-time queries (admin dashboard, compliance audit)
CREATE INDEX IF NOT EXISTS idx_ai_request_archive_org_date
  ON public.ai_request_log_archive (org_id, date DESC);

-- Index for cross-tenant rollups (global cost breakdown by model)
CREATE INDEX IF NOT EXISTS idx_ai_request_archive_date_model
  ON public.ai_request_log_archive (date DESC, model);

-- RLS — service-role only (admin reads via /api/admin/ai-cost-history)
ALTER TABLE public.ai_request_log_archive ENABLE ROW LEVEL SECURITY;

-- Admin reads via current_user_org_ids() — org members see only their own
DROP POLICY IF EXISTS ai_log_archive_select ON public.ai_request_log_archive;
CREATE POLICY ai_log_archive_select ON public.ai_request_log_archive
  FOR SELECT
  USING (org_id = ANY(current_user_org_ids()));

-- ── Upsert RPC ─────────────────────────────────────────────────────
-- The retention cron calls this once per rollup row. We can't use a
-- straight PostgREST .upsert() because we need SET col = col + EXCLUDED
-- semantics (adds to existing aggregates if the same date+org+type+model
-- bucket gets written twice — e.g. on cron rerun after a partial fail).
CREATE OR REPLACE FUNCTION upsert_ai_log_archive(
  p_date                DATE,
  p_org_id              UUID,
  p_request_type        TEXT,
  p_model               TEXT,
  p_request_count       INTEGER,
  p_input_tokens_total  BIGINT,
  p_output_tokens_total BIGINT,
  p_cost_usd_total      NUMERIC,
  p_cost_sek_total      NUMERIC,
  p_duration_ms_total   BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO ai_request_log_archive (
    date, org_id, request_type, model,
    request_count, input_tokens_total, output_tokens_total,
    cost_usd_total, cost_sek_total, duration_ms_total
  ) VALUES (
    p_date, p_org_id, p_request_type, p_model,
    p_request_count, p_input_tokens_total, p_output_tokens_total,
    p_cost_usd_total, p_cost_sek_total, p_duration_ms_total
  )
  ON CONFLICT (date, org_id, request_type, model) DO UPDATE SET
    request_count       = ai_request_log_archive.request_count       + EXCLUDED.request_count,
    input_tokens_total  = ai_request_log_archive.input_tokens_total  + EXCLUDED.input_tokens_total,
    output_tokens_total = ai_request_log_archive.output_tokens_total + EXCLUDED.output_tokens_total,
    cost_usd_total      = ai_request_log_archive.cost_usd_total      + EXCLUDED.cost_usd_total,
    cost_sek_total      = ai_request_log_archive.cost_sek_total      + EXCLUDED.cost_sek_total,
    duration_ms_total   = ai_request_log_archive.duration_ms_total   + EXCLUDED.duration_ms_total,
    archived_at         = NOW();
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_ai_log_archive(DATE, UUID, TEXT, TEXT, INTEGER, BIGINT, BIGINT, NUMERIC, NUMERIC, BIGINT) TO service_role;

-- Verification:
--   SELECT relname FROM pg_class WHERE relname = 'ai_request_log_archive';
--   SELECT indexname FROM pg_indexes WHERE tablename = 'ai_request_log_archive';
--   SELECT proname FROM pg_proc WHERE proname = 'upsert_ai_log_archive';
