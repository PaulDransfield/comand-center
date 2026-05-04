-- ═══════════════════════════════════════════════════════════════════════════
-- INTEGRATIONS DATABASE SCHEMA
-- Run in Supabase SQL editor
-- ═══════════════════════════════════════════════════════════════════════════

-- Main integrations table (already in SAAS_MANIFEST, included here with additions)
CREATE TABLE IF NOT EXISTS integrations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id         UUID REFERENCES businesses(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,
  status              TEXT DEFAULT 'pending' CHECK (status IN ('pending','connected','error','warning','disconnected')),
  -- Encrypted credentials (AES-256-GCM, base64 encoded)
  credentials_enc     TEXT,    -- JSON: { field_key: "enc:base64..." }
  -- Non-sensitive config stored plain
  config              JSONB DEFAULT '{}',
  -- OAuth tokens stored separately for fast expiry checks
  token_expires_at    TIMESTAMPTZ,
  -- Sync tracking
  last_sync_at        TIMESTAMPTZ,
  last_error          TEXT,
  sync_frequency_mins INTEGER DEFAULT 60,
  -- Webhook
  webhook_url         TEXT,
  webhook_secret_enc  TEXT,    -- encrypted webhook secret
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE(business_id, provider)
);

-- Integration sync log (every sync attempt recorded)
CREATE TABLE integration_sync_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  org_id          UUID NOT NULL,
  provider        TEXT NOT NULL,
  success         BOOLEAN NOT NULL,
  records_synced  INTEGER DEFAULT 0,
  error_message   TEXT,
  duration_ms     INTEGER,
  synced_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_sync_log_integration ON integration_sync_log(integration_id, synced_at DESC);
CREATE INDEX idx_sync_log_org ON integration_sync_log(org_id, synced_at DESC);

-- RLS policies
ALTER TABLE integrations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins_manage_integrations" ON integrations
  FOR ALL USING (
    EXISTS (SELECT 1 FROM organisation_members
      WHERE user_id = auth.uid() AND org_id = integrations.org_id AND role IN ('owner','admin'))
  );

