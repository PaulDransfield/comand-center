-- ═══════════════════════════════════════════════════════════════════════════
-- AI SYSTEM DATABASE SCHEMA
-- Run in Supabase SQL editor
-- ═══════════════════════════════════════════════════════════════════════════

-- ── NOTEBOOKS ───────────────────────────────────────────────────────────────
CREATE TABLE notebooks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  created_by  UUID REFERENCES users(id),
  title       TEXT NOT NULL DEFAULT 'My Notebook',
  description TEXT,
  is_shared   BOOLEAN DEFAULT false,
  notes       TEXT,      -- user's personal notes/annotations
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_notebooks_org ON notebooks(org_id);

-- ── NOTEBOOK DOCUMENTS ──────────────────────────────────────────────────────
CREATE TABLE notebook_documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  notebook_id    UUID NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  file_type      TEXT,
  file_size      INTEGER,
  storage_path   TEXT,        -- Supabase Storage path
  extracted_text TEXT,        -- full plain text (for search/display)
  word_count     INTEGER,
  char_count     INTEGER,
  chunk_count    INTEGER DEFAULT 0,
  is_pinned      BOOLEAN DEFAULT false,
  summary        TEXT,        -- AI-generated summary
  summary_facts  JSONB,       -- key facts extracted
  metadata       JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_notebook_docs_notebook ON notebook_documents(notebook_id);
CREATE INDEX idx_notebook_docs_org ON notebook_documents(org_id);

-- ── DOCUMENT CHUNKS (the RAG index) ─────────────────────────────────────────
CREATE TABLE document_chunks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  notebook_id  UUID NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  doc_id       UUID NOT NULL REFERENCES notebook_documents(id) ON DELETE CASCADE,
  doc_name     TEXT NOT NULL,
  chunk_index  INTEGER NOT NULL,
  text         TEXT NOT NULL,
  token_count  INTEGER,
  page         INTEGER,
  tf_idf_terms JSONB DEFAULT '{}',   -- pre-computed term frequencies
  is_pinned    BOOLEAN DEFAULT false, -- inherit from parent doc
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_chunks_notebook ON document_chunks(notebook_id);
CREATE INDEX idx_chunks_org ON document_chunks(org_id);
CREATE INDEX idx_chunks_doc ON document_chunks(doc_id);
-- Full text search index
CREATE INDEX idx_chunks_fts ON document_chunks USING gin(to_tsvector('swedish', text));

-- ── AUDIO OVERVIEWS ──────────────────────────────────────────────────────────
CREATE TABLE audio_overviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  notebook_id UUID NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  format      TEXT DEFAULT 'deep_dive',  -- deep_dive|brief|debate|critique
  script      TEXT,                       -- the generated script
  audio_url   TEXT,                       -- if TTS was applied
  duration    TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_audio_overviews_notebook ON audio_overviews(notebook_id);

-- ── AI USAGE TRACKING ────────────────────────────────────────────────────────
-- Monthly aggregates (fast limit checks)
CREATE TABLE ai_usage (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  month           TEXT NOT NULL,          -- format: '2026-03'
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

-- Individual request log (for debugging and billing disputes)
CREATE TABLE ai_request_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id),
  request_type  TEXT DEFAULT 'chat',   -- chat|summarise|audio_script|study_guide|quiz
  model         TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  total_tokens  INTEGER,
  cost_usd      DECIMAL(10,6),
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_ai_log_org ON ai_request_log(org_id, created_at DESC);
-- Keep log for 90 days only (GDPR + cost)
-- Add a pg_cron job: DELETE FROM ai_request_log WHERE created_at < now() - interval '90 days';


-- ── STORED PROCEDURE: increment usage atomically ─────────────────────────────
CREATE OR REPLACE FUNCTION increment_ai_usage(
  p_org_id        UUID,
  p_month         TEXT,
  p_tokens        INTEGER,
  p_input_tokens  INTEGER,
  p_output_tokens INTEGER,
  p_requests      INTEGER,
  p_cost_usd      DECIMAL
) RETURNS void AS $$
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
$$ LANGUAGE plpgsql;


-- ── RLS POLICIES ─────────────────────────────────────────────────────────────
ALTER TABLE notebooks          ENABLE ROW LEVEL SECURITY;
ALTER TABLE notebook_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE audio_overviews    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_request_log     ENABLE ROW LEVEL SECURITY;

-- Members can read/write their org's notebooks
CREATE POLICY "members_notebooks" ON notebooks
  FOR ALL USING (org_id IN (SELECT org_id FROM organisation_members WHERE user_id = auth.uid()));

CREATE POLICY "members_documents" ON notebook_documents
  FOR ALL USING (org_id IN (SELECT org_id FROM organisation_members WHERE user_id = auth.uid()));

CREATE POLICY "members_chunks" ON document_chunks
  FOR ALL USING (org_id IN (SELECT org_id FROM organisation_members WHERE user_id = auth.uid()));

-- Owners can see usage/billing
CREATE POLICY "owners_ai_usage" ON ai_usage
  FOR SELECT USING (
    org_id IN (
      SELECT org_id FROM organisation_members
      WHERE user_id = auth.uid() AND role IN ('owner','admin')
    )
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- ENVIRONMENT VARIABLES
-- ═══════════════════════════════════════════════════════════════════════════
/*

# ── ANTHROPIC (YOUR KEY — NEVER EXPOSE TO FRONTEND) ────────────────────────
ANTHROPIC_API_KEY=sk-ant-api03-...

# ── AI COST ALERTS ──────────────────────────────────────────────────────────
# Alert me when any org exceeds this % of monthly limit
AI_SPIKE_ALERT_THRESHOLD=80

# Monthly cost alert for your whole account (in USD)
AI_MONTHLY_COST_ALERT_USD=100

# ── OPTIONAL: ElevenLabs TTS (for actual audio, not just scripts) ───────────
# Free tier: 10,000 characters/month
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_VOICE_ID_HOST1=pNInz6obpgDQGcFmaJgB  # Adam
ELEVENLABS_VOICE_ID_HOST2=EXAVITQu4vr4xnSDxMaL  # Bella

*/


-- ═══════════════════════════════════════════════════════════════════════════
-- ADMIN: VIEW ALL ORG USAGE (for your admin dashboard)
-- ═══════════════════════════════════════════════════════════════════════════
/*
SELECT
  o.name                                    AS org_name,
  o.plan,
  u.month,
  u.total_tokens,
  u.total_requests,
  ROUND(u.total_cost_usd::numeric, 4)       AS cost_usd,
  ROUND((u.total_tokens::numeric / CASE
    WHEN o.plan = 'trial'   THEN 500000
    WHEN o.plan = 'starter' THEN 2000000
    WHEN o.plan = 'pro'     THEN 10000000
    ELSE 99999999 END * 100), 1)            AS pct_of_limit
FROM ai_usage u
JOIN organisations o ON o.id = u.org_id
WHERE u.month = TO_CHAR(NOW(), 'YYYY-MM')
ORDER BY u.total_tokens DESC;
*/
