-- ═══════════════════════════════════════════════════════════════════
-- COMMAND CENTER — COMPLETE SUPABASE SCHEMA
-- Run this entire file in Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- Order matters — run top to bottom
-- ═══════════════════════════════════════════════════════════════════

-- ── STEP 0: ENABLE EXTENSIONS ───────────────────────────────────
-- These must be enabled before creating any tables that depend on them

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";       -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";         -- crypt(), gen_salt()
CREATE EXTENSION IF NOT EXISTS "vector";           -- pgvector for RAG embeddings
CREATE EXTENSION IF NOT EXISTS "pg_cron";          -- scheduled jobs


-- ── STEP 1: CORE TENANT TABLES ──────────────────────────────────

CREATE TABLE organisations (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL,
  slug                   TEXT UNIQUE NOT NULL,
  plan                   TEXT DEFAULT 'trial' CHECK (plan IN ('trial','starter','pro','enterprise')),
  trial_start            TIMESTAMPTZ,
  trial_end              TIMESTAMPTZ,
  billing_email          TEXT,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  is_active              BOOLEAN DEFAULT true,
  metadata               JSONB DEFAULT '{}',
  created_at             TIMESTAMPTZ DEFAULT now(),
  updated_at             TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE users (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                TEXT UNIQUE NOT NULL,
  email_verified       BOOLEAN DEFAULT false,
  full_name            TEXT,
  given_name           TEXT,
  family_name          TEXT,
  personnummer_hash    TEXT UNIQUE,
  auth_methods         TEXT[] DEFAULT '{"email"}',
  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE organisation_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner','admin','viewer')),
  invited_by  UUID REFERENCES users(id),
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, user_id)
);

CREATE INDEX idx_org_members_org    ON organisation_members(org_id);
CREATE INDEX idx_org_members_user   ON organisation_members(user_id);


-- ── STEP 2: BUSINESSES (RESTAURANT LOCATIONS) ───────────────────

CREATE TABLE businesses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  type              TEXT,
  org_number        TEXT,
  address           TEXT,
  city              TEXT,
  country           TEXT DEFAULT 'SE',
  currency          TEXT DEFAULT 'SEK',
  target_food_pct   DECIMAL(5,2) DEFAULT 31.0,
  target_staff_pct  DECIMAL(5,2) DEFAULT 40.0,
  target_rent_pct   DECIMAL(5,2) DEFAULT 13.0,
  target_margin_pct DECIMAL(5,2) DEFAULT 12.0,
  colour            TEXT DEFAULT '#1C2B5E',
  is_active         BOOLEAN DEFAULT true,
  setup_complete    BOOLEAN DEFAULT false,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_businesses_org ON businesses(org_id);


-- ── STEP 3: INTEGRATIONS (ENCRYPTED CREDENTIALS) ────────────────

CREATE TABLE integrations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id       UUID REFERENCES businesses(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  status            TEXT DEFAULT 'pending' CHECK (status IN ('pending','connected','error','warning','disconnected')),
  credentials_enc   TEXT,       -- AES-256-GCM encrypted JSON
  config            JSONB DEFAULT '{}',
  token_expires_at  TIMESTAMPTZ,
  last_sync_at      TIMESTAMPTZ,
  last_error        TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE(business_id, provider)
);

CREATE INDEX idx_integrations_org      ON integrations(org_id);
CREATE INDEX idx_integrations_business ON integrations(business_id);


-- ── STEP 4: FINANCIAL TRACKER DATA ──────────────────────────────

CREATE TABLE tracker_data (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  period_year     INTEGER NOT NULL,
  period_month    INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  revenue         DECIMAL(12,2) DEFAULT 0,
  staff_cost      DECIMAL(12,2) DEFAULT 0,
  food_cost       DECIMAL(12,2) DEFAULT 0,
  rent_cost       DECIMAL(12,2) DEFAULT 0,
  other_cost      DECIMAL(12,2) DEFAULT 0,
  total_cost      DECIMAL(12,2) DEFAULT 0,
  gross_profit    DECIMAL(12,2) DEFAULT 0,
  net_profit      DECIMAL(12,2) DEFAULT 0,
  margin_pct      DECIMAL(5,2) DEFAULT 0,
  source          TEXT DEFAULT 'manual',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(business_id, period_year, period_month)
);

CREATE INDEX idx_tracker_business ON tracker_data(business_id, period_year, period_month);
CREATE INDEX idx_tracker_org      ON tracker_data(org_id);


-- ── STEP 5: DOCUMENTS AND RAG ────────────────────────────────────

