-- M104 — review_insights cache
--
-- Caches the LLM-synthesised "what to improve / what customers love" cards
-- for the /reviews page so we don't re-bill an AI call on every page load.
-- One row per (business_id, window_days); refreshed when older than 24h or
-- on an explicit force-refresh.
--
-- Derived purely from review_themes (LLM-derived, persistent — NOT from raw
-- Google review text), so it's safe past the 30-day raw-text prune.
--
-- Apply in the Supabase SQL editor. The endpoint is defensive: until this
-- runs it just computes fresh each load (no caching), so applying it is a
-- cost optimisation, not a hard dependency.

CREATE TABLE IF NOT EXISTS public.review_insights (
  business_id   uuid        NOT NULL,
  window_days   integer     NOT NULL,
  improvements  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  satisfactions jsonb       NOT NULL DEFAULT '[]'::jsonb,
  sample_size   integer     NOT NULL DEFAULT 0,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, window_days)
);

-- RLS: service-role (admin client) writes/reads; the endpoint already gates
-- access via canAccessBusiness, so a permissive policy mirrors how the other
-- review tables are served through the admin client.
ALTER TABLE public.review_insights ENABLE ROW LEVEL SECURITY;
