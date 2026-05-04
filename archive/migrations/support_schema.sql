-- ═══════════════════════════════════════════════════════════════════
-- COMMAND CENTER — SUPPORT SYSTEM SCHEMA
-- Run after main schema (supabase_schema.sql)
-- ═══════════════════════════════════════════════════════════════════


-- ── SUPPORT TICKETS ──────────────────────────────────────────────
CREATE TABLE support_tickets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id),
  ticket_number   SERIAL UNIQUE,          -- human-readable: #1042
  subject         TEXT NOT NULL,
  status          TEXT DEFAULT 'open'     -- open|waiting_user|waiting_support|resolved|closed
    CHECK (status IN ('open','waiting_user','waiting_support','resolved','closed')),
  priority        TEXT DEFAULT 'normal'   -- low|normal|high|urgent
    CHECK (priority IN ('low','normal','high','urgent')),
  category        TEXT DEFAULT 'general'  -- general|billing|integration|bug|feature_request
    CHECK (category IN ('general','billing','integration','bug','feature_request')),
  -- Context auto-captured from browser
  page_url        TEXT,
  browser_info    JSONB DEFAULT '{}',     -- { name, version, os, screen_resolution }
  app_version     TEXT,
  -- Diagnostic snapshot at time of ticket
  diagnostic_snapshot JSONB DEFAULT '{}', -- integration health, plan, usage at submission
  -- Internal
  assigned_to     UUID,                   -- admin user id
  resolved_at     TIMESTAMPTZ,
  satisfaction_rating INTEGER CHECK (satisfaction_rating BETWEEN 1 AND 5),
  tags            TEXT[] DEFAULT '{}',
  is_auto_created BOOLEAN DEFAULT false,  -- created by monitoring, not user
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_tickets_org    ON support_tickets(org_id);
CREATE INDEX idx_tickets_status ON support_tickets(status, created_at DESC);
CREATE INDEX idx_tickets_user   ON support_tickets(user_id);

-- Ticket messages (thread)
CREATE TABLE ticket_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('user','support','system')),
  sender_id   UUID,                       -- user_id or admin_id
  content     TEXT NOT NULL,
  content_html TEXT,                      -- sanitised HTML for rich messages
  attachments JSONB DEFAULT '[]',         -- [{ name, url, size, type }]
  is_internal BOOLEAN DEFAULT false,      -- internal note — user can't see
  is_redacted BOOLEAN DEFAULT false,      -- GDPR: content replaced with [REDACTED]
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_tmsg_ticket ON ticket_messages(ticket_id, created_at);


-- ── KNOWLEDGE BASE ────────────────────────────────────────────────
CREATE TABLE kb_articles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT UNIQUE NOT NULL,
  title        TEXT NOT NULL,
  content_md   TEXT NOT NULL,             -- Markdown content
  category     TEXT NOT NULL,
  tags         TEXT[] DEFAULT '{}',
  is_published BOOLEAN DEFAULT false,
  view_count   INTEGER DEFAULT 0,
  helpful_count    INTEGER DEFAULT 0,
  not_helpful_count INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_kb_category ON kb_articles(category, is_published);
-- Full text search
CREATE INDEX idx_kb_fts ON kb_articles
  USING gin(to_tsvector('english', title || ' ' || content_md));


-- ── AUDIT LOG ─────────────────────────────────────────────────────
-- Immutable record of ALL admin actions.
-- Critical for GDPR compliance and security.
CREATE TABLE audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Who did it
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('admin','user','system','cron')),
  actor_id     TEXT,                      -- admin email or user_id
  actor_ip     INET,
  -- What they did
  action       TEXT NOT NULL,             -- extend_trial, change_plan, impersonate, etc.
  -- On whom / what
  target_type  TEXT,                      -- org, user, ticket, system
  target_id    TEXT,
  target_name  TEXT,                      -- human-readable for display
  -- Details
  before_state JSONB,                     -- state before action
  after_state  JSONB,                     -- state after action
  metadata     JSONB DEFAULT '{}',
  -- Context
  reason       TEXT,                      -- why the action was taken
  session_id   TEXT,                      -- admin session ID
  created_at   TIMESTAMPTZ DEFAULT now()
  -- NOTE: no updated_at — audit log rows are NEVER modified
);

CREATE INDEX idx_audit_actor    ON audit_log(actor_id, created_at DESC);
CREATE INDEX idx_audit_target   ON audit_log(target_type, target_id, created_at DESC);
CREATE INDEX idx_audit_action   ON audit_log(action, created_at DESC);
CREATE INDEX idx_audit_date     ON audit_log(created_at DESC);

-- Prevent updates and deletes on audit log (immutable)
CREATE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE RULE audit_log_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;


