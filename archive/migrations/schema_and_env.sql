-- ═══════════════════════════════════════════════════════════════════════════
-- TRIAL SYSTEM — SUPPORTING DATABASE TABLES
-- Run these in your Supabase SQL editor after the main schema from SAAS_MANIFEST
-- ═══════════════════════════════════════════════════════════════════════════

-- Billing event log (every Stripe event recorded here)
CREATE TABLE billing_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  event_type       TEXT NOT NULL,   -- subscription_activated | payment_failed | subscription_cancelled
  plan             TEXT,
  amount_sek       INTEGER,         -- amount in öre (1 kr = 100 öre)
  stripe_event_id  TEXT UNIQUE,     -- deduplicate webhook replays
  metadata         JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_billing_events_org ON billing_events(org_id, created_at DESC);

-- Email send log (prevents duplicate emails)
CREATE TABLE email_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email_type  TEXT NOT NULL,   -- 7_days | 3_days | 1_day | expired | grace_3_days | grace_1_day
  sent_to     TEXT NOT NULL,
  sent_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_email_log_org ON email_log(org_id, email_type, sent_at DESC);

-- Admin action log (audit trail for extend/revoke actions)
CREATE TABLE admin_actions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID REFERENCES users(id),
  org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,   -- extend_trial | revoke_access | change_plan
  before_val  JSONB,
  after_val   JSONB,
  reason      TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ── ROW LEVEL SECURITY ──────────────────────────────────────────────────────

-- Enable RLS on all tables
ALTER TABLE organisations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses           ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents            ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages             ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracker_data         ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_log            ENABLE ROW LEVEL SECURITY;

-- Helper function: get current user's org_id from JWT
CREATE OR REPLACE FUNCTION current_org_id()
RETURNS UUID AS $$
  SELECT (
    SELECT org_id FROM organisation_members
    WHERE user_id = auth.uid()
    LIMIT 1
  );
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- Helper function: check if current user is admin/owner
CREATE OR REPLACE FUNCTION is_org_admin(check_org_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM organisation_members
    WHERE user_id = auth.uid()
    AND org_id = check_org_id
    AND role IN ('owner', 'admin')
  );
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- Organisations: members can read their own org
CREATE POLICY "members_read_own_org" ON organisations
  FOR SELECT USING (id = current_org_id());

CREATE POLICY "owners_update_own_org" ON organisations
  FOR UPDATE USING (is_org_admin(id));

-- Businesses: all members can read, admins can write
CREATE POLICY "members_read_businesses" ON businesses
  FOR SELECT USING (org_id = current_org_id());

CREATE POLICY "admins_write_businesses" ON businesses
  FOR ALL USING (is_org_admin(org_id));

-- Documents: all members can read, admins can write
CREATE POLICY "members_read_documents" ON documents
  FOR SELECT USING (org_id = current_org_id());

CREATE POLICY "members_upload_documents" ON documents
  FOR INSERT WITH CHECK (org_id = current_org_id());

CREATE POLICY "admins_delete_documents" ON documents
  FOR DELETE USING (is_org_admin(org_id));

-- Conversations + messages: each user sees their own + org shared
CREATE POLICY "members_read_conversations" ON conversations
  FOR SELECT USING (org_id = current_org_id());

CREATE POLICY "members_write_conversations" ON conversations
  FOR INSERT WITH CHECK (org_id = current_org_id());

CREATE POLICY "members_read_messages" ON messages
  FOR SELECT USING (org_id = current_org_id());

CREATE POLICY "members_write_messages" ON messages
  FOR INSERT WITH CHECK (org_id = current_org_id());

-- Tracker data: all members read, admins write
CREATE POLICY "members_read_tracker" ON tracker_data
  FOR SELECT USING (org_id = current_org_id());

CREATE POLICY "admins_write_tracker" ON tracker_data
  FOR ALL USING (is_org_admin(org_id));

