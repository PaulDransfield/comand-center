-- M013-ai-tracking.sql
-- Airtight AI usage + cost tracking. Every Claude call writes a row; every
-- purchase of the AI Booster add-on gets tracked so the daily cap reflects it.

-- ── ai_request_log — one row per Claude API call ─────────────────────────────
-- M012 created this table; we extend it so admin can see what each call cost.
ALTER TABLE public.ai_request_log ADD COLUMN IF NOT EXISTS user_id          uuid;
ALTER TABLE public.ai_request_log ADD COLUMN IF NOT EXISTS tier             text;
ALTER TABLE public.ai_request_log ADD COLUMN IF NOT EXISTS page             text;
ALTER TABLE public.ai_request_log ADD COLUMN IF NOT EXISTS question_preview text;     -- first 100 chars
ALTER TABLE public.ai_request_log ADD COLUMN IF NOT EXISTS cost_sek         numeric;
ALTER TABLE public.ai_request_log ADD COLUMN IF NOT EXISTS duration_ms      integer;

CREATE INDEX IF NOT EXISTS ai_request_log_org_created_idx
  ON public.ai_request_log (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_request_log_user_created_idx
  ON public.ai_request_log (user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- ── ai_booster_purchases — Stripe webhook writes here when an org buys Booster
-- Booster: +100 queries/day for the billing period. Pricing: 299 kr/month.
CREATE TABLE IF NOT EXISTS public.ai_booster_purchases (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL,
  stripe_invoice_id      text,
  stripe_subscription_id text,
  period_start           date NOT NULL,
  period_end             date NOT NULL,
  extra_queries_per_day  integer NOT NULL DEFAULT 100,
  amount_sek             integer NOT NULL DEFAULT 299,
  currency               text NOT NULL DEFAULT 'sek',
  status                 text NOT NULL DEFAULT 'active',         -- active | cancelled | expired
  created_at             timestamptz NOT NULL DEFAULT now(),
  cancelled_at           timestamptz
);
CREATE INDEX IF NOT EXISTS ai_booster_org_period_idx
  ON public.ai_booster_purchases (org_id, period_end DESC);
CREATE INDEX IF NOT EXISTS ai_booster_active_idx
  ON public.ai_booster_purchases (org_id) WHERE status = 'active';
ALTER TABLE public.ai_booster_purchases ENABLE ROW LEVEL SECURITY;

-- ── ai_usage_daily_by_user — per-user attribution within an org ─────────────
-- The daily cap stays org-wide (lib/ai/usage.ts ai_usage_daily), this table is
-- for admin visibility: "who in this org is using their AI quota?"
CREATE TABLE IF NOT EXISTS public.ai_usage_daily_by_user (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  user_id     uuid,
  date        date NOT NULL DEFAULT CURRENT_DATE,
  query_count integer DEFAULT 0,
  cost_usd    numeric DEFAULT 0,
  cost_sek    numeric DEFAULT 0,
  updated_at  timestamptz DEFAULT now(),
  UNIQUE (org_id, user_id, date)
);
CREATE INDEX IF NOT EXISTS ai_usage_daily_by_user_org_date_idx
  ON public.ai_usage_daily_by_user (org_id, date DESC);
ALTER TABLE public.ai_usage_daily_by_user ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.ai_request_log IS
  'Every Claude API call lands here with token counts + cost. Source of truth for billing / audit / cost analysis.';
COMMENT ON TABLE public.ai_booster_purchases IS
  'Per-org AI Booster add-on purchases. Active rows add extra_queries_per_day to the plan cap for the period.';
