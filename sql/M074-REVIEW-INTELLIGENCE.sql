-- M074-REVIEW-INTELLIGENCE.sql
--
-- Adds review-ingestion plumbing so we can surface Google Maps review
-- themes per business — "review intelligence" feature.
--
-- Three pieces:
--   1. businesses.google_place_id — owner-confirmed Google Maps Place ID.
--      One per business; nullable; set via the integrations page.
--   2. review_raw — verbatim review text. Google Places TOS forbids
--      caching review text >30 days, so a daily prune job deletes rows
--      older than 30 days. We keep them this long to allow re-runs of
--      the classifier when the prompt changes.
--   3. review_themes — LLM-derived structured themes + sentiment per
--      review. Persistent (no TOS issue — derived data, not original
--      text). Indexed for rolling-window aggregation per business.
--
-- Theme shape (JSONB):
--   {
--     "food":       {"polarity":"+","confidence":0.9,"phrase":"pasta was excellent"},
--     "service":    {"polarity":"-","confidence":0.7,"phrase":"drinks took 20 min"},
--     "atmosphere": {"polarity":"+","confidence":0.6,"phrase":"cosy room"}
--   }
-- Categories: food, service, atmosphere, value, wait, cleanliness,
-- noise, booking, staff. Anything outside falls into the "other" bucket.
--
-- Dedup key: (business_id, source, external_id). Google's review.name
-- is the external_id; stable across fetches.

-- ── businesses.google_place_id ──────────────────────────────────────
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS google_place_id TEXT;

COMMENT ON COLUMN businesses.google_place_id IS
  'Google Maps Place ID for review fetching. Set via integrations UI. Nullable; review-sync cron skips businesses without one.';

-- ── review_raw ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS review_raw (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source        TEXT NOT NULL DEFAULT 'google_places',
  external_id   TEXT NOT NULL,
  author_name   TEXT,
  rating        INT,
  text          TEXT,
  language      TEXT,
  published_at  TIMESTAMPTZ,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT review_raw_dedup UNIQUE (business_id, source, external_id),
  CONSTRAINT review_raw_rating_range CHECK (rating IS NULL OR rating BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS review_raw_business_published_idx
  ON review_raw (business_id, published_at DESC);

CREATE INDEX IF NOT EXISTS review_raw_fetched_idx
  ON review_raw (fetched_at);

COMMENT ON TABLE review_raw IS
  'Verbatim Google Maps reviews. 30-day TTL — pruned daily to comply with Google Places TOS. Use review_themes for persistent analysis.';

-- ── review_themes ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS review_themes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL,
  business_id       UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source            TEXT NOT NULL DEFAULT 'google_places',
  external_id       TEXT NOT NULL,
  rating            INT,
  published_at      TIMESTAMPTZ NOT NULL,
  themes            JSONB NOT NULL DEFAULT '{}'::jsonb,
  sentiment         NUMERIC(4,3),
  key_phrase        TEXT,
  language          TEXT,
  llm_model         TEXT,
  llm_processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT review_themes_dedup UNIQUE (business_id, source, external_id),
  CONSTRAINT review_themes_rating_range  CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  CONSTRAINT review_themes_sentiment_range CHECK (sentiment IS NULL OR (sentiment >= -1 AND sentiment <= 1))
);

CREATE INDEX IF NOT EXISTS review_themes_business_published_idx
  ON review_themes (business_id, published_at DESC);

-- GIN on the JSONB column so rolling theme-count queries stay fast.
CREATE INDEX IF NOT EXISTS review_themes_themes_gin
  ON review_themes USING gin (themes);

COMMENT ON TABLE review_themes IS
  'LLM-derived theme classifications per review. Persistent. JSONB themes column has one key per category (food/service/atmosphere/value/wait/cleanliness/noise/booking/staff) when mentioned, each with polarity (+/-/~), confidence (0-1), and phrase (one-sentence pull quote).';
