-- M012-orphan-tables.sql
-- Documents every table that code reads/writes but never had a formal migration.
-- Each CREATE TABLE IF NOT EXISTS is conservative — it reproduces the shape
-- production has drifted into, so a fresh Supabase project comes up compatible.
--
-- Columns marked NULLABLE here may actually be NOT NULL in production; adjust
-- after inspecting `information_schema.columns` on the live project.

-- ── billing_events ────────────────────────────────────────────────────────────
-- Stripe webhook writes here. One row per subscription state change.
CREATE TABLE IF NOT EXISTS public.billing_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  stripe_event_id text,
  event_type     text NOT NULL,
  amount         integer,
  currency       text DEFAULT 'sek',
  status         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  metadata       jsonb
);
CREATE INDEX IF NOT EXISTS billing_events_org_idx ON public.billing_events (org_id, created_at DESC);
ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;

-- ── invoices + invoices_with_status view ─────────────────────────────────────
-- Fortnox invoice mirror. invoices_with_status is a view that layers
-- a computed 'status' column on top of raw invoices.
CREATE TABLE IF NOT EXISTS public.invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  business_id    uuid,
  vendor_name    text,
  amount         numeric,
  vat_amount     numeric,
  total_amount   numeric,
  invoice_date   date,
  due_date       date,
  invoice_number text,
  category       text,
  line_items     jsonb,
  doc_url        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz
);
CREATE INDEX IF NOT EXISTS invoices_org_idx ON public.invoices (org_id, due_date DESC);
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

-- ── feature_flags ─────────────────────────────────────────────────────────────
-- Per-org toggles. Used by agents to honour customer opt-outs.
CREATE TABLE IF NOT EXISTS public.feature_flags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  flag       text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  notes      text,
  set_by     text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, flag)
);
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

-- ── support_notes / support_tickets ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.support_notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  note       text NOT NULL,
  author     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_notes_org_idx ON public.support_notes (org_id, created_at DESC);
ALTER TABLE public.support_notes ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  title       text,
  status      text,
  priority    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz
);
CREATE INDEX IF NOT EXISTS support_tickets_org_idx ON public.support_tickets (org_id, created_at DESC);
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

-- ── supplier_mappings ─────────────────────────────────────────────────────────
-- Customer-defined rules that map Fortnox supplier names to cost categories.
CREATE TABLE IF NOT EXISTS public.supplier_mappings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  vendor_contains text NOT NULL,
  category        text NOT NULL,
  category_label  text,
  priority        integer DEFAULT 100,
  is_active       boolean DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_mappings_org_idx ON public.supplier_mappings (org_id, priority DESC);
ALTER TABLE public.supplier_mappings ENABLE ROW LEVEL SECURITY;

-- ── pk_sale_forecasts ─────────────────────────────────────────────────────────
-- Personalkollen sales forecasts pulled from their API (rare-used).
CREATE TABLE IF NOT EXISTS public.pk_sale_forecasts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  business_id   uuid,
  forecast_date date NOT NULL,
  amount        numeric,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pk_sale_forecasts_org_biz_date_idx
  ON public.pk_sale_forecasts (org_id, business_id, forecast_date);
ALTER TABLE public.pk_sale_forecasts ENABLE ROW LEVEL SECURITY;

-- ── financial_logs ────────────────────────────────────────────────────────────
-- Aggregate financial events. May be deprecated in favour of monthly_metrics.
CREATE TABLE IF NOT EXISTS public.financial_logs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  business_id uuid,
  period_year  integer,
  period_month integer,
  metric     text,
  value      numeric,
  source     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS financial_logs_org_idx ON public.financial_logs (org_id, period_year, period_month);
ALTER TABLE public.financial_logs ENABLE ROW LEVEL SECURITY;