CREATE TABLE notebooks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  created_by  UUID REFERENCES users(id),
  title       TEXT NOT NULL DEFAULT 'My Notebook',
  notes       TEXT,
  icon        TEXT DEFAULT '📓',
  is_shared   BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_notebooks_org ON notebooks(org_id);

CREATE TABLE notebook_documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  notebook_id    UUID NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  file_type      TEXT,
  file_size      INTEGER,
  storage_path   TEXT,           -- Supabase Storage path
  extracted_text TEXT,
  word_count     INTEGER,
  chunk_count    INTEGER DEFAULT 0,
  is_pinned      BOOLEAN DEFAULT false,
  doc_type       TEXT DEFAULT 'other',  -- invoice/p_and_l/bank_statement/budget/contract
  summary        TEXT,
  metadata       JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_docs_notebook ON notebook_documents(notebook_id);
CREATE INDEX idx_docs_org      ON notebook_documents(org_id);

-- Chunks with pgvector embeddings for semantic search
CREATE TABLE document_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  notebook_id   UUID NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  doc_id        UUID NOT NULL REFERENCES notebook_documents(id) ON DELETE CASCADE,
  doc_name      TEXT NOT NULL,
  chunk_index   INTEGER NOT NULL,
  text          TEXT NOT NULL,
  token_count   INTEGER,
  page          INTEGER,
  chunk_type    TEXT DEFAULT 'text',   -- text/table/heading/invoice_field
  section       TEXT,
  tf_idf_terms  JSONB DEFAULT '{}',    -- pre-computed TF-IDF for fast retrieval
  embedding     vector(1536),          -- OpenAI/Anthropic embedding (optional)
  is_pinned     BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_chunks_notebook ON document_chunks(notebook_id);
CREATE INDEX idx_chunks_org      ON document_chunks(org_id);
CREATE INDEX idx_chunks_doc      ON document_chunks(doc_id);
-- Full-text search index (Swedish language)
CREATE INDEX idx_chunks_fts ON document_chunks USING gin(to_tsvector('swedish', text));
-- Vector similarity index (for semantic search when embeddings available)
CREATE INDEX idx_chunks_embedding ON document_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);


-- ── STEP 6: CONVERSATIONS AND CHAT ──────────────────────────────

CREATE TABLE conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  notebook_id UUID REFERENCES notebooks(id) ON DELETE SET NULL,
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  user_id     UUID REFERENCES users(id),
  title       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_convs_org      ON conversations(org_id);
CREATE INDEX idx_convs_notebook ON conversations(notebook_id);

CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  org_id          UUID NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content         TEXT NOT NULL,
  citations       JSONB DEFAULT '[]',
  confidence      INTEGER,
  tokens_used     INTEGER,
  model           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_msgs_conversation ON messages(conversation_id);
CREATE INDEX idx_msgs_org          ON messages(org_id);

CREATE TABLE pinned_answers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  notebook_id     UUID REFERENCES notebooks(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id),
  question        TEXT,
  answer          TEXT,
  citations       JSONB DEFAULT '[]',
  created_at      TIMESTAMPTZ DEFAULT now()
);


-- ── STEP 7: AUDIO OVERVIEWS ──────────────────────────────────────

CREATE TABLE audio_overviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  notebook_id UUID NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  format      TEXT DEFAULT 'deep_dive',
  script      TEXT,
  audio_url   TEXT,
  duration    TEXT,
  focus_prompt TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);


-- ── STEP 8: AI USAGE TRACKING ────────────────────────────────────

CREATE TABLE ai_usage (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  month           TEXT NOT NULL,
  total_tokens    BIGINT DEFAULT 0,
  input_tokens    BIGINT DEFAULT 0,
  output_tokens   BIGINT DEFAULT 0,
  total_requests  INTEGER DEFAULT 0,
  total_cost_usd  DECIMAL(10,6) DEFAULT 0,
  alerted_spike   BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, month)
);

CREATE INDEX idx_ai_usage_org_month ON ai_usage(org_id, month);

CREATE TABLE ai_request_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id),
  request_type  TEXT DEFAULT 'chat',
  model         TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  total_tokens  INTEGER,
  cost_usd      DECIMAL(10,6),
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_ai_log_org ON ai_request_log(org_id, created_at DESC);


-- ── STEP 9: TRIAL + BILLING ──────────────────────────────────────

CREATE TABLE billing_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  event_type       TEXT NOT NULL,
  plan             TEXT,
  amount_ore       INTEGER,
  stripe_event_id  TEXT UNIQUE,
  metadata         JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE email_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email_type  TEXT NOT NULL,
  sent_to     TEXT NOT NULL,
  sent_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_email_log_org ON email_log(org_id, email_type, sent_at DESC);

