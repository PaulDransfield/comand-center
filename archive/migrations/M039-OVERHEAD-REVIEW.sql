-- M039-OVERHEAD-REVIEW.sql
-- ============================================================================
-- Overhead review system — first PR of the feature.
--
-- Two tables:
--
--   1. overhead_classifications — the persistent decision per supplier per
--      business. Once the owner decides "this supplier is essential", we
--      never re-flag it unless the price moves >15% from baseline.
--      `dismissed` means "I plan to cancel this" (forward-looking — drives
--      the savings projection).
--
--   2. overhead_flags — append-only history of what the worker flagged each
--      period. References fortnox_uploads + tracker_line_items so a
--      superseded upload's flags clean up via ON DELETE CASCADE; supersede
--      (status change, not delete) is handled app-side in /api/fortnox/apply.
--
-- Both tables follow the M018 RLS pattern: org_id = ANY(current_user_org_ids()).
-- Service-role bypasses; the worker + admin tools see everything.
--
-- This PR (1 of 5) ships schema + read endpoints only. No detection runs
-- yet — the read endpoints return empty/no-flag responses gracefully.
-- ============================================================================

BEGIN;

-- ── 1. overhead_classifications ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS overhead_classifications (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id              UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,
  supplier_name            TEXT NOT NULL,                       -- as it appeared in the line item (display)
  supplier_name_normalised TEXT NOT NULL                        -- lowercased, suffix-stripped (lookup key)
                                CHECK (length(btrim(supplier_name_normalised)) > 0),
  status                   TEXT NOT NULL CHECK (status IN ('essential', 'dismissed')),
  decided_by               TEXT,                                -- user email or 'admin' or null on backfill
  decided_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason                   TEXT,                                -- optional owner note
  -- Snapshot at decision time. Drives the >15% re-flag logic.
  baseline_avg_sek         NUMERIC(14,2),                       -- avg of non-zero months over prior 12
  baseline_set_at          TIMESTAMPTZ,
  -- Backfill marker — first-run-bulk-essential rows get this set so the
  -- UI can offer "review marked-essential" without scanning every row.
  backfill                 BOOLEAN NOT NULL DEFAULT false,

  UNIQUE (business_id, supplier_name_normalised)
);

-- Hot lookup: "is this supplier classified for this business?"
CREATE INDEX IF NOT EXISTS idx_overhead_classifications_lookup
  ON overhead_classifications (business_id, supplier_name_normalised);

-- "Show me everything dismissed" (drives the projection card).
CREATE INDEX IF NOT EXISTS idx_overhead_classifications_dismissed
  ON overhead_classifications (business_id, status)
  WHERE status = 'dismissed';

ALTER TABLE overhead_classifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS overhead_classifications_read ON overhead_classifications;
CREATE POLICY overhead_classifications_read
  ON overhead_classifications FOR SELECT
  USING (org_id = ANY(current_user_org_ids()));

-- Decision writes go through the API route (service-role); no INSERT/UPDATE
-- policies for authenticated. Tightens the surface — the only path to a
-- decision is via /api/overheads/flags/[id]/decide which records who decided.

COMMENT ON TABLE overhead_classifications IS
  'Persistent overhead decisions per supplier per business. status=essential → never re-flag (unless price >15%). status=dismissed → owner plans to cancel; counts toward savings projection.';

-- ── 2. overhead_flags ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS overhead_flags (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id              UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,
  source_upload_id         UUID REFERENCES fortnox_uploads(id)        ON DELETE CASCADE,
  line_item_id             UUID REFERENCES tracker_line_items(id)     ON DELETE CASCADE,
  supplier_name            TEXT NOT NULL,
  supplier_name_normalised TEXT NOT NULL,
  flag_type                TEXT NOT NULL CHECK (flag_type IN (
                              'new_supplier',
                              'price_spike',
                              'dismissed_reappeared',
                              'one_off_high',
                              'duplicate_supplier'
                            )),
  reason                   TEXT,                          -- short human-readable why
  amount_sek               NUMERIC(14,2) NOT NULL,
  prior_avg_sek            NUMERIC(14,2),                 -- null for new_supplier / one_off_high
  period_year              INTEGER NOT NULL,
  period_month             INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  surfaced_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolution_status        TEXT NOT NULL DEFAULT 'pending'
                                CHECK (resolution_status IN ('pending', 'accepted', 'dismissed', 'deferred')),
  resolved_at              TIMESTAMPTZ,
  resolved_by              TEXT,
  defer_until              TIMESTAMPTZ,                   -- when resolution_status='deferred'
  -- AI explanation, filled by PR 4 worker pass. Null until then.
  ai_explanation           TEXT,
  ai_confidence            NUMERIC(3,2) CHECK (ai_confidence IS NULL OR (ai_confidence BETWEEN 0 AND 1)),

  -- Idempotency guard: re-running the worker for the same upload + supplier
  -- + flag_type is a no-op rather than a duplicate row.
  UNIQUE (business_id, source_upload_id, supplier_name_normalised, flag_type)
);

-- Hot path: pending flags for the review queue.
CREATE INDEX IF NOT EXISTS idx_overhead_flags_pending
  ON overhead_flags (business_id, surfaced_at DESC)
  WHERE resolution_status = 'pending';

-- "Replace this period's flags" — used when a supersede happens.
CREATE INDEX IF NOT EXISTS idx_overhead_flags_period
  ON overhead_flags (business_id, period_year, period_month);

-- "Find deferred flags whose snooze just expired."
CREATE INDEX IF NOT EXISTS idx_overhead_flags_defer_due
  ON overhead_flags (defer_until)
  WHERE resolution_status = 'deferred' AND defer_until IS NOT NULL;

ALTER TABLE overhead_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS overhead_flags_read ON overhead_flags;
CREATE POLICY overhead_flags_read
  ON overhead_flags FOR SELECT
  USING (org_id = ANY(current_user_org_ids()));

-- No INSERT/UPDATE policy — same reasoning as overhead_classifications.
-- Worker + decide-API run service-role.

COMMENT ON TABLE overhead_flags IS
  'Append-only flag history per period. UNIQUE constraint makes the worker idempotent. resolution_status tracks the owner''s decision; defer_until snoozes a flag for 30 days.';

-- ── Verify ──────────────────────────────────────────────────────────────────

SELECT 'overhead_classifications' AS object, pg_relation_size('overhead_classifications') AS bytes
UNION ALL
SELECT 'overhead_flags'           AS object, pg_relation_size('overhead_flags')           AS bytes;

SELECT tablename, indexname FROM pg_indexes
 WHERE tablename IN ('overhead_classifications', 'overhead_flags')
 ORDER BY tablename, indexname;

SELECT polname, polrelid::regclass AS tbl
  FROM pg_policy
 WHERE polrelid::regclass::text IN ('overhead_classifications', 'overhead_flags');

COMMIT;