-- Integrations: admins only (contains sensitive config)
CREATE POLICY "admins_manage_integrations" ON integrations
  FOR ALL USING (is_org_admin(org_id));

-- Billing: owners only
CREATE POLICY "owners_read_billing" ON billing_events
  FOR SELECT USING (
    org_id = current_org_id() AND
    EXISTS (
      SELECT 1 FROM organisation_members
      WHERE user_id = auth.uid() AND org_id = billing_events.org_id AND role = 'owner'
    )
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- ENVIRONMENT VARIABLES
-- Add these to your Vercel project: Settings → Environment Variables
-- ═══════════════════════════════════════════════════════════════════════════

/*

# ── SUPABASE ────────────────────────────────────────────────────
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...          (from Supabase → Settings → API)
SUPABASE_SERVICE_ROLE_KEY=eyJ...              (NEVER expose to browser — server only)

# ── STRIPE ──────────────────────────────────────────────────────
STRIPE_SECRET_KEY=sk_live_...                 (or sk_test_... for testing)
STRIPE_WEBHOOK_SECRET=whsec_...              (from Stripe → Webhooks → signing secret)
STRIPE_PRICE_STARTER=price_...               (from Stripe → Products → Starter plan)
STRIPE_PRICE_PRO=price_...                   (from Stripe → Products → Pro plan)
STRIPE_PRICE_ENTERPRISE=price_...

# ── EMAIL (Resend) ───────────────────────────────────────────────
RESEND_API_KEY=re_...                         (from resend.com → API Keys)

# ── APP ─────────────────────────────────────────────────────────
NEXT_PUBLIC_APP_URL=https://commandcenter.se  (your production URL)
CRON_SECRET=your-random-secret-here           (any random string — protects cron endpoint)

# ── AI ──────────────────────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-...                  (from console.anthropic.com)

*/


-- ═══════════════════════════════════════════════════════════════════════════
-- STRIPE SETUP CHECKLIST
-- Do these steps in the Stripe Dashboard before going live
-- ═══════════════════════════════════════════════════════════════════════════

/*

1. Create a Stripe account at stripe.com
   → Use test mode first (toggle in top-left)

2. Create products and prices:
   Dashboard → Products → Add product
   - Name: "Command Center Starter"
   - Price: 499 kr/month (recurring)
   - Copy the Price ID (price_xxx) → set as STRIPE_PRICE_STARTER

   Repeat for Pro (999 kr/month) and Enterprise (custom)

3. Set up webhook:
   Dashboard → Webhooks → Add endpoint
   - URL: https://commandcenter.se/api/webhooks/stripe
   - Events to listen for:
     ✓ checkout.session.completed
     ✓ customer.subscription.deleted
     ✓ invoice.payment_failed
   - Copy the signing secret → set as STRIPE_WEBHOOK_SECRET

4. Enable Swedish payment methods:
   Dashboard → Settings → Payment methods
   - Enable: Cards, Swish (when available in Stripe SE)

5. Set up tax:
   Dashboard → Tax → Enable automatic tax collection
   - This handles Swedish VAT (25%) automatically

6. Test the full flow:
   - Use test card: 4242 4242 4242 4242, any future date, any CVC
   - Verify webhook fires and org plan updates in Supabase

*/


-- ═══════════════════════════════════════════════════════════════════════════
-- VERCEL CRON JOB CONFIGURATION
-- Add this to vercel.json in your project root
-- ═══════════════════════════════════════════════════════════════════════════

/*

{
  "crons": [
    {
      "path": "/api/cron/trial-emails",
      "schedule": "0 9 * * *"
    }
  ]
}

This runs the trial email sender every day at 09:00 UTC (11:00 Swedish time).
Note: Cron jobs require Vercel Pro plan ($20/month) or higher.
Alternative: Use Supabase Edge Functions with pg_cron (included in Supabase free tier).

*/