-- ── IMPERSONATION CONSENT ─────────────────────────────────────────
-- Every impersonation session requires explicit user consent.
CREATE TABLE impersonation_consents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id),
  admin_id       TEXT NOT NULL,           -- admin email
  -- Consent lifecycle
  status         TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','expired','revoked')),
  requested_at   TIMESTAMPTZ DEFAULT now(),
  expires_at     TIMESTAMPTZ DEFAULT now() + interval '24 hours',
  responded_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  -- What was approved
  reason         TEXT,                    -- why admin needs access
  scope          TEXT[] DEFAULT '{}',     -- what they can see: ['read_data','read_tickets']
  -- Session
  session_token  TEXT UNIQUE,             -- single-use token
  session_start  TIMESTAMPTZ,
  session_end    TIMESTAMPTZ,
  -- GDPR
  consent_text   TEXT                     -- exact text shown to user at consent time
);

CREATE INDEX idx_consents_user  ON impersonation_consents(user_id, status);
CREATE INDEX idx_consents_admin ON impersonation_consents(admin_id, status);


-- ── INTEGRATION HEALTH MONITORING ────────────────────────────────
CREATE TABLE integration_health_checks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id     UUID REFERENCES businesses(id),
  provider        TEXT NOT NULL,          -- fortnox|ancon|caspeco|personalkollen
  status          TEXT NOT NULL
    CHECK (status IN ('ok','warning','error','unreachable')),
  -- Check details
  checked_at      TIMESTAMPTZ DEFAULT now(),
  response_time_ms INTEGER,
  error_code      TEXT,
  error_message   TEXT,
  -- Token info (no actual tokens stored)
  token_expires_at TIMESTAMPTZ,
  token_days_left  INTEGER,
  -- Full response for diagnostics (sanitised — no credentials)
  details         JSONB DEFAULT '{}'
);

CREATE INDEX idx_health_org      ON integration_health_checks(org_id, checked_at DESC);
CREATE INDEX idx_health_provider ON integration_health_checks(provider, status, checked_at DESC);
-- Keep only last 7 days of health checks
SELECT cron.schedule('clean-health-checks', '0 5 * * *',
  $$DELETE FROM integration_health_checks WHERE checked_at < now() - interval '7 days'$$);


-- ── SYSTEM ALERTS ─────────────────────────────────────────────────
CREATE TABLE system_alerts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level        TEXT NOT NULL CHECK (level IN ('info','warning','error','critical')),
  category     TEXT NOT NULL,             -- integration|payment|system|security|usage
  title        TEXT NOT NULL,
  body         TEXT,
  -- Affected entities
  affected_orgs INTEGER DEFAULT 0,        -- how many orgs affected
  affected_org_ids UUID[] DEFAULT '{}',
  provider     TEXT,                      -- which integration
  -- Status
  status       TEXT DEFAULT 'open'
    CHECK (status IN ('open','acknowledged','resolved')),
  acknowledged_by TEXT,
  acknowledged_at TIMESTAMPTZ,
  resolved_at  TIMESTAMPTZ,
  auto_resolve BOOLEAN DEFAULT false,     -- auto-resolved when checks pass again
  -- Notification tracking
  notified_slack  BOOLEAN DEFAULT false,
  notified_sms    BOOLEAN DEFAULT false,
  notified_at     TIMESTAMPTZ,
  -- Deduplication
  fingerprint  TEXT UNIQUE,               -- prevents duplicate alerts
  first_seen   TIMESTAMPTZ DEFAULT now(),
  last_seen    TIMESTAMPTZ DEFAULT now(),
  occurrence_count INTEGER DEFAULT 1,
  metadata     JSONB DEFAULT '{}'
);

CREATE INDEX idx_alerts_status   ON system_alerts(status, level, created_at DESC);
CREATE INDEX idx_alerts_provider ON system_alerts(provider, status);


-- ── SUPPORT CONSENT RECORDS ───────────────────────────────────────
-- GDPR: record every time support accesses user data
CREATE TABLE support_data_access (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  admin_id     TEXT NOT NULL,
  access_type  TEXT NOT NULL
    CHECK (access_type IN ('metadata_only','full_data','ticket_history','diagnostic')),
  -- What was accessed
  data_accessed TEXT[],                   -- list of data categories accessed
  justification TEXT NOT NULL,            -- required field
  ticket_id     UUID REFERENCES support_tickets(id),
  -- GDPR
  gdpr_basis    TEXT DEFAULT 'legitimate_interest'
    CHECK (gdpr_basis IN ('consent','legitimate_interest','contract','legal_obligation')),
  user_informed BOOLEAN DEFAULT false,    -- was user informed of this access
  -- Auto-deleted after retention period
  created_at    TIMESTAMPTZ DEFAULT now(),
  delete_at     TIMESTAMPTZ DEFAULT now() + interval '3 years'
);


