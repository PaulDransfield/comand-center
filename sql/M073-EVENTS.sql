-- M073 — events table
--
-- Phase C of the Nordic Plan: local events ingestion. Restaurants near
-- a Tele2 Arena concert see 30-50 % lifts; conferences at Stockholm
-- City Conference Centre lift mid-week lunch demand. Published research
-- (PredictHQ × food-delivery, Lineup.ai × event intelligence) shows
-- 5-6 pp MAPE improvement when this signal is wired into a forecaster.
--
-- This is a GLOBAL fact table — events exist regardless of which
-- business cares. Per-business calibration of impact curves (leading +
-- lagging window per category, geographic proximity weight) will live
-- in a separate `business_event_impact` table once we have data to
-- calibrate on.
--
-- Sources (added over time):
--   v1: ticketmaster — Stockholm + nearby venues via Discovery API (free)
--   v2: stockholm_stad — open city data portal
--   v3: biljett — major Swedish ticketing scraper (fragile)
--   v4: eventim — commercial API if needed for coverage
--
-- Idempotent. Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS public.events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source identity. Must be unique together so re-syncing the same
  -- event upserts in place instead of duplicating.
  source              TEXT NOT NULL,           -- 'ticketmaster' | 'stockholm_stad' | ...
  source_id           TEXT NOT NULL,           -- the source's own identifier

  -- Human content
  name                TEXT,
  description         TEXT,
  category            TEXT,                    -- 'concert' | 'sports' | 'theatre' | 'conference' | 'festival' | 'other'

  -- Time anchor — UTC timestamps so we don't drift across DST
  start_at            TIMESTAMPTZ NOT NULL,
  end_at              TIMESTAMPTZ,             -- nullable (single-night events have no explicit end)

  -- Venue
  venue_name          TEXT,
  venue_city          TEXT,
  venue_country       TEXT,
  venue_lat           NUMERIC(9, 6),           -- WGS84 lat
  venue_lng           NUMERIC(9, 6),           -- WGS84 lng

  -- Demand signal
  expected_attendance INTEGER,                 -- often null; populated when source exposes
  venue_capacity      INTEGER,                 -- nullable; useful when attendance not known

  -- Pointer back to the source
  url                 TEXT,
  raw                 JSONB,                   -- raw API payload for future re-classification

  -- Metadata
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT events_unique_source UNIQUE (source, source_id)
);

-- Hot lookup: events in a date window (forecaster + admin views).
CREATE INDEX IF NOT EXISTS idx_events_start_at
  ON public.events (start_at)
  WHERE start_at >= '2026-01-01';   -- partial index keeps it small even after years of accumulation

-- Lookup by venue proximity (forecaster filters by lat/lng box).
CREATE INDEX IF NOT EXISTS idx_events_venue_geo
  ON public.events (venue_city, venue_lat, venue_lng)
  WHERE venue_lat IS NOT NULL;

-- Category filter — useful when forecaster restricts to high-impact categories.
CREATE INDEX IF NOT EXISTS idx_events_category
  ON public.events (category, start_at);

-- ── updated_at trigger ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.events_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS events_touch_updated_at ON public.events;
CREATE TRIGGER events_touch_updated_at
  BEFORE UPDATE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.events_touch_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────
-- Events are global facts. Read-allow to any authenticated user (so the
-- forecaster can pull them via authenticated client OR service-role).
-- No write policy; only service role writes (via the cron job).
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS events_read ON public.events;
CREATE POLICY events_read ON public.events
  FOR SELECT
  USING (true);   -- public read — events are not customer data

-- ── Verification ─────────────────────────────────────────────────────
SELECT COUNT(*) AS events_rows FROM public.events;
SELECT source, COUNT(*) FROM public.events GROUP BY source;
