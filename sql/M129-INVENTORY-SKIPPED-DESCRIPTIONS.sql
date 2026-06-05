-- M129 — persistent owner-skip records per (business, supplier, description).
--
-- Before this table the bulk-review "Skip" button only set match_status
-- ='not_inventory' on the matching lines. The rematch worker, which
-- re-evaluates every line in ('not_inventory','needs_review') state,
-- would then re-classify those lines via Gate 0c/0d back to 'needs_review'
-- and they'd reappear in the queue. The owner had no way to make a skip
-- sticky.
--
-- This table is the persistence layer: when the owner skips a group,
-- we write a row keyed on (business, supplier, normalised_description,
-- unit). The matcher's Gate 0a-prime (between supplier_classifications
-- and description-rules) checks this table BEFORE running and returns
-- not_inventory immediately when a row exists.
--
-- Benefit: future invoice lines from the same supplier with the same
-- description auto-skip on first match — owner doesn't have to skip
-- them again every time the rematch reactivates the queue.
--
-- Composite primary key so an upsert from the skip endpoint is
-- idempotent without an extra unique constraint.

BEGIN;

CREATE TABLE IF NOT EXISTS inventory_skipped_descriptions (
  business_id              UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  supplier_fortnox_number  TEXT        NOT NULL,
  normalised_description   TEXT        NOT NULL,
  unit                     TEXT        NOT NULL DEFAULT '',   -- '' = unit-agnostic match (rare)
  skipped_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  skipped_by_user_id       UUID        NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  skip_reason              TEXT        NOT NULL DEFAULT 'owner_bulk_review',
  PRIMARY KEY (business_id, supplier_fortnox_number, normalised_description, unit)
);

-- Matcher lookup pattern is (business, supplier, normalised_description, unit).
-- Composite PK already covers that — no separate index needed.

COMMENT ON TABLE inventory_skipped_descriptions IS
  'Persistent owner-skip records. When the owner clicks "Skip" on a bulk-review group, a row lands here so the matcher (Gate 0a-prime) returns not_inventory immediately on the same description from the same supplier, even after a rematch sweep. Future invoice lines with matching descriptions auto-skip too.';

COMMIT;