CREATE TABLE onboarding_progress (
  org_id           UUID PRIMARY KEY REFERENCES organisations(id),
  current_step     INTEGER DEFAULT 1,
  steps_completed  INTEGER[] DEFAULT '{}',
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);


-- ── STEP 10: BANKID AUTH ─────────────────────────────────────────

CREATE TABLE bankid_sessions (
  order_ref       TEXT PRIMARY KEY,
  qr_start_token  TEXT,
  qr_start_secret TEXT,
  ip_address      INET,
  created_at      TIMESTAMPTZ DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE auth_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES users(id),
  event_type        TEXT NOT NULL,
  ip_address        INET,
  user_agent        TEXT,
  personnummer_hash TEXT,
  success           BOOLEAN DEFAULT true,
  error_code        TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_auth_events_user ON auth_events(user_id, created_at DESC);

CREATE TABLE gdpr_consents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL,
  version      TEXT NOT NULL,
  given_at     TIMESTAMPTZ DEFAULT now(),
  ip_address   INET,
  withdrawn_at TIMESTAMPTZ
);


-- ── STEP 11: EXPORT SCHEDULES ────────────────────────────────────

CREATE TABLE export_schedules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id  UUID REFERENCES businesses(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  format       TEXT DEFAULT 'pdf',
  schedule     TEXT NOT NULL,       -- cron expression: '0 7 * * 1'
  destination  TEXT DEFAULT 'email',
  email        TEXT,
  webhook_url  TEXT,
  is_active    BOOLEAN DEFAULT true,
  last_run_at  TIMESTAMPTZ,
  next_run_at  TIMESTAMPTZ,
  config       JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_schedules_org ON export_schedules(org_id);
CREATE INDEX idx_schedules_next ON export_schedules(next_run_at) WHERE is_active = true;


-- ═══════════════════════════════════════════════════════════════
-- HELPER FUNCTIONS
-- ═══════════════════════════════════════════════════════════════

-- Get current user's org_id from JWT
CREATE OR REPLACE FUNCTION current_org_id()
RETURNS UUID LANGUAGE SQL STABLE SECURITY DEFINER AS $$
  SELECT org_id FROM organisation_members
  WHERE user_id = auth.uid()
  LIMIT 1;
$$;

-- Check if current user is admin/owner in an org
CREATE OR REPLACE FUNCTION is_org_admin(check_org_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM organisation_members
    WHERE user_id = auth.uid()
      AND org_id = check_org_id
      AND role IN ('owner','admin')
  );
$$;

-- Atomic usage increment (prevents race conditions)
CREATE OR REPLACE FUNCTION increment_ai_usage(
  p_org_id        UUID,
  p_month         TEXT,
  p_tokens        INTEGER,
  p_input_tokens  INTEGER,
  p_output_tokens INTEGER,
  p_requests      INTEGER,
  p_cost_usd      DECIMAL
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ai_usage (org_id, month, total_tokens, input_tokens, output_tokens, total_requests, total_cost_usd)
  VALUES (p_org_id, p_month, p_tokens, p_input_tokens, p_output_tokens, p_requests, p_cost_usd)
  ON CONFLICT (org_id, month) DO UPDATE SET
    total_tokens    = ai_usage.total_tokens    + EXCLUDED.total_tokens,
    input_tokens    = ai_usage.input_tokens    + EXCLUDED.input_tokens,
    output_tokens   = ai_usage.output_tokens   + EXCLUDED.output_tokens,
    total_requests  = ai_usage.total_requests  + EXCLUDED.total_requests,
    total_cost_usd  = ai_usage.total_cost_usd  + EXCLUDED.total_cost_usd,
    updated_at      = now();
END;
$$;

-- Auto-update updated_at on any table
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Apply updated_at triggers
DO $$ DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['organisations','businesses','integrations','tracker_data','notebooks','conversations','ai_usage','onboarding_progress','export_schedules'])
  LOOP
    EXECUTE format('
      CREATE TRIGGER trg_updated_at_%s
      BEFORE UPDATE ON %s
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;


-- ═══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE organisations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses           ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracker_data         ENABLE ROW LEVEL SECURITY;
ALTER TABLE notebooks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE notebook_documents   ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages             ENABLE ROW LEVEL SECURITY;
ALTER TABLE pinned_answers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE audio_overviews      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage             ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_request_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_schedules     ENABLE ROW LEVEL SECURITY;

-- Organisations: members can read their own
CREATE POLICY "org_members_read"    ON organisations FOR SELECT USING (id = current_org_id());
CREATE POLICY "org_owners_update"   ON organisations FOR UPDATE USING (is_org_admin(id));

-- Users: can only see yourself
CREATE POLICY "users_self"          ON users FOR ALL USING (id = auth.uid());

-- Org membership: see your own memberships
CREATE POLICY "members_self"        ON organisation_members FOR SELECT USING (user_id = auth.uid());

-- Businesses: all members read, admins write
CREATE POLICY "biz_members_read"    ON businesses FOR SELECT USING (org_id = current_org_id());
CREATE POLICY "biz_admins_write"    ON businesses FOR ALL    USING (is_org_admin(org_id));

-- Integrations: admins only (contains credentials)
CREATE POLICY "int_admins_all"      ON integrations FOR ALL  USING (is_org_admin(org_id));

-- Tracker: members read, admins write
CREATE POLICY "tracker_read"        ON tracker_data FOR SELECT USING (org_id = current_org_id());
CREATE POLICY "tracker_write"       ON tracker_data FOR ALL    USING (is_org_admin(org_id));

-- Notebooks + documents: members full access within org
CREATE POLICY "notebooks_org"       ON notebooks            FOR ALL USING (org_id = current_org_id());
CREATE POLICY "docs_org"            ON notebook_documents   FOR ALL USING (org_id = current_org_id());
CREATE POLICY "chunks_org"          ON document_chunks      FOR ALL USING (org_id = current_org_id());
CREATE POLICY "convs_org"           ON conversations        FOR ALL USING (org_id = current_org_id());
CREATE POLICY "msgs_org"            ON messages             FOR ALL USING (org_id = current_org_id());
CREATE POLICY "pins_org"            ON pinned_answers       FOR ALL USING (org_id = current_org_id());
CREATE POLICY "audio_org"           ON audio_overviews      FOR ALL USING (org_id = current_org_id());
CREATE POLICY "schedules_org"       ON export_schedules     FOR ALL USING (org_id = current_org_id());

-- AI usage: owners/admins only
CREATE POLICY "ai_usage_admins"     ON ai_usage         FOR SELECT USING (is_org_admin(org_id));
CREATE POLICY "ai_log_admins"       ON ai_request_log   FOR SELECT USING (is_org_admin(org_id));
CREATE POLICY "billing_owners"      ON billing_events   FOR SELECT USING (
  org_id = current_org_id() AND
  EXISTS (SELECT 1 FROM organisation_members WHERE user_id = auth.uid() AND org_id = billing_events.org_id AND role = 'owner')
);


-- ═══════════════════════════════════════════════════════════════
-- SCHEDULED JOBS (pg_cron)
-- ═══════════════════════════════════════════════════════════════

-- Clean up expired BankID sessions every 10 minutes
SELECT cron.schedule('clean-bankid-sessions', '*/10 * * * *',
  $$DELETE FROM bankid_sessions WHERE expires_at < now()$$);

-- Clean up old AI request logs (keep 90 days)
SELECT cron.schedule('clean-ai-logs', '0 3 * * *',
  $$DELETE FROM ai_request_log WHERE created_at < now() - interval '90 days'$$);

-- Clean up old auth events (keep 12 months)
SELECT cron.schedule('clean-auth-events', '0 4 * * 0',
  $$DELETE FROM auth_events WHERE created_at < now() - interval '12 months'$$);


-- ═══════════════════════════════════════════════════════════════
-- SEED: Demo organisation for development
-- Comment this out before running in production
-- ═══════════════════════════════════════════════════════════════

/*
-- Create a demo org to test with
INSERT INTO organisations (id, name, slug, plan, trial_start, trial_end, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Vero Italiano AB',
  'vero-italiano',
  'trial',
  now(),
  now() + interval '30 days',
  true
);
*/


-- ── STEP 12: STORAGE BUCKETS ─────────────────────────────────────
-- Run this after creating your Supabase project

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('documents', 'documents', false, 52428800,
   ARRAY['application/pdf',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'text/csv','text/plain','image/jpeg','image/png','image/webp']),
  ('reports',   'reports',   false, 10485760,
   ARRAY['application/pdf',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: tenants can only access their own org's folder
CREATE POLICY "org_documents_access" ON storage.objects
  FOR ALL USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = current_org_id()::text
  );

CREATE POLICY "org_reports_access" ON storage.objects
  FOR ALL USING (
    bucket_id = 'reports'
    AND (storage.foldername(name))[1] = current_org_id()::text
  );
