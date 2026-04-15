-- ═══════════════════════════════════════════════════════════════════════════
-- BANKID SUPPORTING TABLES
-- Add to your Supabase database
-- ═══════════════════════════════════════════════════════════════════════════

-- Temporary BankID order sessions (auto-cleaned)
CREATE TABLE bankid_sessions (
  order_ref        TEXT PRIMARY KEY,
  qr_start_token   TEXT,
  qr_start_secret  TEXT,
  ip_address       INET,
  created_at       TIMESTAMPTZ DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL
);
-- Auto-delete expired sessions
CREATE INDEX idx_bankid_sessions_expires ON bankid_sessions(expires_at);

-- Extend users table with BankID fields
ALTER TABLE users ADD COLUMN IF NOT EXISTS personnummer_hash  TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_methods       TEXT[] DEFAULT '{"email"}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_bankid_login  TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS given_name         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS family_name        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bankid_cert_serial TEXT;  -- for audit log
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_needs_update BOOLEAN DEFAULT false;

-- GDPR consent records (required when processing personnummer)
CREATE TABLE gdpr_consents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL,     -- bankid_auth | data_processing | marketing
  version      TEXT NOT NULL,     -- policy version: "2026-03-01"
  given_at     TIMESTAMPTZ DEFAULT now(),
  ip_address   INET,
  user_agent   TEXT,
  withdrawn_at TIMESTAMPTZ        -- null = still active
);
CREATE INDEX idx_gdpr_consents_user ON gdpr_consents(user_id);

-- Auth event log (required for GDPR audit trail)
CREATE TABLE auth_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id),
  event_type   TEXT NOT NULL,     -- bankid_login | email_login | freja_login | logout | failed
  ip_address   INET,
  user_agent   TEXT,
  personnummer_hash TEXT,         -- only for BankID events — NEVER the plain number
  success      BOOLEAN DEFAULT true,
  error_code   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_auth_events_user ON auth_events(user_id, created_at DESC);

-- Clean up expired BankID sessions (run as a cron job)
-- DELETE FROM bankid_sessions WHERE expires_at < now();


-- ═══════════════════════════════════════════════════════════════════════════
-- ENVIRONMENT VARIABLES — add to Vercel project settings
-- ═══════════════════════════════════════════════════════════════════════════

/*

# ── DIRECT BANKID (if using direct agreement with BankID issuer) ────────────
BANKID_ENVIRONMENT=test                          # test | production
BANKID_CERT_PATH=/etc/secrets/bankid-cert.p12    # path to your .p12 certificate
BANKID_CERT_PASSPHRASE=your-cert-passphrase      # certificate passphrase
BANKID_CA_CERT_PATH=/etc/secrets/bankid-ca.crt   # BankID root CA cert

# ── SIGNICAT (recommended — no certificate required) ────────────────────────
SIGNICAT_CLIENT_ID=your-signicat-client-id
SIGNICAT_CLIENT_SECRET=your-signicat-secret
SIGNICAT_DOMAIN=yourapp.signicat.io              # your Signicat subdomain

# ── FREJA EID (if implementing Freja separately) ────────────────────────────
FREJA_CLIENT_ID=your-freja-client-id
FREJA_CLIENT_SECRET=your-freja-secret
FREJA_ENVIRONMENT=test                           # test | production

# ── SECURITY ────────────────────────────────────────────────────────────────
# CRITICAL: This secret is used to hash personnummer before storage.
# If this changes, all existing users lose their BankID link.
# Generate with: openssl rand -hex 32
PERSONNUMMER_HMAC_SECRET=your-very-long-random-secret-never-change-this

*/