-- ── USER ACTIVITY (for inactive user alerts) ─────────────────────
CREATE TABLE user_activity_summary (
  org_id            UUID PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  last_login        TIMESTAMPTZ,
  last_ai_query     TIMESTAMPTZ,
  last_doc_upload   TIMESTAMPTZ,
  logins_30d        INTEGER DEFAULT 0,
  ai_queries_30d    INTEGER DEFAULT 0,
  tickets_open      INTEGER DEFAULT 0,
  errors_24h        INTEGER DEFAULT 0,
  is_churning       BOOLEAN DEFAULT false,  -- 30+ days no activity
  updated_at        TIMESTAMPTZ DEFAULT now()
);


-- ── MAINTENANCE MODE ──────────────────────────────────────────────
CREATE TABLE maintenance_windows (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT NOT NULL,
  message      TEXT NOT NULL,             -- shown to users
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ,
  is_active    BOOLEAN DEFAULT false,
  affects_api  BOOLEAN DEFAULT true,
  affects_ui   BOOLEAN DEFAULT true,
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);


-- ── ADMIN SESSIONS (for 2FA tracking) ────────────────────────────
CREATE TABLE admin_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_email    TEXT NOT NULL,
  ip_address     INET NOT NULL,
  user_agent     TEXT,
  totp_verified  BOOLEAN DEFAULT false,
  created_at     TIMESTAMPTZ DEFAULT now(),
  last_active_at TIMESTAMPTZ DEFAULT now(),
  expires_at     TIMESTAMPTZ DEFAULT now() + interval '8 hours',
  revoked_at     TIMESTAMPTZ
);

CREATE INDEX idx_admin_sessions_email ON admin_sessions(admin_email, expires_at);
SELECT cron.schedule('clean-admin-sessions', '0 2 * * *',
  $$DELETE FROM admin_sessions WHERE expires_at < now()$$);


-- ═══════════════════════════════════════════════════════════════════
-- RLS POLICIES
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE support_tickets          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_articles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE impersonation_consents   ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_health_checks ENABLE ROW LEVEL SECURITY;

-- Users see only their org's tickets
CREATE POLICY "tickets_org"  ON support_tickets
  FOR ALL USING (org_id = (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid() LIMIT 1
  ));

-- Users see non-internal messages on their tickets
CREATE POLICY "tmsg_user" ON ticket_messages
  FOR SELECT USING (
    is_internal = false AND
    ticket_id IN (
      SELECT id FROM support_tickets WHERE org_id = (
        SELECT org_id FROM organisation_members WHERE user_id = auth.uid() LIMIT 1
      )
    )
  );

-- Published KB articles are public
CREATE POLICY "kb_published" ON kb_articles
  FOR SELECT USING (is_published = true);

-- Users see their own consent requests
CREATE POLICY "consents_user" ON impersonation_consents
  FOR ALL USING (user_id = auth.uid());

-- Users see their org's health checks (read-only)
CREATE POLICY "health_org_read" ON integration_health_checks
  FOR SELECT USING (
    org_id = (SELECT org_id FROM organisation_members WHERE user_id = auth.uid() LIMIT 1)
  );


-- ═══════════════════════════════════════════════════════════════════
-- HELPER FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════

-- Write-only audit log insert (called from API routes)
CREATE OR REPLACE FUNCTION write_audit_log(
  p_actor_type TEXT, p_actor_id TEXT, p_actor_ip INET,
  p_action TEXT, p_target_type TEXT, p_target_id TEXT, p_target_name TEXT,
  p_before JSONB, p_after JSONB, p_reason TEXT, p_session_id TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO audit_log (actor_type,actor_id,actor_ip,action,target_type,target_id,
    target_name,before_state,after_state,reason,session_id)
  VALUES (p_actor_type,p_actor_id,p_actor_ip,p_action,p_target_type,p_target_id,
    p_target_name,p_before,p_after,p_reason,p_session_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Upsert system alert with deduplication
CREATE OR REPLACE FUNCTION upsert_alert(
  p_level TEXT, p_category TEXT, p_title TEXT, p_body TEXT,
  p_fingerprint TEXT, p_affected_orgs INTEGER, p_provider TEXT
) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO system_alerts (level,category,title,body,fingerprint,affected_orgs,provider)
  VALUES (p_level,p_category,p_title,p_body,p_fingerprint,p_affected_orgs,p_provider)
  ON CONFLICT (fingerprint) DO UPDATE SET
    last_seen        = now(),
    occurrence_count = system_alerts.occurrence_count + 1,
    affected_orgs    = p_affected_orgs,
    status           = CASE WHEN system_alerts.status = 'resolved' THEN 'open'
                            ELSE system_alerts.status END
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
