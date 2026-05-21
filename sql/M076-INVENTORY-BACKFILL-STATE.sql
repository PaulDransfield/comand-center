-- M076 — Inventory backfill state tracker
--
-- Phase A follow-up: the /api/inventory/lines/backfill endpoint was
-- synchronous and timed out (HTTP 504) on businesses with > ~60 invoices
-- because matcher cost (~50-100ms per line × thousands of lines) exceeds
-- Vercel's edge proxy timeout.
--
-- This table holds per-business state so the kick endpoint can fire a
-- background worker via `waitUntil`, return immediately, and let the
-- admin UI poll for progress. Same pattern as fortnox_backfill_state
-- (M033-era), pared down because the inventory worker is stateless —
-- it doesn't need resume-from-checkpoint logic since the matcher only
-- acts on lines where match_status IN ('needs_review', NULL).

CREATE TABLE IF NOT EXISTS public.inventory_backfill_state (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- 'pending'   — row just inserted by the kick endpoint, worker not yet active
  -- 'running'   — worker is processing
  -- 'completed' — worker finished cleanly
  -- 'failed'    — worker threw or returned an error
  status          TEXT NOT NULL,

  -- Live progress payload, updated every N invoices. Owner-friendly
  -- shape so the UI can render directly without massaging:
  --   {
  --     phase:                   'fetching_invoice_list' | 'fetching_rows' | 'matching' | 'done',
  --     invoices_found:          150,
  --     invoices_processed:      87,
  --     lines_inserted:          1240,
  --     lines_matched:           870,
  --     lines_needs_review:      270,
  --     lines_not_inventory:     100,
  --     errors:                  [{ invoice, error }],
  --     window:                  { from, to }
  --   }
  progress        JSONB,

  error_message   TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT inventory_backfill_state_status_chk CHECK (status IN (
    'pending', 'running', 'completed', 'failed'
  )),

  -- One in-flight (or last-known) row per business. The kick endpoint
  -- upserts; the worker mutates that same row.
  UNIQUE (business_id)
);

CREATE INDEX IF NOT EXISTS inventory_backfill_state_status_idx
  ON public.inventory_backfill_state (status, updated_at DESC);

ALTER TABLE public.inventory_backfill_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_backfill_state_select ON public.inventory_backfill_state;
CREATE POLICY inventory_backfill_state_select ON public.inventory_backfill_state
  FOR SELECT USING (org_id = ANY(current_user_org_ids()));

DROP POLICY IF EXISTS inventory_backfill_state_modify ON public.inventory_backfill_state;
CREATE POLICY inventory_backfill_state_modify ON public.inventory_backfill_state
  FOR ALL USING (org_id = ANY(current_user_org_ids()))
  WITH CHECK (org_id = ANY(current_user_org_ids()));

CREATE OR REPLACE FUNCTION public.set_inventory_backfill_state_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inventory_backfill_state_updated_at ON public.inventory_backfill_state;
CREATE TRIGGER trg_inventory_backfill_state_updated_at
  BEFORE UPDATE ON public.inventory_backfill_state
  FOR EACH ROW EXECUTE FUNCTION public.set_inventory_backfill_state_updated_at();
