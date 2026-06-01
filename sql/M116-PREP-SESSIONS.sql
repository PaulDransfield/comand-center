-- M116 — Prep sessions (the execution side of the prep list)
--
-- The prep list page (M110/prep-list v1 shipped today, 2026-06-01) can
-- COMPUTE an aggregated prep list from manual covers but can't be
-- "done" — there's no way for the kitchen to tick lines off. This
-- migration adds the execution surface:
--
--   prep_sessions       — one row per "prep run" (lunch, dinner, etc.)
--   prep_session_lines  — frozen, checkable rows (one per component +
--                         one per raw ingredient at save time)
--
-- ── Design rationale ──────────────────────────────────────────────────
--
-- WHY DB-BACKED (not localStorage)?
--   Restaurants have multiple devices. Owner sets the list on the
--   office computer or phone; chef checks lines off on the kitchen
--   tablet. They MUST see the same state. localStorage would silo per
--   browser and silently lose data on clear. The DB cost (one table +
--   one detail table + RLS) is small for the kitchen-workflow gain.
--
-- WHY FREEZE LINES AT SAVE TIME?
--   The aggregation result depends on every parent recipe + sub-recipe
--   + product price (well, qty here, but the same graph). If an owner
--   edits a recipe mid-service, the kitchen's prep list MUST NOT
--   silently re-compute under their feet — that's how you check off
--   "300g basil" only to find later the number was 600g all along.
--   The session stores the inputs (for re-aggregation transparency)
--   AND the frozen result.
--
-- WHY ONE ACTIVE SESSION PER BUSINESS?
--   Avoids ambiguity. If owner tries to start a second session while
--   one's active, the UI prompts "discard or complete current first?".
--   Future: per-service slots (lunch + dinner). Don't build now.
--
-- ── Schema ────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prep_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id   UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,
  -- Optional owner-set name. Defaults are fine ("Today's prep").
  name          TEXT,
  -- Frozen input: [{recipe_id, qty}]. Preserved for transparency, audit,
  -- and the future "re-aggregate this session" option if a recipe was
  -- corrected. Stored as JSONB so we can round-trip back through the
  -- engine without parsing.
  inputs        JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Who created the session. Auth.users id. NULL allowed for legacy /
  -- service-role writes.
  created_by    UUID,
  -- NULL = active. Set to NOW() when the kitchen clicks "Complete prep".
  completed_at  TIMESTAMPTZ
);

-- One active session per business at a time. Owner discards or
-- completes the current one before starting a new one. The partial
-- unique index enforces this without bothering completed history.
CREATE UNIQUE INDEX IF NOT EXISTS prep_sessions_one_active_idx
  ON prep_sessions (business_id)
  WHERE completed_at IS NULL;

CREATE INDEX IF NOT EXISTS prep_sessions_business_created_idx
  ON prep_sessions (business_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS prep_session_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID NOT NULL REFERENCES prep_sessions(id) ON DELETE CASCADE,
  -- 'component' = sub-recipe to prep; 'product' = raw ingredient to pull.
  kind              TEXT NOT NULL CHECK (kind IN ('component','product')),
  -- For 'component': entity_id = recipes.id of the sub-recipe.
  -- For 'product':   entity_id = products.id of the raw ingredient.
  -- We DO NOT enforce a hard FK here — the line is a frozen snapshot;
  -- deletion of the underlying recipe/product MUST NOT cascade to
  -- delete prep history. name_snapshot carries the human-readable
  -- text so display still works after deletes.
  entity_id         UUID NOT NULL,
  name_snapshot     TEXT NOT NULL,
  total_qty         NUMERIC NOT NULL,
  unit              TEXT NOT NULL,
  -- Honest-incomplete flag carried over from the engine. NULL = clean.
  uncertain         TEXT CHECK (uncertain IS NULL OR uncertain IN ('sub_no_yield','unit_mismatch','cycle')),
  uncertain_reason  TEXT,
  -- Which top-level dish(es) this line came from. Array of recipe_ids.
  source_recipe_ids UUID[] NOT NULL DEFAULT '{}',
  -- Check state. NULL = todo. Timestamp when checked.
  checked_at        TIMESTAMPTZ,
  checked_by        UUID,
  -- Display order in the UI. Matches the engine's sort.
  position          INTEGER NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS prep_session_lines_session_idx
  ON prep_session_lines (session_id, position);

CREATE INDEX IF NOT EXISTS prep_session_lines_open_idx
  ON prep_session_lines (session_id)
  WHERE checked_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────
-- RLS — same org-isolation pattern as the rest of inventory.

ALTER TABLE prep_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE prep_session_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS prep_sessions_org_isolation ON prep_sessions;
CREATE POLICY prep_sessions_org_isolation ON prep_sessions
  FOR ALL TO authenticated
  USING      (org_id = ANY(current_user_org_ids()))
  WITH CHECK (org_id = ANY(current_user_org_ids()));

-- Child rows are reachable via the parent's org. We enforce isolation
-- through the join — anyone reading a line MUST also be allowed to read
-- the parent session.
DROP POLICY IF EXISTS prep_session_lines_via_parent ON prep_session_lines;
CREATE POLICY prep_session_lines_via_parent ON prep_session_lines
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM prep_sessions s
      WHERE s.id = prep_session_lines.session_id
        AND s.org_id = ANY(current_user_org_ids())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM prep_sessions s
      WHERE s.id = prep_session_lines.session_id
        AND s.org_id = ANY(current_user_org_ids())
    )
  );

COMMIT;
