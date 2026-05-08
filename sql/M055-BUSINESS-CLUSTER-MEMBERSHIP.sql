-- M055 — business_cluster_membership table
--
-- Many-to-many join table letting a single business belong to multiple
-- clusters along multiple dimensions. The Piece 4/5 LLM adjustment
-- pass walks this table to find peer businesses whose patterns inform
-- the current business's prediction adjustments.
--
-- Schema notes:
--   - Composite PK on (business_id, cluster_dimension, cluster_value)
--     prevents the same business getting double-mapped to identical
--     clusters via different code paths.
--   - manually_set distinguishes operator-curated mappings from
--     auto-derived ones (Pieces 4-5 may auto-derive cluster membership
--     from `businesses.cuisine`/`location_segment`/`size_segment` etc.)
--   - No RLS for v1: this is admin-only data; cluster IDs aren't
--     business-sensitive on their own. Add RLS when this becomes
--     user-facing (it isn't in the architecture's roadmap).
--
-- See PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md Appendix Z (Stream F.1).
--
-- Run: open Supabase SQL Editor, paste this file, run.

CREATE TABLE IF NOT EXISTS business_cluster_membership (
  business_id        UUID    NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  cluster_dimension  TEXT    NOT NULL,
  cluster_value      TEXT    NOT NULL,
  manually_set       BOOLEAN NOT NULL DEFAULT FALSE,
  set_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, cluster_dimension, cluster_value)
);

-- Lookup index: "find every business in cluster X along dimension Y."
-- The clustering machinery in Pieces 4-5 walks this — get-or-fail-fast
-- requires the dimension+value composite to be a fast path.
CREATE INDEX IF NOT EXISTS idx_cluster_lookup
  ON business_cluster_membership (cluster_dimension, cluster_value);

-- Sanity: confirm the table exists and is empty (DDL only — no rows yet).
SELECT COUNT(*) AS membership_rows FROM business_cluster_membership;
