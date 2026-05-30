-- M107 — Inventory accuracy snapshots (D3)
--
-- Per-day, per-business + global rollup of categorisation-loop health
-- signals. Read by the admin metrics view; written by the daily cron
-- at /api/cron/inventory-accuracy-snapshot.
--
-- DESIGN POINTS (owner-locked, LEARNING-LOOP-PHASE1-PLAN.md §3b):
--
-- A. SEGMENTED agreement rates (NEVER BLENDED). needs_review and
--    audit_sample are different populations — only needs_review feeds
--    the §7.1 floor. They sit in two separate column families.
--
-- B. WARM-UP. The snapshot row records the alert level emitted on each
--    day. During warm-up (snapshot_date < BASELINE_ANCHOR_DATE +
--    WARMUP_DAYS = 2026-05-30 + 30d), the floor-check tags alerts
--    as 'informational' instead of 'soft'/'hard'. The column itself
--    is just text — the warm-up logic lives in
--    lib/inventory/accuracy-floor.ts.
--
-- C. NON-HEADLINE METRICS as explicit columns:
--    - create_new_divergence_pct: AI over/under-spawn rate vs owner
--    - rebate_noise_count: Gate-0 leakage (Avtalsrabatt / pant /
--      öresavrundning patterns)
--
-- All columns are NULL-defaulted where computation might lack data —
-- the floor logic interprets nulls as "insufficient data, stay quiet".
--
-- IDEMPOTENT. Safe to re-run.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.inventory_accuracy_snapshots;

BEGIN;

CREATE TABLE IF NOT EXISTS public.inventory_accuracy_snapshots (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  -- NULL business_id = global rollup row (sum across all businesses in
  -- the org). Each cron run writes one per-business row + one global row
  -- per org.
  business_id         UUID REFERENCES businesses(id) ON DELETE CASCADE,
  snapshot_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  window_days         INTEGER NOT NULL DEFAULT 30,

  -- ── Segmented agreement metrics (§3b.1) ───────────────────────────────
  -- needs_review path: hard cases the matcher couldn't auto-categorise.
  -- This is the SIGNAL THE §7.1 FLOOR WATCHES.
  needs_review_outcomes_total    INTEGER NOT NULL DEFAULT 0,
  needs_review_outcomes_agreed   INTEGER NOT NULL DEFAULT 0,
  needs_review_agreement_pct     NUMERIC,  -- nullable: undefined when total=0

  -- audit_sample path: confident auto-matches the owner spot-checked.
  -- Its own trend; NOT subject to the §7.1 floor.
  audit_sample_outcomes_total    INTEGER NOT NULL DEFAULT 0,
  audit_sample_outcomes_agreed   INTEGER NOT NULL DEFAULT 0,
  audit_sample_agreement_pct     NUMERIC,

  -- Audit-sample precision (confirms / (confirms + corrections)).
  -- Specifically excludes 'skip' decisions from the denominator.
  audit_sample_confirmations     INTEGER NOT NULL DEFAULT 0,
  audit_sample_corrections       INTEGER NOT NULL DEFAULT 0,
  audit_sample_precision_pct     NUMERIC,

  -- ── needs_review queue depth ──────────────────────────────────────────
  needs_review_lines_count       INTEGER NOT NULL DEFAULT 0,
  total_lines_in_window          INTEGER NOT NULL DEFAULT 0,
  needs_review_rate_pct          NUMERIC,

  -- ── Demotion rate (D1 mechanism telemetry) ────────────────────────────
  demotions_in_window            INTEGER NOT NULL DEFAULT 0,
  active_aliases_window_start    INTEGER NOT NULL DEFAULT 0,
  demotion_rate_pct              NUMERIC,

  -- ── Non-headline metrics (§3b.3) ──────────────────────────────────────
  -- create_new divergence: AI spawns 'create_new' more often than the owner
  -- chooses 'create_new'. Pre-D3 measurement: AI 721 vs Owner 533 = +26%.
  -- Positive = AI over-suggests new products (catalog-duplication risk).
  ai_create_new_count            INTEGER NOT NULL DEFAULT 0,
  owner_create_new_count         INTEGER NOT NULL DEFAULT 0,
  create_new_divergence_pct      NUMERIC,

  -- Gate-0 rebate noise: count of product_aliases or recent invoice lines
  -- whose raw_description matches the rebate pattern (Avtalsrabatt, pant,
  -- öresavrundning, faktureringsavgift, etc). Quantifies how often Gate-0
  -- lets non-products through.
  rebate_noise_count             INTEGER NOT NULL DEFAULT 0,

  -- ── Floor-check output ────────────────────────────────────────────────
  -- alert_level is set by the floor-check that runs after the snapshot
  -- write. Values: 'hard', 'soft', 'informational', NULL.
  --   NULL  = quiet (no signal OR below min-sample guard)
  --   'informational' = within warm-up window; signal computed but not actioned
  --   'soft' / 'hard' = real alerts post-warm-up
  alert_level                    TEXT,
  alert_reason                   TEXT,
  -- The baseline that was used for the comparison (rolling-30-day median
  -- of needs_review_agreement_pct from snapshots ON OR AFTER the anchor).
  baseline_needs_review_pct      NUMERIC,
  delta_vs_baseline_pp           NUMERIC,  -- positive = improvement, negative = drop

  computed_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One row per (org, business?, date, window). Re-runs UPSERT.
  UNIQUE (org_id, business_id, snapshot_date, window_days)
);

-- alert_level CHECK constraint — restricts the values without forcing a
-- migration when we add a 4th alert level later.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_accuracy_snapshots_alert_chk'
  ) THEN
    ALTER TABLE public.inventory_accuracy_snapshots
      ADD CONSTRAINT inventory_accuracy_snapshots_alert_chk
      CHECK (alert_level IS NULL OR alert_level IN ('informational', 'soft', 'hard'));
  END IF;
END $$;

-- Lookup index: trend chart query (per-business, last 90d).
CREATE INDEX IF NOT EXISTS inventory_accuracy_snapshots_trend
  ON public.inventory_accuracy_snapshots (org_id, business_id, snapshot_date DESC);

-- Audit query: "when did the floor first fire a real alert?"
CREATE INDEX IF NOT EXISTS inventory_accuracy_snapshots_alerts
  ON public.inventory_accuracy_snapshots (snapshot_date DESC)
  WHERE alert_level IS NOT NULL AND alert_level != 'informational';

-- RLS — admin-only surface per §7.2 (NOT exposed to owners).
-- The admin page authenticates via ADMIN_SECRET, not a user session,
-- so we keep RLS strict (org members can read their own org's
-- snapshots, no writes from the user-facing side).
ALTER TABLE public.inventory_accuracy_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inv_accuracy_snapshots_org_select ON public.inventory_accuracy_snapshots;
CREATE POLICY inv_accuracy_snapshots_org_select ON public.inventory_accuracy_snapshots
  FOR SELECT
  USING (org_id = ANY(current_user_org_ids()));

-- No INSERT/UPDATE/DELETE policy: service role only (the cron uses
-- service-role; admin view reads with service role behind ADMIN_SECRET).

COMMIT;

-- ── Verification (run manually after COMMIT) ────────────────────────────

-- Schema check
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'inventory_accuracy_snapshots'
ORDER BY ordinal_position;

-- Constraint check
SELECT conname
FROM pg_constraint
WHERE conrelid = 'public.inventory_accuracy_snapshots'::regclass;

-- Index check
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'inventory_accuracy_snapshots';

-- Empty table sanity
SELECT COUNT(*) AS rows_so_far FROM public.inventory_accuracy_snapshots;
