-- M038-ADMIN-NOTES-AND-SAVED-QUERIES.sql
-- ============================================================================
-- Admin v2 PR 10 — Saved investigations / customer notes.
--
-- Two related tables in one migration. Both are admin-only context (the
-- customer never sees them); neither is referenced by any non-admin path.
--
--   1. admin_notes — first-class threaded note table for the customer-
--      detail Notes sub-tab. Notes used to live as `note_add` rows in
--      admin_audit_log, which made editing, deleting, threading, or
--      pinning impossible. This promotes notes to their own table while
--      still recording every mutation in admin_audit_log for forensics.
--
--   2. admin_saved_queries — saved investigations from the Tools tab.
--      Each row is a labelled SQL query, optionally tied to an org
--      (so an investigation about a specific customer can be re-run
--      from their detail page). Tracks last_used_at + run_count so the
--      most useful queries float to the top.
--
-- Both tables: service-role only (RLS on, no policy). All writes go
-- through Admin v2 routes which already gate on requireAdmin().
-- ============================================================================

BEGIN;

-- ── 1. admin_notes ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS admin_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  parent_id   UUID REFERENCES admin_notes(id) ON DELETE CASCADE,
  body        TEXT NOT NULL CHECK (length(btrim(body)) > 0),
  created_by  TEXT NOT NULL DEFAULT 'admin',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  pinned      BOOLEAN NOT NULL DEFAULT false,
  deleted_at  TIMESTAMPTZ
);

-- Hot path: list notes for an org, newest first, pinned-first.
CREATE INDEX IF NOT EXISTS idx_admin_notes_org_pinned_created
  ON admin_notes (org_id, pinned DESC, created_at DESC)
  WHERE deleted_at IS NULL;

-- Threading: replies to a note.
CREATE INDEX IF NOT EXISTS idx_admin_notes_parent
  ON admin_notes (parent_id, created_at)
  WHERE deleted_at IS NULL;

ALTER TABLE admin_notes ENABLE ROW LEVEL SECURITY;
-- Service-role only — no policy.

COMMENT ON TABLE admin_notes IS
  'Admin-only customer notes. Threaded (parent_id), pinnable, soft-deletable. Service-role only; mutations also recorded in admin_audit_log for forensics.';

-- ── 2. admin_saved_queries ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS admin_saved_queries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label         TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  query         TEXT NOT NULL CHECK (length(btrim(query)) BETWEEN 1 AND 50000),
  notes         TEXT,
  org_id        UUID REFERENCES organisations(id) ON DELETE SET NULL,
  created_by    TEXT NOT NULL DEFAULT 'admin',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  run_count     INTEGER NOT NULL DEFAULT 0
);

-- Hot path on the Tools sidebar: most-recently-used investigations first.
CREATE INDEX IF NOT EXISTS idx_admin_saved_queries_recent
  ON admin_saved_queries (last_used_at DESC NULLS LAST, created_at DESC);

-- Per-org filter: list saved queries tied to a specific customer.
CREATE INDEX IF NOT EXISTS idx_admin_saved_queries_org
  ON admin_saved_queries (org_id, created_at DESC)
  WHERE org_id IS NOT NULL;

ALTER TABLE admin_saved_queries ENABLE ROW LEVEL SECURITY;
-- Service-role only — no policy.

COMMENT ON TABLE admin_saved_queries IS
  'Saved Tools-tab investigations. Optional org_id ties an investigation to a customer. Service-role only; every save/delete also lands in admin_audit_log.';

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT 'admin_notes'         AS object, pg_relation_size('admin_notes')         AS bytes
UNION ALL
SELECT 'admin_saved_queries' AS object, pg_relation_size('admin_saved_queries') AS bytes;

SELECT indexname FROM pg_indexes
 WHERE tablename IN ('admin_notes', 'admin_saved_queries')
 ORDER BY tablename, indexname;

COMMIT;