-- ── api_credentials / api_probe_results / integration_health_checks ─────────
-- Tables used by the Enhanced API Discovery and health-check crons.
CREATE TABLE IF NOT EXISTS public.api_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid,
  provider       text NOT NULL,
  credentials_enc text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.api_credentials ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.api_probe_results (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid,
  integration_id uuid,
  endpoint       text,
  status_code    integer,
  latency_ms     integer,
  response_body  jsonb,
  probed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_probe_results_org_idx ON public.api_probe_results (org_id, probed_at DESC);
ALTER TABLE public.api_probe_results ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.integration_health_checks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  business_id     uuid,
  integration_id  uuid,
  provider        text NOT NULL,
  status          text NOT NULL,
  response_time_ms integer,
  error_code      text,
  error_message   text,
  token_days_left integer,
  checked_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integration_health_org_idx
  ON public.integration_health_checks (org_id, checked_at DESC);
ALTER TABLE public.integration_health_checks ENABLE ROW LEVEL SECURITY;

-- ── pos_connections ───────────────────────────────────────────────────────────
-- Legacy table, pre-integrations. Kept for migration compat; not written by
-- the new code paths but still read by /api/covers.
CREATE TABLE IF NOT EXISTS public.pos_connections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  business_id  uuid,
  provider     text,
  status       text,
  last_sync_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pos_connections ENABLE ROW LEVEL SECURITY;

-- ── sync_log ──────────────────────────────────────────────────────────────────
-- One row per sync run. Feeds /admin/health + customer-facing "Last sync" UI.
-- Production has drifted — this table may already exist without the newer columns.
-- Use ALTER TABLE … ADD COLUMN IF NOT EXISTS for every column so the indexes below
-- can reference them regardless of the prior schema state.
CREATE TABLE IF NOT EXISTS public.sync_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  provider        text NOT NULL,
  status          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sync_log ADD COLUMN IF NOT EXISTS business_id     uuid;
ALTER TABLE public.sync_log ADD COLUMN IF NOT EXISTS integration_id  uuid;
ALTER TABLE public.sync_log ADD COLUMN IF NOT EXISTS records_synced  integer;
ALTER TABLE public.sync_log ADD COLUMN IF NOT EXISTS date_from       date;
ALTER TABLE public.sync_log ADD COLUMN IF NOT EXISTS date_to         date;
ALTER TABLE public.sync_log ADD COLUMN IF NOT EXISTS error_msg       text;
ALTER TABLE public.sync_log ADD COLUMN IF NOT EXISTS duration_ms     integer;

CREATE INDEX IF NOT EXISTS sync_log_org_idx ON public.sync_log (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sync_log_integration_idx ON public.sync_log (integration_id, created_at DESC);
ALTER TABLE public.sync_log ENABLE ROW LEVEL SECURITY;

-- ── customer_health_scores ────────────────────────────────────────────────────
-- Weekly risk-scoring agent output.
CREATE TABLE IF NOT EXISTS public.customer_health_scores (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  score          integer,                   -- 0-100
  risk_level     text,                      -- low | medium | high | critical
  signals        jsonb,                     -- per-dimension breakdown
  recommendations text,
  computed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_health_org_idx
  ON public.customer_health_scores (org_id, computed_at DESC);
ALTER TABLE public.customer_health_scores ENABLE ROW LEVEL SECURITY;

-- ── ai_usage / ai_request_log ────────────────────────────────────────────────
-- Monthly aggregates and per-request log for AI spend tracking.
CREATE TABLE IF NOT EXISTS public.ai_usage (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  month           date NOT NULL,
  total_tokens    bigint DEFAULT 0,
  total_requests  integer DEFAULT 0,
  total_cost_usd  numeric DEFAULT 0,
  UNIQUE (org_id, month)
);
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.ai_request_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  user_id        uuid,
  request_type   text,                     -- ask | budget_generate | anomaly_explain ...
  model          text,
  input_tokens   integer,
  output_tokens  integer,
  total_cost_usd numeric,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_request_log_org_idx
  ON public.ai_request_log (org_id, created_at DESC);
ALTER TABLE public.ai_request_log ENABLE ROW LEVEL SECURITY;

-- ── export_schedules ──────────────────────────────────────────────────────────
-- Scheduled exports (PDF / CSV) — referenced by /api/stripe/usage.
CREATE TABLE IF NOT EXISTS public.export_schedules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  schedule   text,                          -- cron expression
  format     text,                          -- pdf | csv
  target     text,                          -- email | webhook url
  is_active  boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.export_schedules ENABLE ROW LEVEL SECURITY;

-- ── notebook_documents ────────────────────────────────────────────────────────
-- Customer-saved AI artifacts (reports, exports). Mostly dead post-/notebook deprecation
-- but still referenced by /api/stripe/usage count.
CREATE TABLE IF NOT EXISTS public.notebook_documents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  user_id    uuid,
  title      text,
  content    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.notebook_documents ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.sync_log IS
  'One row per sync run. Expected to live for ~90 days then get rotated. Source for /admin/health feed.';
