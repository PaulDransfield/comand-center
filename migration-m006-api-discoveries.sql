-- M006 — 2026-04-15 — Session 7 — API Schema Discovery Agent
-- Run this SQL in Supabase SQL Editor to create the api_discoveries table

-- Table for API Schema Discovery Agent
CREATE TABLE IF NOT EXISTS api_discoveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID REFERENCES integrations(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  discoveries JSONB,
  suggested_mappings JSONB,
  recommendations JSONB,
  discovered_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(integration_id)
);

-- Enable Row Level Security
ALTER TABLE api_discoveries ENABLE ROW LEVEL SECURITY;

-- Create policy: users can only see discoveries for their own organisation
CREATE POLICY "api_discoveries_select_own" ON api_discoveries
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Add last_discovery_at column to integrations table
-- This tracks when each integration was last analyzed by the discovery agent
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS last_discovery_at TIMESTAMPTZ;

-- Optional: Create index for faster queries by integration_id
CREATE INDEX IF NOT EXISTS idx_api_discoveries_integration_id ON api_discoveries(integration_id);

-- Optional: Create index for faster queries by org_id
CREATE INDEX IF NOT EXISTS idx_api_discoveries_org_id ON api_discoveries(org_id);

-- Optional: Create index for faster queries by provider
CREATE INDEX IF NOT EXISTS idx_api_discoveries_provider ON api_discoveries(provider);

-- Mark as executed
-- ✅ EXECUTED 2026-04-15

-- After running this SQL, update MIGRATIONS.md:
-- 1. Change status from "⏳ PENDING" to "✅ Success"
-- 2. Add execution timestamp
-- 3. Note any issues encountered

-- Test query to verify the table was created:
-- SELECT * FROM api_discoveries LIMIT 1;

-- Test query to verify RLS is working:
-- SET session_replication_role = 'replica'; -- Disable RLS temporarily for testing
-- SELECT * FROM api_discoveries;
-- RESET session_replication_role; -- Re-enable RLS