CREATE POLICY "members_read_sync_log" ON integration_sync_log
  FOR SELECT USING (
    org_id IN (SELECT org_id FROM organisation_members WHERE user_id = auth.uid())
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- ENCRYPTION KEY SETUP — DO THIS BEFORE ADDING ANY CREDENTIALS
-- ═══════════════════════════════════════════════════════════════════════════

/*
STEP 1: Generate your encryption key

  Run this in a terminal (Node.js required):
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

  Example output (DO NOT use this — generate your own):
  a3f8b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1

STEP 2: Add to Vercel environment variables

  vercel.com → your project → Settings → Environment Variables

  Name:  CREDENTIAL_ENCRYPTION_KEY
  Value: [your 64-character hex string from Step 1]
  Environment: Production, Preview, Development

STEP 3: Verify locally

  Create .env.local in your project root:
  CREDENTIAL_ENCRYPTION_KEY=your64charhexstring

  Test encryption works:
  node -e "
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'your64charhexstring';
    const {encrypt, decrypt} = require('./lib/integrations/credential-encryption.js');
    const enc = encrypt('test-secret');
    const dec = decrypt(enc);
    console.log('Encrypt/decrypt OK:', dec === 'test-secret');
  "

STEP 4: Rotate the key (if ever compromised)

  WARNING: Rotating the key means ALL stored credentials become unreadable.
  Every user will need to re-enter their integration credentials.

  To rotate:
  1. Export all credentials (decrypt with old key)
  2. Generate new key
  3. Re-encrypt all credentials with new key
  4. Update environment variable
  5. Deploy

  We recommend a key rotation script in scripts/rotate-encryption-key.js

CRITICAL RULES:
  ✗ Never commit CREDENTIAL_ENCRYPTION_KEY to git
  ✗ Never log encrypted values
  ✗ Never expose the raw key to the frontend
  ✗ Never store the key in the database
  ✓ Back up the key in a password manager (1Password, Bitwarden)
  ✓ Use different keys for development and production
*/


-- ═══════════════════════════════════════════════════════════════════════════
-- ENVIRONMENT VARIABLES for integration-manager.js
-- ═══════════════════════════════════════════════════════════════════════════

/*

# ── ENCRYPTION (REQUIRED) ───────────────────────────────────────────────────
CREDENTIAL_ENCRYPTION_KEY=your64charhexstring    # 32 random bytes as hex

# ── FORTNOX ────────────────────────────────────────────────────────────────
# Your app's Fortnox credentials (not per-customer — these are YOUR developer app)
# Apply at: developer.fortnox.se
FORTNOX_APP_CLIENT_ID=your-fortnox-app-client-id
FORTNOX_APP_CLIENT_SECRET=your-fortnox-app-client-secret
FORTNOX_REDIRECT_URI=https://commandcenter.se/api/auth/callback/fortnox

# ── CASPECO ────────────────────────────────────────────────────────────────
# Caspeco uses per-customer API keys — no app-level credentials needed.
# Each customer gets their own key from Caspeco Administration.
# See: https://developer.caspeco.se/authentication

# ── PERSONALKOLLEN ─────────────────────────────────────────────────────────
# Per-customer API keys. Customer gets key from Personalkollen settings.
# Docs: https://personalkollen.se/api-dokumentation

# ── ZETTLE (PayPal) ────────────────────────────────────────────────────────
# Apply for developer access at developer.zettle.com
ZETTLE_APP_CLIENT_ID=your-zettle-client-id
ZETTLE_APP_CLIENT_SECRET=your-zettle-client-secret
ZETTLE_REDIRECT_URI=https://commandcenter.se/api/auth/callback/zettle

# ── ANCON ──────────────────────────────────────────────────────────────────
# Contact Ancon directly for API documentation: kontakt@ancon.se
# Their API uses per-customer API keys

*/


-- ═══════════════════════════════════════════════════════════════════════════
-- CASPECO API REFERENCE
-- Documented endpoints for staff scheduling integration
-- ═══════════════════════════════════════════════════════════════════════════

/*

BASE URL: https://api.caspeco.se/v2 (or v3 for newer accounts)
AUTH:     Bearer token (API key from Caspeco Administration)

Key endpoints for Command Center:

GET /companies/{company_id}
  → Company info and verification (used for connection test)

GET /companies/{company_id}/units
  → List all units/locations

GET /companies/{company_id}/schedules?from=YYYY-MM-DD&to=YYYY-MM-DD
  → Staff schedules for a date range
  Returns: { schedules: [{ employeeId, unitId, startTime, endTime, shiftCost }] }

GET /companies/{company_id}/payroll?from=YYYY-MM-DD&to=YYYY-MM-DD
  → Payroll data for a period
  Returns: { totalCost, totalHours, employeeCount, averageHourlyCost, breakdown: [] }

GET /companies/{company_id}/employees
  → Employee list (use for headcount tracking)

Contact: api@caspeco.se for API access and documentation


═══════════════════════════════════════════════════════════════════════════
PERSONALKOLLEN API REFERENCE
═══════════════════════════════════════════════════════════════════════════

BASE URL: https://api.personalkollen.se/v1
AUTH:     X-API-Key header

Key endpoints:

GET /accounts/{account_id}
  → Account verification (connection test)

GET /accounts/{account_id}/timereports?from=YYYY-MM-DD&to=YYYY-MM-DD
  → Time reports for a period
  Returns: { timereports: [{ employeeId, date, regularHours, overtimeHours, totalHours }] }

GET /accounts/{account_id}/salaries?month=YYYY-MM
  → Salary data for a month
  Returns: { totalGrossSalary, totalEmployerCost, employeeCount }

GET /accounts/{account_id}/employees
  → Employee list

Contact: support@personalkollen.se for API access

*/
